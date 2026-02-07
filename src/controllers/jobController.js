//jobcontrollers.js
import prisma from '../config/database.js';
import { generateScript } from '../services/geminiService.js';
import { generateTitle } from '../services/aiService.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { renderQueue } from '../queue/renderQueue.js';
import { logger } from '../logger.js';

export const generateScriptController = async (req, res) => {
    try {
        const {
            story,
            title,
            quality,
            qualityTier,
            aspectRatio,
            fps,
            // Pro tier parameters - accept both old and new field names
            productionStyle: rawProductionStyle = 'standard',
            artisticAtmosphere = 'photorealistic',
            dialogueFocus,
            contentFocus, // Frontend sends contentFocus
            length = 'standard',
            visualMood // Future use
        } = req.body;

        // Normalize productionStyle from frontend values
        const styleMap = {
            'social-vlog': 'vlog',
            'standard-clean': 'standard',
            'cinematic-epic': 'cinematic',
            'performance-pro': 'performance'
        };
        const productionStyle = styleMap[rawProductionStyle] || rawProductionStyle || 'standard';

        // Use contentFocus if dialogueFocus not provided (frontend compatibility)
        const focusMap = {
            'pure-visuals': 'visuals',
            'balanced-narrative': 'balanced',
            'performance-driven': 'performance'
        };
        const focus = dialogueFocus || focusMap[contentFocus] || contentFocus || 'balanced';

        const userId = req.user.id;
        const userPlan = req.user.plan || 'basic';

        if (!story) {
            return res.status(400).json({ error: 'Story text is required' });
        }

        // --- TIER VALIDATION ---
        const PLAN_LIMITS = {
            free: { maxScenes: 0, maxDuration: 0, allowFast: false },
            basic: { maxScenes: 5, maxDuration: 40, allowFast: false },
            pro: { maxScenes: 15, maxDuration: 300, allowFast: false }, // Assumed 300s (5m) for Pro
            elite: { maxScenes: 50, maxDuration: 600, allowFast: true } // Assumed 600s (10m) for Elite
        };
        const limits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;

        if (userPlan === 'free') {
            return res.status(403).json({ error: "Please upgrade to a paid plan to generate scripts.", checkout: true });
        }

        if (userPlan === 'basic') {
            if (length === 'extended') {
                return res.status(403).json({ error: "Upgrade to Pro/Elite for extended videos." });
            }
            if (productionStyle === 'cinematic' || productionStyle === 'performance') {
                return res.status(403).json({ error: "Cinematic & Performance styles are Premium features." });
            }
            if (focus === 'performance') {
                return res.status(403).json({ error: "Dialogue Focus is a Premium feature." });
            }
        }

        // --- DYNAMIC CREDIT COST (Pro features cost more) ---
        let scriptCreditCost = 5; // Base cost
        if (length === 'extended') scriptCreditCost += 10;
        if (productionStyle === 'cinematic' || productionStyle === 'performance') scriptCreditCost += 5;
        if (focus === 'performance') scriptCreditCost += 5;

        // Check if user has enough credits
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const SCRIPT_GENERATION_COST = scriptCreditCost;

        if (user.credits < SCRIPT_GENERATION_COST) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: SCRIPT_GENERATION_COST,
                available: user.credits
            });
        }

        // 1. Create Project
        const normalizedQuality = (qualityTier || quality || '').toString().toLowerCase();
        const normalizedFps = Number.isFinite(Number(fps)) ? Number(fps) : undefined;

        const project = await prisma.project.create({
            data: {
                userId,
                title: title || `Project ${new Date().toISOString().split('T')[0]}`,
                description: story.substring(0, 200),
                state: 'CREATED',
                qualityTier: normalizedQuality || undefined,
                aspectRatio: aspectRatio || undefined,
                fps: normalizedFps
            }
        });

        // Generate Script (JSON)
        const { scenes: scenesData, suggested_title: geminiTitle, usage, assetSheet } = await generateScript(story, {
            plan: userPlan,
            productionStyle,
            artisticAtmosphere,
            length,
            visualMood
        });

        // Generate creative title (Parallel execution would be better but keeping it simple for now)
        // We prefer: 1. Specialized AI Title -> 2. Gemini Title -> 3. User/Default Title
        const specializedAiTitle = await generateTitle(story); // From aiService.js

        let finalTitle = specializedAiTitle || geminiTitle || title;

        // Fallback if everything is missing
        if (!finalTitle || finalTitle.startsWith('Film 20')) {
            finalTitle = `Project ${new Date().toISOString().split('T')[0]}`;
        }

        // Update project with AI-generated title
        await prisma.project.update({
            where: { id: project.id },
            data: {
                title: finalTitle,
                metadata: assetSheet || undefined
            }
        });

        // Calculate Cost (OpenAI GPT-4 Pricing)
        // Input: ~$0.01 / 1K tokens, Output: ~$0.03 / 1K tokens
        const inputCost = (usage?.promptTokenCount || 0) / 1000 * 0.01;
        const outputCost = (usage?.candidatesTokenCount || 0) / 1000 * 0.03;
        const totalCost = inputCost + outputCost;
        const traceId = `trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        logger.info({ userId, totalCost, credits: SCRIPT_GENERATION_COST }, 'Script generation cost');

        // Deduct credits using transaction (prevents double-spend) and record usage
        await prisma.$transaction(async (tx) => {
            // Double-check credits in transaction
            const freshUser = await tx.user.findUnique({ where: { id: userId } });
            if (freshUser.credits < SCRIPT_GENERATION_COST) {
                throw new Error('Insufficient credits');
            }

            // Deduct credits
            await tx.user.update({
                where: { id: userId },
                data: { credits: { decrement: SCRIPT_GENERATION_COST } }
            });

            // Record usage for audit trail
            await tx.creditUsage.create({
                data: {
                    userId,
                    amount: SCRIPT_GENERATION_COST,
                    type: 'SCRIPT_GEN',
                    description: `Generated script for: ${title || project.title}`,
                    projectId: project.id
                }
            });
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

        // Allow generation from intermediate review states as well
        if (!['SCENES_GENERATED', 'USER_REVIEW', 'VISUAL_IDENTITY_DECISION', 'ASSETS_READY', 'COMPLETE', 'FAILED', 'VIDEO_GENERATION'].includes(project.state)) {
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
        const userPlan = req.user.plan || 'basic'; // TODO: Change default to 'free' after migration
        if (userPlan === 'free') {
            return res.status(403).json({ error: "Please upgrade to a paid plan to generate videos.", checkout: true });
        }

        const PLAN_LIMITS = {
            free: { maxDuration: 0 },
            basic: { maxDuration: 40 },
            pro: { maxDuration: 300 },
            elite: { maxDuration: 9999 }
        };
        const updatedLimit = PLAN_LIMITS[userPlan] || PLAN_LIMITS.basic;

        if (totalDuration > updatedLimit.maxDuration) {
            return res.status(403).json({
                error: `Plan limit exceeded. Your plan (${userPlan}) allows max ${updatedLimit.maxDuration}s. Project is ${totalDuration}s.`,
                required: updatedLimit.maxDuration,
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
