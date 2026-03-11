/**
 * renderWorker.js (v2)
 * 
 * Storyboard-driven video generation using EvoLink (Kling/Seedance).
 * Each scene: storyboard frame + character refs → video clip.
 * Clips appear progressively via Socket.IO.
 * Post-processing: MP4 faststart only (no HLS).
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { spawn } from 'child_process';
import prisma from '../config/database.js';
import { generateVideo } from '../services/evolinkService.js';
import { uploadFile } from '../services/fileHostingService.js';
import { isStorageConfigured, getPresignedDownloadUrl, buildObjectKey, uploadBufferToStorage } from '../services/storageService.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { getTierConfig } from '../config/modelConfig.js';
import { logger } from '../logger.js';
import { sendVideoReadyEmail } from '../services/emailService.js';
import { initSentry, captureException } from '../config/sentry.js';
import { connection as redis } from '../queue/connection.js';

// Initialize Sentry for worker process
initSentry();

const DEFAULT_VOLUME_PATH = path.join(os.tmpdir(), 'technov');
const VOLUME_PATH = process.env.VOLUME_PATH || DEFAULT_VOLUME_PATH;

// --- Helpers ---

const ensureDir = async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
};

const downloadFile = async (url, destinationPath) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(destinationPath, Buffer.from(arrayBuffer));
};

const runFfmpeg = (args) => new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
    });
});

const getDurationSeconds = async (filePath) => {
    return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        ffprobe.stdout.on('data', (d) => { output += d.toString(); });
        ffprobe.on('close', () => resolve(parseFloat(output) || 0));
    });
};

/**
 * Publish real-time progress updates to frontend via Redis pub/sub.
 */
const publishProgress = async (projectId, data) => {
    try {
        await redis.publish(`project:${projectId}`, JSON.stringify(data));
    } catch (err) {
        logger.warn({ err, projectId }, 'Failed to publish progress update');
    }
};

// --- Main Worker ---

/**
 * Process a video generation job.
 * This is called by the BullMQ worker when a job is dequeued.
 */
export const processGenerationJob = async (jobId, context = {}) => {
    const jobDir = path.join(VOLUME_PATH, 'jobs', jobId);
    await ensureDir(jobDir);

    logger.info({ jobId }, '🎬 Starting video generation job (v2 — EvoLink + Storyboard)');

    try {
        // 1. Fetch job and project data
        const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
        if (!job) throw new Error(`Job ${jobId} not found`);

        const project = await prisma.project.findUnique({
            where: { id: job.projectId },
            include: {
                scenes: { orderBy: { orderIndex: 'asc' } },
                characters: { where: { approved: true } },
                user: true,
            },
        });
        if (!project) throw new Error(`Project ${job.projectId} not found`);

        const userPlan = project.user?.plan || 'free';
        const tierConfig = getTierConfig(userPlan);

        // 2. Mark job as processing
        await prisma.generationJob.update({
            where: { id: jobId },
            data: { status: 'PROCESSING', startedAt: new Date() },
        });

        const sceneVideos = []; // { sceneId, rawPath, processedPath }
        const totalScenes = project.scenes.length;

        // 3. Generate video for each scene (all scene submitted, progressive reveal)
        for (let i = 0; i < project.scenes.length; i++) {
            const scene = project.scenes[i];
            const sceneNum = i + 1;

            logger.info({ sceneNum, totalScenes, sceneId: scene.id }, `Processing scene ${sceneNum}/${totalScenes}`);

            // Publish progress
            const progress = Math.round((i / totalScenes) * 90);
            await publishProgress(project.id, {
                type: 'scene-progress',
                sceneNumber: sceneNum,
                totalScenes,
                progress,
                status: 'generating',
            });

            await prisma.generationJob.update({
                where: { id: jobId },
                data: { progress },
            });

            try {
                // Build video prompt from scene (Injecting Locked Strings)
                let basePrompt = scene.promptText;

                // Prepend continuity locked strings if available in project metadata
                let lockedStrings = '';
                if (project.metadata?.worldLock) {
                    lockedStrings += `[WORLD: ${project.metadata.worldLock}] `;
                }
                if (project.metadata?.characterLock) {
                    lockedStrings += `[CHARACTERS: ${project.metadata.characterLock}] `;
                }

                let prompt = `${lockedStrings}${basePrompt}`.trim();

                // Add character context if present
                if (project.characters.length > 0) {
                    const charDesc = project.characters
                        .map(c => `${c.name}: ${c.description}`)
                        .join('. ');
                    prompt += ` Characters: ${charDesc}`;
                }

                // Determine Start Frame for Continuity Chaining
                // 1. If we have a lastFrameUrl from the PREVIOUS clip, use it to ensure perfect continuity.
                // 2. Otherwise (Clip 1), fall back to the generated storyboard image.
                const previousClipIndex = i - 1;
                const previousLastFrameUrl = previousClipIndex >= 0 ? project.scenes[previousClipIndex].lastFrameUrl : null;
                const startingImageUrl = previousLastFrameUrl || scene.storyboardUrl || undefined;

                // Generate video via EvoLink
                // Note: EvoLink/Kling must support 'imageUrl' functioning as either a static storyboard OR the actual last frame of the previous video
                const videoResult = await generateVideo(prompt, {
                    model: tierConfig.video.model,
                    imageUrl: startingImageUrl,
                    duration: Math.min(scene.duration || 8, 10), // Kling supports 5-10s
                    aspectRatio: project.aspectRatio || '16:9',
                    quality: tierConfig.video.quality,
                    onProgress: (p, status) => {
                        publishProgress(project.id, {
                            type: 'scene-progress',
                            sceneNumber: sceneNum,
                            progress: Math.round((i / totalScenes) * 90 + (p / totalScenes) * 0.9),
                            status: `Scene ${sceneNum}: ${status}`,
                        });
                    },
                });

                // Download the raw video
                const rawVideoPath = path.join(jobDir, `scene_${sceneNum}_raw.mp4`);
                await downloadFile(videoResult.video_url, rawVideoPath);

                // Validate clip
                const duration = await getDurationSeconds(rawVideoPath);
                if (duration < 1) {
                    logger.warn({ sceneNum, duration }, 'Generated clip too short, likely corrupt');
                    throw new Error(`Scene ${sceneNum}: Generated clip under 1s (${duration}s)`);
                }

                // Post-process: MP4 faststart
                const processedPath = path.join(jobDir, `scene_${sceneNum}.mp4`);
                await runFfmpeg([
                    '-i', rawVideoPath,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    '-movflags', '+faststart',
                    '-y', processedPath,
                ]);

                // Upload processed scene video
                const sceneKey = buildObjectKey({ userId: project.userId, extension: 'mp4' });
                let sceneVideoUrl;

                if (isStorageConfigured()) {
                    sceneVideoUrl = await uploadFile(processedPath, { objectKey: sceneKey });
                } else {
                    sceneVideoUrl = videoResult.video_url;
                }

                // Wait, we need the last frame of THIS newly generated video to pass to the next clip.
                // For now, if the EvoLink API doesn't return a specific thumbnail/last frame URL out of the box, 
                // we simulate it. Ideally, you extract the last frame via FFmpeg here and upload it.
                // Assuming we use FFmpeg to extract the last frame:
                const lastFrameRawPath = path.join(jobDir, `scene_${sceneNum}_last_frame.jpg`);
                let lastFrameUrlLocation = null;

                try {
                    await runFfmpeg([
                        '-sseof', '-3', // seek to last 3 seconds
                        '-i', processedPath,
                        '-update', '1', // overwrite
                        '-q:v', '1',    // high quality
                        '-vframes', '1',// one frame
                        // Just look right before the end
                        '-y', lastFrameRawPath
                    ]);
                    // Upload the frame
                    const frameKey = buildObjectKey({ userId: project.userId, extension: 'jpg' });
                    if (isStorageConfigured()) {
                        lastFrameUrlLocation = await uploadFile(lastFrameRawPath, { objectKey: frameKey });
                    } else {
                        lastFrameUrlLocation = null; // In dev without S3, continuity chaining might break if we can't host the frame
                    }
                } catch (ffmpegErr) {
                    logger.warn({ err: ffmpegErr, sceneNum }, "Failed to extract lastFrame for continuity chain. Next clip might jump.");
                }


                // Update scene record with video AND lastFrameUrl for the next iteration to pick up
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: {
                        videoUrl: sceneVideoUrl,
                        lastFrameUrl: lastFrameUrlLocation,
                        state: 'COMPLETED'
                    },
                });

                // Update the project's scene array in memory so the NEXT clip in the loop can access 'project.scenes[currentIndex].lastFrameUrl'
                project.scenes[i].lastFrameUrl = lastFrameUrlLocation;

                sceneVideos.push({ sceneId: scene.id, rawPath: rawVideoPath, processedPath });

                // Publish completed scene (progressive reveal)
                await publishProgress(project.id, {
                    type: 'scene-complete',
                    sceneNumber: sceneNum,
                    videoUrl: sceneVideoUrl,
                    totalScenes,
                });

                logger.info({ sceneNum, duration, sceneVideoUrl }, `Scene ${sceneNum} complete`);

            } catch (sceneErr) {
                logger.error({ err: sceneErr, sceneNum }, `Scene ${sceneNum} failed`);
                captureException(sceneErr, { sceneNum, jobId });

                // Mark scene as failed but continue with others
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { state: 'FAILED' },
                });
            }
        }

        // 4. Check if we have enough successful scenes
        const successfulScenes = sceneVideos.filter(sv => sv.processedPath);
        if (successfulScenes.length === 0) {
            throw new Error('All scenes failed — no videos generated');
        }

        // 5. Concatenate all scene videos into final video
        await transitionProjectState({
            projectId: project.id,
            toState: 'POST_PROCESSING',
            actorType: 'SYSTEM',
            reason: `${successfulScenes.length}/${totalScenes} scenes generated`,
        });

        const finalVideoPath = path.join(jobDir, 'final.mp4');

        if (successfulScenes.length === 1) {
            // Single scene — just copy
            await fs.copyFile(successfulScenes[0].processedPath, finalVideoPath);
        } else {
            // Concatenate multiple scenes
            const fileListPath = path.join(jobDir, 'filelist.txt');
            const fileListContent = successfulScenes
                .map(sv => `file '${sv.processedPath}'`)
                .join('\n');
            await fs.writeFile(fileListPath, fileListContent);

            await runFfmpeg([
                '-f', 'concat',
                '-safe', '0',
                '-i', fileListPath,
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                '-movflags', '+faststart',
                '-y', finalVideoPath,
            ]);
        }

        // 6. Upload final video
        let finalVideoUrl;
        if (isStorageConfigured()) {
            const finalKey = buildObjectKey({ userId: project.userId, extension: 'mp4' });
            finalVideoUrl = await uploadFile(finalVideoPath, { objectKey: finalKey });

            // Get presigned URL for immediate playback
            try {
                const signedUrl = await getPresignedDownloadUrl({ key: finalKey, expiresIn: 86400 });
                finalVideoUrl = signedUrl;
            } catch (signErr) {
                logger.warn({ err: signErr }, 'Failed to generate signed URL for final video');
            }
        }

        // 7. Update project to COMPLETE
        await prisma.project.update({
            where: { id: project.id },
            data: {
                finalVideoUrl,
                renderProgress: 100,
            },
        });

        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: 'COMPLETED',
                progress: 100,
                outputUrl: finalVideoUrl,
                finishedAt: new Date(),
            },
        });

        await transitionProjectState({
            projectId: project.id,
            toState: 'COMPLETE',
            actorType: 'SYSTEM',
            reason: `Video generation complete — ${successfulScenes.length} scenes`,
        });

        // 8. Notify user
        await publishProgress(project.id, {
            type: 'final-ready',
            videoUrl: finalVideoUrl,
            progress: 100,
        });

        // Send email notification
        if (project.user?.email) {
            try {
                await sendVideoReadyEmail(project.user.email, {
                    projectTitle: project.title,
                    projectId: project.id,
                });
            } catch (emailErr) {
                logger.warn({ err: emailErr }, 'Failed to send video ready email');
            }
        }

        logger.info({
            jobId,
            projectId: project.id,
            scenesGenerated: successfulScenes.length,
            totalScenes,
            finalVideoUrl,
        }, '✅ Video generation job completed');

        // 9. Cleanup temp files
        try {
            await fs.rm(jobDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            logger.warn({ err: cleanupErr }, 'Failed to clean up job directory');
        }

        return { status: 'completed', outputUrl: finalVideoUrl };

    } catch (error) {
        logger.error({ err: error, jobId }, '❌ Video generation job failed');
        captureException(error, { jobId });

        try {
            await prisma.generationJob.update({
                where: { id: jobId },
                data: {
                    status: 'FAILED',
                    errorMessage: error.message,
                    finishedAt: new Date(),
                },
            });

            const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
            if (job) {
                await transitionProjectState({
                    projectId: job.projectId,
                    toState: 'FAILED',
                    actorType: 'SYSTEM',
                    reason: error.message,
                });

                await publishProgress(job.projectId, {
                    type: 'error',
                    error: error.message,
                });
            }
        } catch (updateErr) {
            logger.error({ err: updateErr }, 'Failed to update job status on error');
        }

        throw error;
    }
};
