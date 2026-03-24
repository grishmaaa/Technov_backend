/**
 * renderWorker.js (v2)
 * 
 * Storyboard-driven video generation using EvoLink (Kling/Seedance).
 * Ingredients-driven video generation using EvoLink (Kling/Seedance).
 * Each scene: ingredients frame + character refs → video clip.
 * Clips appear progressively via Socket.IO.
 * Post-processing: MP4 faststart only (no HLS).
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { spawn } from 'child_process';
import prisma from '../config/database.js';
import { generateVideo, createCharacterElement } from '../services/evolinkService.js';
import { uploadFile } from '../services/fileHostingService.js';
import { isStorageConfigured, getPresignedDownloadUrl, buildObjectKey, uploadBufferToStorage } from '../services/storageService.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { getTierConfig } from '../config/modelConfig.js';
import { logger } from '../logger.js';
import { sendVideoReadyEmail } from '../services/emailService.js';
import { initSentry, captureException } from '../config/sentry.js';
import { connection as redis } from '../queue/connection.js';
import { generateVisualPrompt } from '../services/llmService.js';

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
const publishProgress = async (projectId, userId, data) => {
    try {
        await redis.publish('job-updates', JSON.stringify({
            userId,
            type: `project:${projectId}`,
            payload: data
        }));
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

    let project = null;
    try {
        // 1. Fetch job and project data
        const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
        if (!job) throw new Error(`Job ${jobId} not found`);

        project = await prisma.project.findUnique({
            where: { id: job.projectId },
            include: {
                scenes: { orderBy: { orderIndex: 'asc' } },
                characters: { where: { approved: true } },
                assets: { where: { state: { in: ['READY', 'GENERATED', 'APPROVED'] } } },
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

        // 3. Ensure all characters have Kling Custom Element IDs for consistency (Only for Kling models)
        const isKling = tierConfig.video.model.toLowerCase().includes('kling');
        const elementList = [];

        if (isKling) {
            for (const char of project.characters) {
                // 🛑 KILL SWITCH CHECK
                const freshProj = await prisma.project.findUnique({ where: { id: project.id }, select: { state: true } });
                if (freshProj?.state === 'CANCELLED' || freshProj?.state === 'FAILED') {
                    logger.warn({ charName: char.name }, 'Aborting character element creation: project is offline');
                    throw new Error('Project generation aborted');
                }

                if (!char.elementId && char.portraitUrl) {
                    try {
                        // Extract all approved character reference images for this specific character
                        const charRefs = project.assets
                            .filter(a => {
                                try {
                                    const meta = JSON.parse(a.metadata || '{}');
                                    return a.type === 'CHARACTER' && meta.characterId === char.id && a.url;
                                } catch (e) {
                                    return false;
                                }
                            })
                            .map(a => a.url)
                            .filter(url => url !== char.portraitUrl); // Don't repeat the frontal image as a reference

                        logger.info({ charName: char.name, refCount: charRefs.length }, 'Creating missing Kling Custom Element for character (Mandatory Refs)');
                        
                        // 1. Generate optimized prompt via LLM
                        const visualPrompt = await generateVisualPrompt(
                            'CHARACTER_PORTRAIT', 
                            char, 
                            'Cinematic', // Style
                            'kling-custom-element'
                        );

                        // 2. CHECK: If the AI decided to "IGNORE" the character, skip element creation
                        if (visualPrompt.trim().toUpperCase() === 'IGNORE') {
                            logger.info({ charId: char.id }, 'Skipping character element creation (Faceless/Background)');
                            continue; // Skip this character
                        }

                        const { elementId } = await createCharacterElement(
                            char.name,
                            visualPrompt,
                            char.portraitUrl,
                            charRefs // PASSING THE REFERENCE IMAGES HERE
                        );
                        await prisma.character.update({
                            where: { id: char.id },
                            data: { elementId }
                        });
                        elementList.push(elementId);
                    } catch (err) {
                        logger.error({ err: err.message, charName: char.name }, 'Failed to create character element — falling back to text-only prompts');
                        // Fallback: we just continue without the elementId, less consistency but job won't crash
                    }
                } else if (char.elementId) {
                    elementList.push(char.elementId);
                }
            }
        } else {
            logger.info({ model: tierConfig.video.model }, 'Skipping custom elements (Not a Kling model)');
        }

        // 4. Collect World Ingredients (Reference Images)
        const referenceImages = project.assets
            .filter(a => a.url)
            .map((a, index) => ({
                url: a.url,
                label: `Image${index + 1}` // For @Image1, @Image2 style referencing
            }));

        const totalScenes = project.scenes.length;
        const sceneVideos = [];

        // 5. Generate video for each scene
        for (let i = 0; i < project.scenes.length; i++) {
            const scene = project.scenes[i];
            const sceneNum = scene.orderIndex !== undefined ? scene.orderIndex + 1 : i + 1;

            // 🛑 KILL SWITCH: Check if project was cancelled/failed mid-job to save credits
            const freshProject = await prisma.project.findUnique({ 
                where: { id: project.id }, 
                select: { state: true } 
            });
            if (freshProject?.state === 'CANCELLED' || freshProject?.state === 'FAILED') {
                logger.warn({ projectId: project.id, sceneNum }, '🛑 Generation aborted: project state is now offline');
                throw new Error('Project generation aborted by user/system');
            }

            logger.info({ sceneNum, totalScenes, sceneId: scene.id }, `Processing scene ${sceneNum}/${totalScenes}`);

            // Publish progress
            const progress = Math.round((i / totalScenes) * 90);
            await publishProgress(project.id, project.userId, {
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

            const processedPath = path.join(jobDir, `scene_${sceneNum}.mp4`);

            // SMART RESUME: Skip scene if it already has a videoUrl (saves credits on retries)
            if (scene.videoUrl && scene.state === 'COMPLETED') {
                try {
                    logger.info({ sceneNum, sceneId: scene.id }, '⏭️ Smart Resume: Skipping already completed scene');
                    await downloadFile(scene.videoUrl, processedPath);
                    sceneVideos.push({ sceneId: scene.id, processedPath, videoUrl: scene.videoUrl });
                    continue;
                } catch (dlErr) {
                    logger.warn({ dlErr: dlErr.message, sceneNum }, 'Failed to download existing scene video, re-generating from Ingredient');
                    // Fall back to generation if download fails
                }
            }

            try {
                // 1. Generate optimized visual prompt via LLM
                const visualStyle = project.metadata?.visual_style || 'Cinematic';
                const visualPrompt = await generateVisualPrompt(
                    'SCENE', 
                    scene, 
                    visualStyle,
                    tierConfig.video.model
                );

                // Prepend continuity locked strings
                let lockedStrings = '';
                if (project.metadata?.worldLock) {
                    lockedStrings += `[WORLD: ${project.metadata.worldLock}] `;
                }
                if (project.metadata?.characterLock) {
                    lockedStrings += `[CHARACTERS: ${project.metadata.characterLock}] `;
                }

                let prompt = `${lockedStrings}${visualPrompt}`.trim();

                // Add character/prop mapping context to prompt for Kling's @Image/@Element system
                if (referenceImages.length > 0) {
                    const refs = referenceImages.map(r => `@${r.label}`).join(', ');
                    prompt += ` Use references: ${refs}`;
                }

                // Determine Start Frame for Continuity Chaining
                // 1. If we have a lastFrameUrl from the PREVIOUS clip, use it to ensure perfect continuity.
                // 2. Otherwise (Clip 1), fall back to the generated Ingredient reference image.
                const previousClipIndex = i - 1;
                const previousLastFrameUrl = previousClipIndex >= 0 ? project.scenes[previousClipIndex].lastFrameUrl : null;
                const startingImageUrl = previousLastFrameUrl || scene.storyboardUrl || undefined;

                // Generate video via EvoLink
                const videoResult = await generateVideo(prompt, {
                    sceneId: scene.id,
                    model: tierConfig.video.model,
                    imageUrl: startingImageUrl,
                    elementList: elementList, // Kling character consistency
                    referenceImages: referenceImages, // World ingredients
                    duration: Math.min(scene.duration || 8, 10),
                    aspectRatio: project.aspectRatio || '16:9',
                    quality: tierConfig.video.quality,
                    onProgress: (p, status) => {
                        publishProgress(project.id, project.userId, {
                            type: 'scene-progress',
                            sceneNumber: sceneNum,
                            progress: Math.round((i / totalScenes) * 90 + (p / totalScenes) * 0.9 + 5),
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
                    try {
                        sceneVideoUrl = await uploadFile(processedPath, { objectKey: sceneKey });
                    } catch (uploadErr) {
                        logger.warn({ err: uploadErr.message, sceneNum }, 'Cloud storage upload failed — using raw EvoLink URL instead');
                        sceneVideoUrl = videoResult.video_url;
                    }
                } else {
                    logger.warn({ sceneNum }, 'Cloud storage NOT configured. Video URL will expire in 24 hours!');
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
                        try {
                            lastFrameUrlLocation = await uploadFile(lastFrameRawPath, { objectKey: frameKey });
                        } catch (uploadErr) {
                            logger.warn({ err: uploadErr.message, sceneNum }, "Cloud storage upload failed for lastFrame. Next clip might jump.");
                            lastFrameUrlLocation = null;
                        }
                    } else {
                        lastFrameUrlLocation = null; // In dev without S3, continuity chaining might break if we can't host the frame
                    }
                } catch (ffmpegErr) {
                    logger.warn({ err: ffmpegErr, sceneNum }, "Failed to extract lastFrame for continuity chain. Next clip might jump.");
                }


                // Update scene record with video AND lastFrameUrl for the next iteration to pick up
                // Update scene in DB
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { videoUrl: sceneVideoUrl, state: 'COMPLETED', lastFrameUrl: lastFrameUrlLocation },
                });

                // Update the project's scene array in memory so the NEXT clip in the loop can access 'project.scenes[currentIndex].lastFrameUrl'
                project.scenes[i].lastFrameUrl = lastFrameUrlLocation;

                sceneVideos.push({ sceneId: scene.id, rawPath: rawVideoPath, processedPath });

                // Notify frontend
                await publishProgress(project.id, project.userId, {
                    type: 'scene-complete',
                    sceneId: scene.id,
                    sceneNumber: sceneNum,
                    videoUrl: sceneVideoUrl,
                });

                logger.info({ sceneNum, duration, sceneVideoUrl }, `Scene ${sceneNum} complete`);

            } catch (sceneErr) {
                logger.error({ err: sceneErr, sceneNum }, `Scene ${sceneNum} failed`);
                captureException(sceneErr, { sceneNum, jobId });

                // Mark scene as failed
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { state: 'FAILED' },
                });

                // CRITICAL: If the error is permanent (e.g. invalid params, terminal API failure), 
                // ABORT the whole job immediately to stop burning credits.
                if (sceneErr.isPermanent) {
                    throw sceneErr;
                }
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
            try {
                const finalKey = buildObjectKey({ userId: project.userId, extension: 'mp4' });
                finalVideoUrl = await uploadFile(finalVideoPath, { objectKey: finalKey });

                // Get presigned URL for immediate playback
                try {
                    const signedUrl = await getPresignedDownloadUrl({ key: finalKey, expiresIn: 86400 });
                    finalVideoUrl = signedUrl;
                } catch (signErr) {
                    logger.warn({ err: signErr }, 'Failed to generate signed URL for final video');
                }
            } catch (finalUploadErr) {
                logger.warn({ err: finalUploadErr.message }, 'Final video upload failed — using local path reference or last successful scene URL');
                // Fallback: If we can't upload the final concatenated video, 
                // we use the last successful scenes as a fallback if possible, 
                // but usually the job will have successfulScenes[0].processedPath
                finalVideoUrl = successfulScenes[successfulScenes.length - 1].videoUrl;
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
        await publishProgress(project.id, project.userId, {
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
        if (project) {
            logger.error({ err: error, projectId: project.id, jobId }, '❌ Video generation job failed');
        } else {
            logger.error({ err: error, jobId }, '❌ Video generation job failed (could not load project)');
        }
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

            const job = await prisma.generationJob.findUnique({ 
                where: { id: jobId },
                include: { project: true },
            });
            
            if (job && job.project) {
                await transitionProjectState({
                    projectId: job.projectId,
                    toState: 'FAILED',
                    actorType: 'SYSTEM',
                    reason: error.message,
                });

                await publishProgress(job.projectId, job.project.userId, {
                    type: 'error',
                    error: error.message,
                });
            }
        } catch (updateErr) {
            logger.error({ err: updateErr }, 'Failed to update job status on error');
        }

        if (error.isPermanent) {
            logger.warn({ jobId }, 'Skipping retries for permanent error');
            return { status: 'failed', permanent: true };
        }

        throw error;
    }
};
