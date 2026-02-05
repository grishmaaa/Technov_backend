import prisma from '../config/database.js';
import { generateScript, generateCharacterPortrait, generateHeroImage, generateTitle } from '../services/geminiService.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { logger } from '../logger.js';
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

        // Use Advanced 3-Stage Gemini Pipeline
        const result = await generateScript(story, {
            productionStyle: visualStyle, // Map visualStyle to options
            plan: req.user?.plan || 'basic'
        });

        // result contains: scenes, suggested_title, assetSheet, validationReport

        let aiTitle = result.suggested_title;
        // Fallback if not returned
        if (!aiTitle) {
            aiTitle = await generateTitle(story);
        }

        if (projectId) {
            const existingProject = await prisma.project.findFirst({
                where: { id: projectId, userId: req.user.id }
            });

            if (!existingProject) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Save Asset Sheet to Project Metadata
            // Merge with existing metadata to avoid data loss
            const existingMetadata = existingProject.metadata || {};
            const updatedMetadata = {
                ...existingMetadata,
                assetSheet: result.assetSheet
            };

            await prisma.project.update({
                where: { id: projectId },
                data: {
                    title: aiTitle || undefined,
                    metadata: updatedMetadata
                }
            });

            await transitionProjectState({
                projectId,
                toState: 'SCENES_GENERATED',
                actorType: 'system',
                actorId: req.user.id,
                reason: 'Scenes generated via 3-stage pipeline'
            });
        }

        res.json({
            scenes: result.scenes,
            assetSheet: result.assetSheet,
            title: aiTitle,
            validationReport: result.validationReport
        });
    } catch (error) {
        // Handle Safety Violations gracefully
        if (error.message.includes("SAFETY_VIOLATION")) {
            return res.status(400).json({ error: error.message });
        }
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

        // IMPROVED LOGIC: Check the Asset Sheet first
        const assetSheet = project.metadata?.assetSheet;
        const bible = assetSheet?.character_bible || [];
        const objects = assetSheet?.object_bible || [];

        // Debug Log
        logger.info({
            projectId: id,
            bibleCount: bible.length,
            objectCount: objects.length,
            metadataKeys: Object.keys(project.metadata || {})
        }, "🔍 Visual Identity Decision Debug");

        // 1. Check Character Bible
        let needsHero = Array.isArray(bible) && bible.length > 0;
        let reason = needsHero
            ? `Identified ${bible.length} characters in the Bible.`
            : 'No characters in Bible.';

        // 2. Check Object Bible for "Living" things (Aliens, Robots, etc.)
        if (!needsHero && Array.isArray(objects) && objects.length > 0) {
            const livingKeywords = ['alien', 'robot', 'droid', 'creature', 'monster', 'being', 'entity', 'character', 'protagonist'];
            const livingObjects = objects.filter(obj => {
                const text = `${obj.name} ${obj.description}`.toLowerCase();
                return livingKeywords.some(kw => text.includes(kw));
            });

            if (livingObjects.length > 0) {
                needsHero = true;
                reason = `Found ${livingObjects.length} creature/character-like objects (e.g. ${livingObjects[0].name}).`;
            }
        }

        // 3. Fallback: Keyword Search in Scenes (ignoring if asset sheet exists or not, just double check)
        if (!needsHero) {
            const hasKeywords = requiresHeroAssets(project.scenes);
            // Also check for "alien" explicitly since it might be missing from HERO_KEYWORDS
            const hasAlien = project.scenes.some(s => (s.promptText || '').toLowerCase().includes('alien'));

            if (hasKeywords || hasAlien) {
                needsHero = true;
                reason = 'Detected character/creature keywords in scenes (Fallback).';
            }
        }

        logger.info({ needsHero, reason }, "✅ Visual Decision Result");

        const updatedProject = await prisma.project.update({
            where: { id },
            data: {
                requiresHeroAssets: needsHero,
                visualIdentityReason: reason,
                // If we have characters, ensure they are in the assets table? 
                // typically generateProjectAssets handles creation. 
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

        // 4. PREPARE CHARACTER DATA FOR FRONTEND
        // The frontend requires `characters` array in the response to show Slide 2
        let characters = [];
        if (needsHero) {
            const rawCharacters = [...bible];
            // If we found living objects but no bible characters, likely aliens/creatures
            if (rawCharacters.length === 0 && objects.length > 0) {
                const livingKeywords = ['alien', 'robot', 'droid', 'creature', 'monster', 'being', 'entity', 'character', 'protagonist'];
                const livingObjects = objects.filter(obj => {
                    const text = `${obj.name} ${obj.description}`.toLowerCase();
                    return livingKeywords.some(kw => text.includes(kw));
                });
                // Treat these objects as characters
                rawCharacters.push(...livingObjects);
            }

            characters = rawCharacters.map((c, index) => ({
                id: c.id || `temp-${index}-${Date.now()}`, // Fallback ID if not in DB
                name: c.name || "Unknown Character",
                description: c.description || c.visual_prompt || "No description",
                imageUrl: c.image_url || null // Should be null initially
            }));
        }

        res.json({
            requiresHeroAssets: needsHero,
            reason,
            project: updatedProject,
            characters: characters // CRITICAL: Frontend checks this!
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Replaces generateHeroAssets
export const generateProjectAssets = async (req, res) => {
    try {
        const { id } = req.params;
        const { regenerate, characterId, userPrompt, imageUrl } = req.body;

        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { assets: true }
        });

        if (!project) return res.status(404).json({ error: 'Project not found' });

        const assetSheet = project.metadata?.assetSheet;
        if (!assetSheet || !assetSheet.character_bible) {
            return res.status(400).json({ error: 'Reference Asset Sheet not found. Please regenerate script.' });
        }

        // 1. Handle User Upload (Direct URL save)
        if (imageUrl && characterId) {
            const charDef = assetSheet.character_bible.find(c => c.id === characterId);
            if (!charDef) return res.status(404).json({ error: 'Character ID not found in bible' });

            // Create or Update asset
            // Note: In a real app we might want to delete the old asset file if it exists
            await prisma.asset.create({
                data: {
                    projectId: id,
                    type: 'CHARACTER',
                    state: 'READY',
                    url: imageUrl, // Assumes frontend uploaded and sent URL, or we handle upload separately
                    metadata: JSON.stringify({
                        characterId: charDef.id,
                        role: charDef.role,
                        name: charDef.id,
                        description: charDef.physical_description?.distinctive_features?.join(', ') || "Custom Upload",
                        source: 'upload'
                    })
                }
            });
            return res.json({ message: "Asset uploaded" });
        }

        // 2. Handle Regeneration (Single Character)
        if (regenerate && characterId) {
            const charDef = assetSheet.character_bible.find(c => c.id === characterId);
            if (!charDef) return res.status(404).json({ error: 'Character ID not found in bible' });

            const style = assetSheet.tone_and_style?.film_reference || "Cinematic";
            // Pass userPrompt to influence generation
            const portraitUrl = await generateCharacterPortrait(
                JSON.stringify(charDef.physical_description),
                style,
                userPrompt
            );

            const asset = await prisma.asset.create({
                data: {
                    projectId: id,
                    type: 'CHARACTER',
                    state: 'READY',
                    url: portraitUrl,
                    metadata: JSON.stringify({
                        characterId: charDef.id,
                        role: charDef.role,
                        name: charDef.id, // Use ID as name or add name field
                        description: charDef.physical_description?.distinctive_features?.join(', ') || "AI Generated",
                        source: 'regen'
                    })
                }
            });

            if (asset.url) asset.url = await signUrl(asset.url);
            return res.json({ asset });
        }

        // 3. Initial Bulk Generation (All Characters)
        // Only generate for characters that don't have an asset yet
        const results = [];
        const characters = assetSheet.character_bible; // Array of chars
        // Limit based on plan?
        const maxChars = (req.user?.plan === 'elite') ? 6 : 3;
        const targetChars = characters.slice(0, maxChars);

        for (const charDef of targetChars) {
            // Check if asset exists
            const existing = project.assets.find(a => {
                try {
                    const meta = JSON.parse(a.metadata || '{}');
                    return meta.characterId === charDef.id;
                } catch (e) { return false; }
            });

            if (existing) {
                results.push(existing);
                continue;
            }

            const style = assetSheet.tone_and_style?.film_reference || "Cinematic";
            const portraitUrl = await generateCharacterPortrait(JSON.stringify(charDef.physical_description), style);

            const asset = await prisma.asset.create({
                data: {
                    projectId: id,
                    type: 'CHARACTER',
                    state: 'READY',
                    url: portraitUrl,
                    metadata: JSON.stringify({
                        characterId: charDef.id,
                        role: charDef.role,
                        name: charDef.id,
                        description: charDef.physical_description?.distinctive_features?.join(', ') || "AI Generated",
                        source: 'initial'
                    })
                }
            });
            results.push(asset);
        }

        await transitionProjectState({
            projectId: id,
            toState: 'ASSETS_READY',
            actorType: 'system',
            actorId: req.user.id,
            reason: 'Character assets generated'
        });

        // Sign URLs
        for (let asset of results) {
            if (asset.url) asset.url = await signUrl(asset.url);
        }

        res.json({ assets: results });
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

        // Check for format override (Frontend fallback logic)
        const formatOverride = req.query.format;

        // Extract key correctly
        let key;
        try {
            // If fallback requested, prefer the MP4 metadata or replace extension
            let sourceUrl = project.finalVideoUrl;
            if (formatOverride === 'mp4') {
                if (project.metadata?.mp4) {
                    sourceUrl = project.metadata.mp4;
                    console.log('[Stream] Format override: switching to MP4 metadata');
                } else if (sourceUrl.endsWith('.m3u8')) {
                    sourceUrl = sourceUrl.replace('.m3u8', '.mp4').replace('/hls/', '/'); // Try standard conversion
                    console.log('[Stream] Format override: heuristic replacement to .mp4');
                }
            }

            const urlObj = new URL(sourceUrl);
            key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
        } catch (urlError) {
            console.log('[Stream] URL parsing failed, using as key directly');
            key = project.finalVideoUrl;
        }

        // If this is a segment request, replace the filename in the key
        if (req.params.segment) {
            const segmentFile = req.params.segment; // e.g., segment000.ts
            // key is like "hls/UUID/playlist.m3u8"
            // we want "hls/UUID/segment000.ts"
            const directory = key.substring(0, key.lastIndexOf('/'));
            key = `${directory}/${segmentFile}`;
            console.log('[Stream] Serving segment:', key);
        }

        const { bucket } = getStorageConfig();
        // console.log('[Stream] Attempting to fetch key:', key, 'from bucket:', bucket);

        const client = getS3Client();
        const commandParams = {
            Bucket: bucket,
            Key: key,
            Range: req.headers.range, // Forward Range requests (e.g. bytes=0-1024)
            IfNoneMatch: req.headers['if-none-match'] // Forward ETag validation
        };

        const command = new GetObjectCommand(commandParams);

        try {
            const response = await client.send(command);

            // Log for debugging
            // console.log('[Stream] S3 Status:', response.$metadata.httpStatusCode, 'Length:', response.ContentLength);

            // Crucial Headers for Chrome/Firefox
            const isHls = key.endsWith('.m3u8') || key.endsWith('.ts');
            const contentType = key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' :
                key.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';

            res.setHeader('Content-Type', contentType);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Disposition', 'inline');

            // CACHING STRATEGY
            if (key.endsWith('.ts')) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else if (key.endsWith('.m3u8')) {
                res.setHeader('Cache-Control', 'public, max-age=60');
            } else {
                res.setHeader('Cache-Control', 'public, max-age=3600');
            }

            // Forward S3 headers
            if (response.ETag) res.setHeader('ETag', response.ETag);
            if (response.LastModified) res.setHeader('Last-Modified', response.LastModified.toUTCString());
            if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength);
            if (response.ContentRange) {
                res.setHeader('Content-Range', response.ContentRange);
                res.status(206); // Partial Content
            }

            // AWS SDK v3 response.Body is a readable stream in Node.js
            response.Body.pipe(res);

            response.Body.on('error', (err) => {
                console.error("[Stream] Stream pipe error:", err);
                if (!res.headersSent) {
                    res.status(500).json({ error: "Stream failed" });
                }
            });

        } catch (s3Error) {
            // Handle 304 Not Modified (S3 throws this if IfNoneMatch matches)
            if (s3Error.$metadata && s3Error.$metadata.httpStatusCode === 304) {
                return res.status(304).end();
            }
            throw s3Error;
        }

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
