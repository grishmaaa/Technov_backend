import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import prisma from './config/database.js';
import { openai } from './services/aiService.js';
import { uploadFile } from './services/fileHostingService.js';

const VOLUME_PATH = '/data';
const TMP_DIR = path.join(VOLUME_PATH, 'tmp');
const SAMPLE_CLIP_PATH = process.env.SAMPLE_CLIP_PATH || path.join(VOLUME_PATH, 'sample.mp4');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const generateHeroImage = async (imagePrompt, jobDir) => {
    const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: imagePrompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1
    });

    const imageUrl = response?.data?.[0]?.url;
    if (!imageUrl) {
        throw new Error('DALL-E response missing image URL');
    }

    const heroImagePath = path.join(jobDir, 'hero.jpg');
    await downloadFile(imageUrl, heroImagePath);
    return heroImagePath;
};

const generateVideoClip = async (sceneDescription, heroImagePath, outputPath) => {
    const prompt = [
        'Kling 2.6 prompt:',
        sceneDescription,
        `Reference hero image: ${heroImagePath}`
    ].join('\n');

    console.log(`[Worker] Video prompt:\n${prompt}`);
    await fs.copyFile(SAMPLE_CLIP_PATH, outputPath);
    return outputPath;
};

const runFfmpegConcat = (listFilePath, outputPath) => new Promise((resolve, reject) => {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFilePath, '-c', 'copy', outputPath];
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

const stitchVideoClips = async (clipPaths, jobDir) => {
    const listFilePath = path.join(jobDir, 'clips.txt');
    const listFileContents = clipPaths.map((clipPath) => `file '${clipPath}'`).join('\n');
    await fs.writeFile(listFilePath, listFileContents);

    const outputPath = path.join(jobDir, 'final.mp4');
    await runFfmpegConcat(listFilePath, outputPath);
    return outputPath;
};

const fetchAndLockJob = async () => {
    const job = await prisma.generationJob.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' }
    });

    if (!job) {
        return null;
    }

    const updated = await prisma.generationJob.updateMany({
        where: { id: job.id, status: 'queued' },
        data: { status: 'processing' }
    });

    return updated.count === 1 ? job : null;
};

const notifyServices = async (projectId, finalVideoUrl) => {
    console.log(`[Worker] Notification service triggered for project ${projectId}: ${finalVideoUrl}`);
    console.log(`[Worker] Email service triggered for project ${projectId}.`);
};

const processJobs = async () => {
    await ensureDir(TMP_DIR);

    while (true) {
        let job;
        try {
            job = await fetchAndLockJob();

            if (!job) {
                await sleep(10000);
                continue;
            }

            const project = await prisma.project.findUnique({
                where: { id: job.projectId },
                include: { scenes: { orderBy: { orderIndex: 'asc' } } }
            });

            if (!project) {
                await prisma.generationJob.update({
                    where: { id: job.id },
                    data: { status: 'failed', errorMessage: 'Project not found' }
                });
                continue;
            }

            const jobDir = path.join(TMP_DIR, job.id);
            await ensureDir(jobDir);

            const imagePrompt = project.description || project.title || project.scenes[0]?.promptText || 'Cinematic hero portrait';
            const heroImagePath = await generateHeroImage(imagePrompt, jobDir);

            const totalScenes = project.scenes.length || 1;
            const clipPaths = [];

            for (let index = 0; index < project.scenes.length; index += 1) {
                const scene = project.scenes[index];
                const clipPath = path.join(jobDir, `scene-${scene.orderIndex}.mp4`);
                const description = scene.actionDescription || scene.promptText;

                await generateVideoClip(description, heroImagePath, clipPath);
                clipPaths.push(clipPath);

                const progress = Math.round(((index + 1) / totalScenes) * 80);
                await prisma.generationJob.update({
                    where: { id: job.id },
                    data: { progress }
                });
            }

            const finalVideoPath = await stitchVideoClips(clipPaths, jobDir);
            const publicUrl = await uploadFile(finalVideoPath);

            await prisma.project.update({
                where: { id: project.id },
                data: {
                    finalVideoUrl: publicUrl,
                    status: 'completed'
                }
            });

            await prisma.generationJob.update({
                where: { id: job.id },
                data: {
                    status: 'completed',
                    outputUrl: publicUrl,
                    progress: 100
                }
            });

            await notifyServices(project.id, publicUrl);
            await fs.rm(jobDir, { recursive: true, force: true });
        } catch (error) {
            console.error('[Worker] Job processing failed:', error.message);

            if (job?.id) {
                await prisma.generationJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'failed',
                        errorMessage: error.message
                    }
                });
            }

            await sleep(5000);
        }
    }
};

processJobs();
