import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { spawn } from 'child_process';
import prisma from '../config/database.js';
import { generateVideo } from '../services/geminiService.js';
import { uploadFile } from '../services/fileHostingService.js';
import { compileShotPrompt } from '../services/promptCompiler.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { logger } from '../logger.js';

const DEFAULT_VOLUME_PATH = path.join(os.tmpdir(), 'technov');
const VOLUME_PATH = process.env.VOLUME_PATH || DEFAULT_VOLUME_PATH;
const TMP_DIR = path.join(VOLUME_PATH, 'tmp');
const FALLBACK_SHOT_DURATION_SECONDS = Number(process.env.DEFAULT_SCENE_DURATION || 8);
const DEFAULT_ASPECT_RATIO = process.env.DEFAULT_ASPECT_RATIO || '16:9';
const DEFAULT_FPS = Number(process.env.DEFAULT_FPS || 24);

const QUALITY_PRESETS = {
    basic: { postProcess: true },
    cinematic: { postProcess: true }
};

const getQualitySettings = (project) => {
    const tier = (project?.qualityTier || 'cinematic').toLowerCase();
    return QUALITY_PRESETS[tier] || QUALITY_PRESETS.cinematic;
};

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
        if (code === 0) {
            resolve();
        } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
        }
    });
});

const runFfprobe = (args) => new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    ffprobe.stdout.on('data', (data) => { output += data.toString(); });
    ffprobe.stderr.on('data', (data) => { errorOutput += data.toString(); });
    ffprobe.on('error', reject);
    ffprobe.on('close', (code) => {
        if (code === 0) {
            resolve(output);
        } else {
            reject(new Error(`ffprobe exited with code ${code}: ${errorOutput}`));
        }
    });
});

const getDurationSeconds = async (filePath) => {
    try {
        const output = await runFfprobe([
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'json',
            filePath
        ]);
        const parsed = JSON.parse(output);
        const duration = Number(parsed?.format?.duration);
        return Number.isFinite(duration) ? duration : null;
    } catch (error) {
        logger.warn({ err: error }, 'ffprobe failed');
        return null;
    }
};

const postProcessClip = async ({ inputPath, outputPath, fps, enabled, targetDurationSeconds }) => {
    const trimDuration = Number(targetDurationSeconds);
    const shouldTrim = Number.isFinite(trimDuration) && trimDuration > 0;

    if (!enabled && !shouldTrim) {
        await fs.copyFile(inputPath, outputPath);
        return outputPath;
    }

    const lutPath = process.env.LUT_PATH;
    const filters = [
        `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
        'scale=iw*1.5:ih*1.5:flags=lanczos',
        lutPath ? `lut3d=${lutPath}` : null,
        'noise=alls=8:allf=t+u',
        'format=yuv420p'
    ].filter(Boolean).join(',');

    const args = ['-y', '-i', inputPath];
    if (shouldTrim) {
        args.push('-t', String(trimDuration));
    }
    if (enabled) {
        args.push('-vf', filters, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18');
    } else {
        args.push('-c', 'copy');
    }
    args.push(outputPath);
    await runFfmpeg(args);
    return outputPath;
};

const validateClip = async ({ filePath, targetDurationSeconds }) => {
    const duration = await getDurationSeconds(filePath);
    if (!Number.isFinite(duration)) {
        throw new Error('Validation failed: duration unavailable');
    }
    const target = Number(targetDurationSeconds);
    if (Number.isFinite(target) && Math.abs(duration - target) > 0.75) {
        throw new Error(`Validation failed: duration ${duration.toFixed(2)}s != ${target}s`);
    }
};

const getLatestShotAsset = async (shotId) => {
    return await prisma.asset.findFirst({
        where: { shotId, state: 'READY' },
        orderBy: { createdAt: 'desc' }
    });
};

const recordApiCall = async ({ jobId, projectId, costUsd }) => {
    const cost = Number(costUsd || 0);
    await prisma.generationJob.update({
        where: { id: jobId },
        data: {
            apiCallCount: { increment: 1 },
            apiCost: { increment: cost }
        }
    });
    await prisma.project.update({
        where: { id: projectId },
        data: {
            apiCallCount: { increment: 1 },
            totalApiCost: { increment: cost }
        }
    });
};

const generateShotVideo = async ({ shot, project, options, jobDir, jobId }) => {
    const rawPath = path.join(jobDir, `shot-${shot.id}-raw.mp4`);
    const processedPath = path.join(jobDir, `shot-${shot.id}-processed.mp4`);

    await prisma.shot.update({
        where: { id: shot.id },
        data: { state: 'PROCESSING' }
    });

    try {
        const apiCostUsd = Number(process.env.COST_PER_SHOT_USD || 0);
        await recordApiCall({ jobId, projectId: project.id, costUsd: apiCostUsd });

        const { video_url: videoUrl } = await generateVideo(shot.prompt, '', options);
        if (!videoUrl) {
            throw new Error('Video generation response missing video URL');
        }

        await downloadFile(videoUrl, rawPath);
        await postProcessClip({
            inputPath: rawPath,
            outputPath: processedPath,
            fps: options.fps,
            enabled: options.postProcess,
            targetDurationSeconds: shot.duration
        });
        await validateClip({ filePath: processedPath, targetDurationSeconds: shot.duration });

        const publicUrl = await uploadFile(processedPath);
        const urlString = String(publicUrl || '');
        if (!urlString || urlString === 'undefined' || urlString.includes('Function')) {
            throw new Error(`Invalid URL returned from uploadFile: ${urlString}`);
        }
        logger.info({ url: urlString }, 'Shot video uploaded successfully');

        await prisma.asset.create({
            data: {
                projectId: project.id,
                shotId: shot.id,
                type: 'SHOT_VIDEO',
                state: 'READY',
                url: urlString,
                metadata: JSON.stringify({
                    duration: shot.duration,
                    fps: options.fps,
                    aspectRatio: options.aspectRatio
                })
            }
        });

        await prisma.shot.update({
            where: { id: shot.id },
            data: { state: 'COMPLETED' }
        });

        return { publicUrl, localPath: processedPath };
    } catch (error) {
        await prisma.shot.update({
            where: { id: shot.id },
            data: { state: 'FAILED' }
        });
        throw error;
    }
};

const buildConcatFile = async ({ inputPaths, outputPath }) => {
    const listFilePath = `${outputPath}.txt`;
    const listFileContents = inputPaths.map((filePath) => `file '${filePath}'`).join('\n');
    await fs.writeFile(listFilePath, listFileContents);
    return listFilePath;
};

const concatVideos = async ({ inputPaths, outputPath }) => {
    const listFilePath = await buildConcatFile({ inputPaths, outputPath });
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFilePath, '-c', 'copy', outputPath];
    await runFfmpeg(args);
    return outputPath;
};

const ensureShotsForScene = async ({ scene, project }) => {
    const existingShots = await prisma.shot.findMany({
        where: { sceneId: scene.id },
        orderBy: { orderIndex: 'asc' }
    });

    const desiredDuration = scene.duration || FALLBACK_SHOT_DURATION_SECONDS;
    const singleShotPrompt = compileShotPrompt({
        scene,
        shotIndex: 0,
        shotCount: 1,
        project,
        shotDuration: desiredDuration
    });

    if (existingShots.length > 0) {
        const primaryShot = existingShots[0];

        // Keep only the first shot as the canonical single render
        if (primaryShot.duration !== desiredDuration || primaryShot.prompt !== singleShotPrompt) {
            const updated = await prisma.shot.update({
                where: { id: primaryShot.id },
                data: { duration: desiredDuration, prompt: singleShotPrompt, state: 'PENDING' }
            });
            return [updated];
        }

        return [primaryShot];
    }

    const shot = await prisma.shot.create({
        data: {
            sceneId: scene.id,
            orderIndex: 1,
            duration: desiredDuration,
            prompt: singleShotPrompt,
            state: 'PENDING'
        }
    });

    return [shot];
};

export const processGenerationJob = async (jobId, context = {}) => {
    let jobDir = null;
    const { workerId, attempt } = context;
    try {
        logger.info({ jobId, workerId, attempt }, 'Starting render job');
        await ensureDir(TMP_DIR);

        const job = await prisma.generationJob.findUnique({
            where: { id: jobId },
            include: {
                project: {
                    include: {
                        scenes: { orderBy: { orderIndex: 'asc' } }
                    }
                }
            }
        });

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        const project = job.project;
        const scenes = project.scenes;
        const totalScenes = scenes.length;
        const qualitySettings = getQualitySettings(project);
        const jobLogger = logger.child({ jobId, projectId: project.id, userId: project.userId });

        jobLogger.info({ totalScenes }, 'Processing render job');

        if (project.state !== 'VIDEO_GENERATION') {
            throw new Error(`Project ${project.id} not in VIDEO_GENERATION state`);
        }

        const hasUnlocked = scenes.some((scene) => scene.state !== 'LOCKED');
        if (hasUnlocked) {
            throw new Error(`Project ${project.id} has scenes that are not locked`);
        }

        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: 'PROCESSING',
                progress: 5,
                startedAt: new Date(),
                lockedAt: new Date(),
                lockedBy: workerId || null,
                attemptCount: Number.isFinite(attempt) ? attempt : { increment: 1 }
            }
        });

        jobDir = path.join(TMP_DIR, jobId);
        await ensureDir(jobDir);

        const sceneVideoPaths = [];

        for (let sceneIndex = 0; sceneIndex < totalScenes; sceneIndex += 1) {
            const scene = scenes[sceneIndex];
            const shots = await ensureShotsForScene({ scene, project });

            const shotVideoPaths = [];

            for (const shot of shots) {
                const options = {
                    durationSeconds: shot.duration,
                    aspectRatio: project.aspectRatio || DEFAULT_ASPECT_RATIO,
                    fps: project.fps || DEFAULT_FPS,
                    postProcess: qualitySettings.postProcess
                };
                if (shot.state === 'COMPLETED') {
                    const asset = await getLatestShotAsset(shot.id);
                    if (!asset?.url) {
                        throw new Error(`Shot ${shot.id} missing asset URL`);
                    }
                    const localPath = path.join(jobDir, `shot-${shot.id}-processed.mp4`);
                    await downloadFile(asset.url, localPath);
                    shotVideoPaths.push(localPath);
                    continue;
                }

                if (shot.state !== 'PENDING') {
                    throw new Error(`Shot ${shot.id} in non-resumable state ${shot.state}`);
                }

                try {
                    const result = await generateShotVideo({ shot, project, options, jobDir, jobId });
                    shotVideoPaths.push(result.localPath);
                } catch (error) {
                    await prisma.scene.update({
                        where: { id: scene.id },
                        data: { state: 'FAILED' }
                    });
                    throw new Error(`Shot ${shot.id} failed: ${error.message}`);
                }
            }

            if (shotVideoPaths.length === 0) {
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { state: 'FAILED' }
                });
                throw new Error(`Scene ${scene.id} has no completed shots`);
            }

            const sceneOutputPath = path.join(jobDir, `scene-${scene.orderIndex}.mp4`);
            await concatVideos({ inputPaths: shotVideoPaths, outputPath: sceneOutputPath });
            const scenePublicUrl = await uploadFile(sceneOutputPath);
            const sceneUrlString = String(scenePublicUrl || '');
            if (!sceneUrlString || sceneUrlString === 'undefined' || sceneUrlString.includes('Function')) {
                throw new Error(`Invalid scene URL: ${sceneUrlString}`);
            }

            await prisma.asset.create({
                data: {
                    projectId: project.id,
                    type: 'SCENE_VIDEO',
                    state: 'READY',
                    url: sceneUrlString,
                    metadata: JSON.stringify({ sceneId: scene.id })
                }
            });

            await prisma.scene.update({
                where: { id: scene.id },
                data: { videoUrl: sceneUrlString }
            });

            sceneVideoPaths.push(sceneOutputPath);

            const progress = Math.round(((sceneIndex + 1) / totalScenes) * 90) + 5;
            await prisma.generationJob.update({
                where: { id: jobId },
                data: { progress }
            });
        }

        if (sceneVideoPaths.length > 0) {
            await transitionProjectState({
                projectId: project.id,
                toState: 'POST_PROCESSING',
                actorType: 'system',
                actorId: null,
                reason: 'All shots generated; assembling final video'
            });

            const finalOutputPath = path.join(jobDir, 'final.mp4');
            await concatVideos({ inputPaths: sceneVideoPaths, outputPath: finalOutputPath });
            const finalPublicUrl = await uploadFile(finalOutputPath);
            const finalUrlString = String(finalPublicUrl || '');
            if (!finalUrlString || finalUrlString === 'undefined' || finalUrlString.includes('Function')) {
                throw new Error(`Invalid final video URL: ${finalUrlString}`);
            }
            logger.info({ url: finalUrlString }, 'Final video uploaded successfully');

            await prisma.project.update({
                where: { id: project.id },
                data: { finalVideoUrl: finalUrlString }
            });
            await prisma.asset.create({
                data: {
                    projectId: project.id,
                    type: 'FINAL_VIDEO',
                    state: 'READY',
                    url: finalUrlString
                }
            });

            await transitionProjectState({
                projectId: project.id,
                toState: 'COMPLETE',
                actorType: 'system',
                actorId: null,
                reason: 'Final video assembled'
            });

            await prisma.generationJob.update({
                where: { id: jobId },
                data: {
                    status: 'COMPLETED',
                    progress: 100,
                    outputUrl: finalUrlString
                }
            });

            jobLogger.info('Project marked as completed');
        } else {
            await prisma.generationJob.update({
                where: { id: jobId },
                data: {
                    status: 'FAILED',
                    errorMessage: 'No scenes could be processed'
                }
            });
            await transitionProjectState({
                projectId: project.id,
                toState: 'FAILED',
                actorType: 'system',
                actorId: null,
                reason: 'No scenes could be processed'
            });
        }

        logger.info({ jobId }, 'Render job finished');
    } catch (error) {
        logger.error({ jobId, err: error }, 'Render job failed');
        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                errorMessage: error.message
            }
        });

        const failedJob = await prisma.generationJob.findUnique({
            where: { id: jobId }
        });

        if (failedJob?.projectId) {
            await prisma.project.update({
                where: { id: failedJob.projectId },
                data: { errorLog: error.message }
            }).catch(() => undefined);

            await transitionProjectState({
                projectId: failedJob.projectId,
                toState: 'FAILED',
                actorType: 'system',
                actorId: null,
                reason: error.message
            }).catch(() => undefined);
        }
    } finally {
        if (jobDir) {
            await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
};
