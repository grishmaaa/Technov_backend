import prisma from '../config/database.js';

export const createScene = async (req, res) => {
    try {
        const { projectId } = req.params;
        const { promptText, duration, orderIndex } = req.body;

        if (!promptText) {
            return res.status(400).json({ error: 'Prompt text is required' });
        }

        // Verify project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId: req.user.id }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.status !== 'draft') {
            return res.status(400).json({ error: 'Can only add scenes to draft projects' });
        }

        // Auto-calculate order index if not provided
        const finalOrderIndex = orderIndex !== undefined ? orderIndex : await prisma.scene.count({ where: { projectId } });

        const scene = await prisma.scene.create({
            data: {
                projectId,
                promptText,
                duration: duration || 5,
                orderIndex: finalOrderIndex
            }
        });

        res.status(201).json(scene);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create scene', details: error.message });
    }
};

export const getScenes = async (req, res) => {
    try {
        const { projectId } = req.params;

        // Verify project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId: req.user.id }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const scenes = await prisma.scene.findMany({
            where: { projectId },
            orderBy: { orderIndex: 'asc' }
        });

        res.json(scenes);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch scenes' });
    }
};

export const updateScene = async (req, res) => {
    try {
        const { sceneId } = req.params;
        const { promptText, duration, orderIndex, status } = req.body;

        const scene = await prisma.scene.findUnique({
            where: { id: sceneId },
            include: { project: true }
        });

        if (!scene || scene.project.userId !== req.user.id) {
            return res.status(404).json({ error: 'Scene not found' });
        }

        if (scene.project.status !== 'draft' && (promptText || duration !== undefined || orderIndex !== undefined)) {
            return res.status(400).json({ error: 'Can only edit scenes in draft projects' });
        }

        const updatedScene = await prisma.scene.update({
            where: { id: sceneId },
            data: { promptText, duration, orderIndex, status }
        });

        res.json(updatedScene);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update scene' });
    }
};

export const deleteScene = async (req, res) => {
    try {
        const { sceneId } = req.params;

        const scene = await prisma.scene.findUnique({
            where: { id: sceneId },
            include: { project: true }
        });

        if (!scene || scene.project.userId !== req.user.id) {
            return res.status(404).json({ error: 'Scene not found' });
        }

        if (scene.project.status !== 'draft') {
            return res.status(400).json({ error: 'Can only delete scenes from draft projects' });
        }

        await prisma.scene.delete({ where: { id: sceneId } });

        res.json({ message: 'Scene deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete scene' });
    }
};
