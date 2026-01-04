import prisma from '../config/database.js';

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

        // TODO: Trigger actual video generation queue/worker here
        // For now, this is just the API structure

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
            where: { id: projectId, userId: req.user.id }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const jobs = await prisma.generationJob.findMany({
            where: { projectId },
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            project: {
                id: project.id,
                title: project.title,
                status: project.status,
                finalVideoUrl: project.finalVideoUrl
            },
            jobs
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch generation status' });
    }
};
