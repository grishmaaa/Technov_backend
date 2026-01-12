import prisma from '../config/database.js';
import { generateScript } from '../services/geminiService.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { renderQueue } from '../queue/renderQueue.js';
import { logger } from '../logger.js';

export const generateScriptController = async (req, res) => {
    try {
        const { story, title } = req.body;
        const userId = req.user.id;

        if (!story) {
            return res.status(400).json({ error: 'Story text is required' });
        }

        // Check if user has enough credits (minimum 10 credits for script generation)
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const SCRIPT_GENERATION_COST = 5; // 5 credits per script

        if (user.credits < SCRIPT_GENERATION_COST) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: SCRIPT_GENERATION_COST,
                available: user.credits
            });
        }

        // 1. Create Project
        const project = await prisma.project.create({
            data: {
                userId,
                title: title || `Project ${new Date().toISOString().split('T')[0]}`,
                description: story.substring(0, 200),
                state: 'CREATED'
            }
        });

        // 2. Generate Script (JSON) with Observability
        const { scenes: scenesData, usage } = await generateScript(story);

        // Calculate Cost (OpenAI GPT-4 Pricing)
        // Input: ~$0.01 / 1K tokens, Output: ~$0.03 / 1K tokens
        const inputCost = (usage?.promptTokenCount || 0) / 1000 * 0.01;
        const outputCost = (usage?.candidatesTokenCount || 0) / 1000 * 0.03;
        const totalCost = inputCost + outputCost;
        const traceId = `trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        logger.info({ userId, totalCost, credits: SCRIPT_GENERATION_COST }, 'Script generation cost');

        // Deduct credits from user
        await prisma.user.update({
            where: { id: userId },
            data: { credits: { decrement: SCRIPT_GENERATION_COST } }
        });

        logger.info({ userId, remainingCredits: user.credits - SCRIPT_GENERATION_COST }, 'Credits deducted for script');


        // 3. Save Scenes to DB
        const createdScenes = [];
        for (const scene of scenesData) {
            const newScene = await prisma.scene.create({
                data: {
                    projectId: project.id,
                    orderIndex: scene.scene_id,
                    promptText: scene.action_description,
                    actionDescription: scene.action_description,
                    motionComplexity: scene.motion_complexity,
                    audioDirective: scene.audio_directive,
                    duration: scene.duration
                }
            });
            createdScenes.push(newScene);
        }

        await transitionProjectState({
            projectId: project.id,
            toState: 'SCENES_GENERATED',
            actorType: 'system',
            actorId: userId,
            reason: 'Scenes generated from script'
        });

        const updatedProject = await prisma.project.update({
            where: { id: project.id },
            data: {
                totalTokenCost: totalCost,
                traceId: traceId
            }
        });

        res.status(201).json({
            message: 'Script generated',
            project: updatedProject,
            scenes: createdScenes,
            meta: {
                traceId,
                cost: totalCost.toFixed(6)
            }
        });

    } catch (error) {
        logger.error({ err: error }, 'Generate script failed');
        res.status(500).json({ error: 'Failed to generate script', details: error.message });
    }
};

export const createGenerationJob = async (req, res) => {
    try {
        const { id: projectId } = req.params;
        const { qualityTier, aspectRatio, fps } = req.body || {};
        if (!process.env.REDIS_URL) {
            return res.status(503).json({ error: 'Render queue unavailable' });
        }

        // Verify project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId: req.user.id },
            include: { scenes: true }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.scenes.length === 0) {
            return res.status(400).json({ error: 'Project must have at least one scene' });
        }

        if (!['SCENES_GENERATED', 'ASSETS_READY'].includes(project.state)) {
            return res.status(400).json({
                error: 'Project not ready for video generation',
                state: project.state,
                hint: 'Generate scenes first'
            });
        }

        const effectiveQuality = (qualityTier || project.qualityTier || 'cinematic').toLowerCase();
        const creditsPerScene = effectiveQuality === 'basic' ? 10 : 20;
        const requiredCredits = project.scenes.length * creditsPerScene;
        if (req.user.credits < requiredCredits) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: requiredCredits,
                available: req.user.credits
            });
        }

        // Persist quality settings on the project for the worker
        await prisma.project.update({
            where: { id: projectId },
            data: {
                qualityTier: effectiveQuality,
                aspectRatio: aspectRatio || project.aspectRatio,
                fps: fps || project.fps
            }
        });

        // Deduct credits upfront
        await prisma.user.update({
            where: { id: req.user.id },
            data: { credits: { decrement: requiredCredits } }
        });

        // ... (code omitted)

        // Create generation job
        const job = await prisma.generationJob.create({
            data: {
                projectId,
                status: 'QUEUED',
                progress: 0
            }
        });
        try {
            await renderQueue.add('render', { jobId: job.id, projectId, userId: req.user.id });
        } catch (error) {
            await prisma.generationJob.update({
                where: { id: job.id },
                data: { status: 'FAILED', errorMessage: 'Queue enqueue failed' }
            });
            await prisma.user.update({
                where: { id: req.user.id },
                data: { credits: { increment: requiredCredits } }
            });
            await transitionProjectState({
                projectId,
                toState: 'ASSETS_READY',
                actorType: 'system',
                actorId: req.user.id,
                reason: 'Queue enqueue failed'
            });
            throw error;
        }

        // Update project status
        await transitionProjectState({
            projectId,
            toState: 'VIDEO_GENERATION',
            actorType: 'system',
            actorId: req.user.id,
            reason: 'Generation job created'
        });

        res.status(201).json({
            message: 'Generation job created',
            job,
            creditsDeducted: requiredCredits,
            qualityTier: effectiveQuality
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to create generation job');
        res.status(500).json({ error: 'Failed to create generation job', details: error.message });
    }
};

export const getGenerationStatus = async (req, res) => {
    try {
        const { id: projectId } = req.params;

        // Verify project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId: req.user.id },
            include: {
                jobs: { orderBy: { createdAt: 'desc' }, take: 1 },
                scenes: { orderBy: { orderIndex: 'asc' } }
            }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const latestJob = project.jobs[0];

        // Match frontend expectation: { status, progress, scenes, project }
        res.json({
            status: latestJob?.status || project.state,
            progress: latestJob?.progress || 0,
            project: {
                id: project.id,
                title: project.title,
                status: project.state,
                finalVideoUrl: project.finalVideoUrl
            },
            scenes: project.scenes, // Return scenes so UI can show per-scene status
            jobs: project.jobs
        });
    } catch (error) {
        logger.error({ err: error }, 'Get generation status failed');
        res.status(500).json({ error: 'Failed to fetch generation status' });
    }
};
