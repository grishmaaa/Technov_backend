import prisma from '../config/database.js';
import { generateScriptAndImagePrompt, generateTitle } from '../services/aiService.js';
import { generateHeroImage } from '../services/geminiService.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { getPresignedDownloadUrl, getS3Client, getStorageConfig } from '../services/storageService.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';

// Helper to turn a raw DB URL into a Signed Playable URL
const signUrl = async (rawUrl) => {
    if (!rawUrl || !rawUrl.includes('railway.app')) return rawUrl;
    try {
        // Example rawUrl: https://storage.railway.app/generated/user-id/file.mp4
        // We need to extract: generated/user-id/file.mp4
        const urlObj = new URL(rawUrl);
        const key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;

        console.log("[Signer] Signing key:", key);

        return await getPresignedDownloadUrl({ key, expiresIn: 3600 });
    } catch (err) {
        console.error("[Signer] Signing failed for URL:", rawUrl, err);
        return rawUrl;
    }
};

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
            include: {
                scenes: { orderBy: { orderIndex: 'asc' } },
                assets: true
            }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // SIGN THE FINAL VIDEO
        if (project.finalVideoUrl) {
            project.finalVideoUrl = await signUrl(project.finalVideoUrl);
        }

        // SIGN THE SCENE VIDEOS
        for (let scene of project.scenes) {
            if (scene.videoUrl) {
                scene.videoUrl = await signUrl(scene.videoUrl);
            }
        }

        // SIGN HERO ASSET
        if (project.assets) {
            for (let asset of project.assets) {
                if (asset.type === 'HERO_IMAGE' && asset.url) {
                    asset.url = await signUrl(asset.url);
                }
            }
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
                assets: true,
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

        // SIGN THE FINAL VIDEO
        if (project.finalVideoUrl) {
            project.finalVideoUrl = await signUrl(project.finalVideoUrl);
        }

        // SIGN THE SCENE VIDEOS
        for (let scene of project.scenes) {
            if (scene.videoUrl) {
                scene.videoUrl = await signUrl(scene.videoUrl);
            }
        }

        // SIGN HERO ASSET
        if (project.assets) {
            for (let asset of project.assets) {
                if (asset.type === 'HERO_IMAGE' && asset.url) {
                    asset.url = await signUrl(asset.url);
                }
            }
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

        // Generate script and title concurrently
        const [result, aiTitle] = await Promise.all([
            generateScriptAndImagePrompt(story, visualStyle),
            generateTitle(story)
        ]);

        if (projectId) {
            const existingProject = await prisma.project.findFirst({
                where: { id: projectId, userId: req.user.id }
            });

            if (!existingProject) {
                return res.status(404).json({ error: 'Project not found' });
            }

            const updateData = { imagePrompt: result.imagePrompt };

            // Only update title if AI generated one and it looks valid
            if (aiTitle) {
                updateData.title = aiTitle;
            }

            await prisma.project.update({
                where: { id: projectId },
                data: updateData
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

        res.json({ ...result, title: aiTitle });
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
        const { regenerate, userInstructions } = req.body;
        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { scenes: true, assets: true }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.state !== 'VISUAL_IDENTITY_DECISION' && project.state !== 'ASSETS_READY') {
            return res.status(400).json({ error: 'Project not ready for hero assets' });
        }

        if (!project.requiresHeroAssets) {
            return res.status(400).json({ error: 'Hero assets not required for this project' });
        }

        const existing = project.assets.find((asset) => asset.type === 'HERO_IMAGE' && asset.state === 'READY');
        if (existing && !regenerate) {
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
        const heroUrl = await generateHeroImage(baseContext, userInstructions);

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

// Get special media links for view/download/share
export const getProjectMediaLinks = async (req, res) => {
    try {
        const { id } = req.params;
        const { action } = req.query; // 'view', 'download', or 'share'

        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id }
        });

        if (!project || !project.finalVideoUrl) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Extract key from the stored URL
        const urlObj = new URL(project.finalVideoUrl);
        const key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;

        let url;
        if (action === 'download') {
            // Link that forces a download (5 minutes)
            url = await getPresignedDownloadUrl({ key, expiresIn: 300, download: true });
        } else if (action === 'share') {
            // Link that lasts 7 days for sharing
            url = await getPresignedDownloadUrl({ key, expiresIn: 604800 });
        } else {
            // Default 1 hour link for the player
            url = await getPresignedDownloadUrl({ key, expiresIn: 3600 });
        }

        res.json({ url });
    } catch (error) {
        console.error('[MediaLinks] Error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Video streaming proxy - bypasses CORS and MIME issues completely
export const streamProjectVideo = async (req, res) => {
    const { id } = req.params;
    try {
        console.log('[Stream] Request for project:', id);

        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id }
        });

        if (!project) {
            console.error('[Stream] Project not found for ID:', id);
            return res.status(404).json({ error: "Project not found" });
        }

        if (!project.finalVideoUrl) {
            console.error('[Stream] No finalVideoUrl for project:', id);
            return res.status(404).json({ error: "Video not yet available" });
        }

        console.log('[Stream] finalVideoUrl:', project.finalVideoUrl);

        // Extract key correctly
        let key;
        try {
            const urlObj = new URL(project.finalVideoUrl);
            key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
        } catch (urlError) {
            console.log('[Stream] URL parsing failed, using as key directly');
            key = project.finalVideoUrl;
        }

        const { bucket } = getStorageConfig();
        console.log('[Stream] Attempting to fetch key:', key, 'from bucket:', bucket);

        const client = getS3Client();
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key
        });

        const response = await client.send(command);
        console.log('[Stream] S3 response received, ContentLength:', response.ContentLength);

        // Crucial Headers for Chrome/Firefox
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        if (response.ContentLength) {
            res.setHeader('Content-Length', response.ContentLength);
        }

        // AWS SDK v3 response.Body is a readable stream in Node.js
        response.Body.pipe(res);

        response.Body.on('error', (err) => {
            console.error("[Stream] Stream pipe error:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Stream failed" });
            }
        });

    } catch (error) {
        console.error("[Stream] Critical Error:", error.message);
        console.error("[Stream] Error name:", error.name);

        // If it's a 404 from S3, the key is wrong
        if (error.name === 'NoSuchKey') {
            return res.status(404).json({ error: "File does not exist in bucket", key: "check logs" });
        }
        if (error.name === 'AccessDenied') {
            return res.status(403).json({ error: "Access denied to bucket" });
        }

        res.status(500).json({ error: "Streaming failed", details: error.message });
    }
};

// --- PUBLIC ROUTES (No Auth Required) ---

// Get public project info for viral sharing
export const getPublicProject = async (req, res) => {
    try {
        const { id } = req.params;

        const project = await prisma.project.findUnique({
            where: { id },
            select: {
                id: true,
                title: true,
                state: true,
                qualityTier: true,
                createdAt: true,
                description: true
            }
        });

        if (!project) {
            return res.status(404).json({ error: "Film not found" });
        }

        // Only expose completed films publicly
        if (project.state !== 'COMPLETE') {
            return res.status(404).json({ error: "Film not found or still processing" });
        }

        res.json(project);
    } catch (error) {
        console.error('[PublicProject] Error:', error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

// Stream video for public shares (no auth required, only completed films)
export const streamPublicVideo = async (req, res) => {
    const { id } = req.params;
    try {
        console.log('[PublicStream] Request for project:', id);

        // Find project without user check
        const project = await prisma.project.findUnique({
            where: { id }
        });

        if (!project) {
            console.error('[PublicStream] Project not found:', id);
            return res.status(404).json({ error: "Film not found" });
        }

        // Security: Only allow streaming of COMPLETE films publicly
        if (project.state !== 'COMPLETE') {
            console.log('[PublicStream] Film not complete, denying access');
            return res.status(401).json({ error: "This film is not yet available for public viewing" });
        }

        if (!project.finalVideoUrl) {
            return res.status(404).json({ error: "Video not yet available" });
        }

        console.log('[PublicStream] Streaming public film:', project.title);

        // Extract key from URL
        let key;
        try {
            const urlObj = new URL(project.finalVideoUrl);
            key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
        } catch (urlError) {
            key = project.finalVideoUrl;
        }

        const { bucket } = getStorageConfig();
        const client = getS3Client();
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key
        });

        const response = await client.send(command);
        console.log('[PublicStream] S3 response, ContentLength:', response.ContentLength);

        // Set video headers
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

        if (response.ContentLength) {
            res.setHeader('Content-Length', response.ContentLength);
        }

        response.Body.pipe(res);

        response.Body.on('error', (err) => {
            console.error("[PublicStream] Stream error:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Stream failed" });
            }
        });

    } catch (error) {
        console.error("[PublicStream] Error:", error.message);
        if (error.name === 'NoSuchKey') {
            return res.status(404).json({ error: "File not found" });
        }
        res.status(500).json({ error: "Streaming failed" });
    }
};
