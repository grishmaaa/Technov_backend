import prisma from '../config/database.js';
import { generateScriptAndImagePrompt } from '../services/aiService.js';

export const createProject = async (req, res) => {
    try {
        const { title, description } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }

        const project = await prisma.project.create({
            data: {
                title,
                description,
                userId: req.user.id
            },
            include: { scenes: true }
        });

        res.status(201).json(project);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create project', details: error.message });
    }
};

export const getProjects = async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            where: { userId: req.user.id },
            include: { scenes: { orderBy: { orderIndex: 'asc' } }, _count: { select: { scenes: true } } },
            orderBy: { createdAt: 'desc' }
        });

        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
};

export const getProject = async (req, res) => {
    try {
        const { id } = req.params;

        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { scenes: { orderBy: { orderIndex: 'asc' } } }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch project' });
    }
};

export const updateProject = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, status } = req.body;

        const existingProject = await prisma.project.findFirst({
            where: { id, userId: req.user.id }
        });

        if (!existingProject) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = await prisma.project.update({
            where: { id },
            data: { title, description, status },
            include: { scenes: { orderBy: { orderIndex: 'asc' } } }
        });

        res.json(project);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update project' });
    }
};

export const deleteProject = async (req, res) => {
    try {
        const { id } = req.params;

        const existingProject = await prisma.project.findFirst({
            where: { id, userId: req.user.id }
        });

        if (!existingProject) {
            return res.status(404).json({ error: 'Project not found' });
        }

        await prisma.project.delete({ where: { id } });

        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete project' });
    }
};

export const generateScenesFromStory = async (req, res) => {
    try {
        const { story, visualStyle } = req.body;

        if (!story) {
            return res.status(400).json({ error: 'Story is required' });
        }

        const result = await generateScriptAndImagePrompt(story, visualStyle);

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate scenes', details: error.message });
    }
};
