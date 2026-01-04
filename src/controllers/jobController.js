import prisma from '../config/database.js';
import { generateScript, generateHeroImage } from '../services/geminiService.js';
import { processGenerationJob } from '../workers/renderWorker.js';

export const generateScriptController = async (req, res) => {
    try {
        const { story, title } = req.body;
        const userId = req.user.id; // Assumes authMiddleware is used

        if (!story) {
            return res.status(400).json({ error: 'Story text is required' });
        }

        // 1. Create Project
        const project = await prisma.project.create({
            data: {
                userId,
                title: title || `Project ${new Date().toISOString().split('T')[0]}`,
                description: story.substring(0, 200),
                status: 'draft'
            }
        });

        // 2. Generate Script (JSON) with Observability
        const { scenes: scenesData, usage } = await generateScript(story);

        // Calculate Cost (Gemini 1.5 Flash Pricing Estimate)
        // Input: $0.075 / 1M => 0.000000075
        // Output: $0.30 / 1M => 0.00000030
        const inputCost = (usage?.promptTokenCount || 0) * 0.000000075;
        const outputCost = (usage?.candidatesTokenCount || 0) * 0.00000030;
        const totalCost = inputCost + outputCost;
        const traceId = `trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

        // 4. Generate Hero Character (Identity Lock)
        // Use the action description from the first scene
        const firstSceneAction = scenesData[0]?.action_description || story;
        const heroImageId = await generateHeroImage(firstSceneAction);

        // 5. Update Project with Hero Image Identity & Observability Data
        const updatedProject = await prisma.project.update({
            where: { id: project.id },
            data: {
                heroImageId: heroImageId,
                totalTokenCost: totalCost,
                traceId: traceId
            }
        });

        res.status(201).json({
            message: 'Script generated and character locked',
            project: updatedProject,
            scenes: createdScenes,
            meta: {
                traceId,
                cost: totalCost.toFixed(6)
            }
        });

    } catch (error) {
        console.error("Generate Script Error:", error);
        res.status(500).json({ error: 'Failed to generate script', details: error.message });
    }
};

export const createGenerationJob = async (req, res) => {
    try {
        const { id: projectId } = req.params;

        // Verify project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId: req.user.id },
            include: { scenes: true }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.status !== 'draft') {
            return res.status(400).json({ error: 'Project must be in draft status' });
        }

        if (project.scenes.length === 0) {
            return res.status(400).json({ error: 'Project must have at least one scene' });
        }

        // Check credits (example: 10 credits per scene)
        const requiredCredits = project.scenes.length * 10;
        if (req.user.credits < requiredCredits) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: requiredCredits,
                available: req.user.credits
            });
        }

        // Deduct credits
        await prisma.user.update({
            where: { id: req.user.id },
            data: { credits: { decrement: requiredCredits } }
        });

        // ... (code omitted)

        // Create generation job
        const job = await prisma.generationJob.create({
            data: {
                projectId,
                status: 'queued',
                progress: 0
            }
        });

        // Update project status
        await prisma.project.update({
            where: { id: projectId },
            data: { status: 'generating' }
        });

        // MISSION 4: Fire-and-Forget Worker
        // Do not await this, so the API returns immediately (201 Accepted behavior)
        processGenerationJob(job.id).catch(err => console.error("Worker Start Error:", err));

        res.status(201).json({
            message: 'Generation job created',
            job,
            creditsDeducted: requiredCredits
        });
    } catch (error) {
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
            status: latestJob?.status || project.status,
            progress: latestJob?.progress || 0,
            project: {
                id: project.id,
                title: project.title,
                status: project.status,
                finalVideoUrl: project.finalVideoUrl
            },
            scenes: project.scenes, // Return scenes so UI can show per-scene status
            jobs: project.jobs
        });
    } catch (error) {
        console.error("Get Status Error:", error);
        res.status(500).json({ error: 'Failed to fetch generation status' });
    }
};
