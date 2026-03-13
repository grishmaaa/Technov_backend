//jobcontrollers.js
import prisma from '../config/database.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { renderQueue } from '../queue/renderQueue.js';
import { logger } from '../logger.js';

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

        // Allow generation from intermediate review states as well
        if (!['SCENES_GENERATED', 'USER_REVIEW', 'VISUAL_IDENTITY_DECISION', 'ASSETS_READY', 'COMPLETE', 'FAILED', 'VIDEO_GENERATION', 'WORLD_ASSETS_APPROVED'].includes(project.state)) {
            return res.status(400).json({
                error: 'Project not ready for video generation',
                state: project.state,
                hint: 'Generate scenes first'
            });
        }

        const effectiveQuality = (qualityTier || project.qualityTier || 'cinematic').toLowerCase();

        // 1. Calculate Total Duration & Credits
        const totalDuration = project.scenes.reduce((sum, scene) => sum + (scene.duration || 0), 0);
        const requiredCredits = Math.ceil(totalDuration); // 1 credit = 1 second

        // 2. Enforce Plan Limits
        const userPlan = req.user.plan || 'free';

        const PLAN_LIMITS = {
            free: { name: 'Free', maxDuration: 40 },
            pro: { name: 'Standard', maxDuration: 3000 },
            elite: { name: 'Standard', maxDuration: 3000 },
            custom: { name: 'Custom', maxDuration: 3000 }
        };
        const planConfig = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;

        if (totalDuration > planConfig.maxDuration) {
            return res.status(403).json({
                error: `Plan limit exceeded. Your ${planConfig.name} plan allows max ${planConfig.maxDuration}s. Project is ${totalDuration}s.`,
                required: planConfig.maxDuration,
                current: totalDuration
            });
        }

        // Elite: Use Fast Model if requested (via qualityTier 'elite_fast' or similar? Or just strict Elite check)
        // User request: "Elite Plan: We will use the VEO_MODEL_FAST ... to select the faster model"
        // We'll tag the project qualityTier as 'elite_fast' if appropriate, or let the worker handle it based on user plan?
        // Worker only sees 'project.qualityTier'. Let's set it if user is elite.

        let finalQualityTier = effectiveQuality;
        if (userPlan === 'elite' && process.env.VEO_MODEL_FAST) {
            // If the user explicitly selected a "Fast" quality in frontend, or we default to it?
            // Prompt says: "Elite Plan: We will use the VEO_MODEL_FAST ... to select the faster model".
            // We can map a specific qualityTier to this.
            if (effectiveQuality === 'fast' || effectiveQuality === 'performance') { // checks logic
                finalQualityTier = 'veo_fast';
            }
        }
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

        // Deduct credits using transaction (prevents double-spend) and record usage
        await prisma.$transaction(async (tx) => {
            // Double-check credits in transaction
            const freshUser = await tx.user.findUnique({ where: { id: req.user.id } });
            if (freshUser.credits < requiredCredits) {
                throw new Error('Insufficient credits');
            }

            // Deduct credits
            await tx.user.update({
                where: { id: req.user.id },
                data: { credits: { decrement: requiredCredits } }
            });

            // Record usage for audit trail
            await tx.creditUsage.create({
                data: {
                    userId: req.user.id,
                    amount: requiredCredits,
                    type: 'VIDEO_GEN',
                    description: `Rendered ${project.scenes.length} scenes for: ${project.title}`,
                    projectId
                }
            });
        });

        // Create generation job
        const job = await prisma.generationJob.create({
            data: {
                projectId,
                status: 'QUEUED',
                progress: 0
            }
        });

        logger.info({ jobId: job.id, projectId, userId: req.user.id }, 'Adding job to render queue');

        // 3. Update project status before adding to queue to avoid race conditions
        await transitionProjectState({
            projectId,
            toState: 'VIDEO_GENERATION',
            actorType: 'system',
            actorId: req.user.id,
            reason: 'Generation job created'
        });

        try {
            const bullJob = await renderQueue.add('render', { jobId: job.id, projectId, userId: req.user.id });
            logger.info({ jobId: job.id, bullJobId: bullJob.id }, 'Job successfully added to render queue');
        } catch (error) {
            logger.error({ err: error, jobId: job.id }, 'Failed to add job to render queue');
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
