import prisma from '../config/database.js';
import { generateScriptAndImagePrompt } from '../services/aiService.js';
import { generateHeroImage } from '../services/geminiService.js';
import { transitionProjectState } from '../services/projectStateService.js';

export const createProject = async (req, res) => {
    try {
        const { title, description, qualityTier, aspectRatio, fps } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }

        const project = await prisma.project.create({
            data: {
                title,
                description,
                userId: req.user.id,
                qualityTier: qualityTier || undefined,
                aspectRatio: aspectRatio || undefined,
                fps: fps || undefined
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

export const getProjectFactory = async (req, res) => {
    try {
        const { id } = req.params;

        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: {
                scenes: {
                    orderBy: { orderIndex: 'asc' },
                    include: {
                        shots: {
                            orderBy: { orderIndex: 'asc' },
                            include: {
                                variants: { orderBy: { variantIndex: 'asc' } }
                            }
                        }
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ project, scenes: project.scenes });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch project factory data', details: error.message });
    }
};

export const updateProject = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, qualityTier, aspectRatio, fps } = req.body;

        const existingProject = await prisma.project.findFirst({
            where: { id, userId: req.user.id }
        });

        if (!existingProject) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = await prisma.project.update({
            where: { id },
            data: { title, description, qualityTier, aspectRatio, fps },
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
        const { story, visualStyle, projectId } = req.body;

        if (!story) {
            return res.status(400).json({ error: 'Story is required' });
        }

        const result = await generateScriptAndImagePrompt(story, visualStyle);

        if (projectId) {
            const existingProject = await prisma.project.findFirst({
                where: { id: projectId, userId: req.user.id }
            });

            if (!existingProject) {
                return res.status(404).json({ error: 'Project not found' });
            }

            await prisma.project.update({
                where: { id: projectId },
                data: { imagePrompt: result.imagePrompt }
            });
        }

        if (projectId) {
            await transitionProjectState({
                projectId,
                toState: 'SCENES_GENERATED',
                actorType: 'system',
                actorId: req.user.id,
                reason: 'Scenes generated from story'
            });
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate scenes', details: error.message });
    }
};

export const startSceneReview = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const idempotencyKey = req.headers['idempotency-key'] || null;
        const updated = await transitionProjectState({
            projectId: id,
            toState: 'USER_REVIEW',
            actorType: 'user',
            actorId: req.user.id,
            reason: 'User started scene review',
            idempotencyKey
        });

        res.json(updated);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const approveScenes = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { scenes: true }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (!['USER_REVIEW', 'SCENES_GENERATED'].includes(project.state)) {
            return res.status(400).json({ error: 'Project is not in review' });
        }

        await prisma.scene.updateMany({
            where: { projectId: id },
            data: { state: 'LOCKED' }
        });

        const idempotencyKey = req.headers['idempotency-key'] || null;
        const updated = await transitionProjectState({
            projectId: id,
            toState: 'VISUAL_IDENTITY_DECISION',
            actorType: 'user',
            actorId: req.user.id,
            reason: 'User approved scenes',
            idempotencyKey
        });

        res.json(updated);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

const HERO_KEYWORDS = [
    'character',
    'person',
    'man',
    'woman',
    'boy',
    'girl',
    'face',
    'close-up',
    'portrait',
    'actor',
    'actress'
];

const requiresHeroAssets = (scenes) => {
    return scenes.some((scene) => {
        const text = `${scene.promptText || ''} ${scene.actionDescription || ''}`.toLowerCase();
        return HERO_KEYWORDS.some((keyword) => text.includes(keyword));
    });
};

export const decideVisualIdentity = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { scenes: true }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.state !== 'VISUAL_IDENTITY_DECISION') {
            return res.status(400).json({ error: 'Project not ready for visual identity decision' });
        }

        const needsHero = requiresHeroAssets(project.scenes);
        const reason = needsHero
            ? 'Detected character-focused scenes; hero assets required'
            : 'No character focus detected; hero assets not required';

        const updatedProject = await prisma.project.update({
            where: { id },
            data: {
                requiresHeroAssets: needsHero,
                visualIdentityReason: reason
            }
        });

        if (!needsHero) {
            await transitionProjectState({
                projectId: id,
                toState: 'ASSETS_READY',
                actorType: 'system',
                actorId: req.user.id,
                reason
            });
        }

        res.json({
            requiresHeroAssets: needsHero,
            reason,
            project: updatedProject
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

export const generateHeroAssets = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { scenes: true, assets: true }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (!['SCENES_GENERATED', 'VISUAL_IDENTITY_DECISION'].includes(project.state)) {
            return res.status(400).json({
                error: 'Project not ready for hero assets',
                currentState: project.state,
                hint: 'Generate scenes first'
            });
        }

        // TEMPORARILY skip all hero assets to avoid OpenAI rate limits
        // Hero image generation can be re-enabled later when rate limits are resolved
        await transitionProjectState({
            projectId: id,
            toState: 'ASSETS_READY',
            actorType: 'system',
            actorId: req.user.id,
            reason: 'Hero assets temporarily disabled'
        });
        return res.json({
            message: 'Hero assets skipped to avoid rate limits',
            skipped: true
        });

        const existing = project.assets.find((asset) => asset.type === 'HERO_IMAGE' && asset.state === 'READY');
        if (existing) {
            await transitionProjectState({
                projectId: id,
                toState: 'ASSETS_READY',
                actorType: 'system',
                actorId: req.user.id,
                reason: 'Hero assets already available'
            });
            return res.json({ asset: existing, alreadyExists: true });
        }

        const baseContext = project.scenes[0]?.actionDescription || project.scenes[0]?.promptText || project.title;
        const heroUrl = await generateHeroImage(baseContext);

        const asset = await prisma.asset.create({
            data: {
                projectId: id,
                type: 'HERO_IMAGE',
                state: 'READY',
                url: heroUrl,
                metadata: JSON.stringify({ source: 'generated', seedContext: baseContext })
            }
        });

        await prisma.project.update({
            where: { id },
            data: { heroImageId: asset.id }
        });

        await transitionProjectState({
            projectId: id,
            toState: 'ASSETS_READY',
            actorType: 'system',
            actorId: req.user.id,
            reason: 'Hero assets generated'
        });

        res.json({ asset });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};
