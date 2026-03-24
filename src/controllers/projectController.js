import prisma from '../config/database.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { logger } from '../logger.js';
import { getPresignedDownloadUrl, getStorageConfig, extractKeyFromUrl, isStorageConfigured } from '../services/storageService.js';
import { generateCharacterPortrait, generateCharacterPortraitSeries } from '../services/falService.js';
import { generateVisualPrompt } from '../services/llmService.js';

// --- SHARED HELPERS ---

// Helper to turn a raw DB URL into a Signed Playable URL
const signUrl = async (rawUrl) => {
    if (!rawUrl) return rawUrl;
    // If it's already a http(s) URL but NOT on our storage, it might be a temporary DALL-E link.
    // DALL-E links are already public and expire. If it's an S3 link, we MUST sign it.
    if (!rawUrl.includes('storage.railway.app') && !rawUrl.includes('s3.amazonaws.com') && rawUrl.startsWith('http')) {
        return rawUrl;
    }

    try {
        const key = extractKeyFromUrl(rawUrl);
        if (!key) return rawUrl;
        return await getPresignedDownloadUrl({ key, expiresIn: 3600 });
    } catch (err) {
        logger.error({ err, rawUrl }, "[Signer] Signing failed");
        return rawUrl;
    }
};

// Helper to find or synthesize charDef
const getCharDef = (assetSheet, id) => {
    const found = assetSheet?.character_bible?.find(c => c.id === id);
    if (found) return found;

    // Fallback for scraped characters (e.g. "detective_noir")
    return {
        id: id,
        role: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        name: id,
        physical_description: {
            distinctive_features: ["Character identified from script context"]
        },
        isFallback: true
    };
};

// Helper to build natural language description for DALL-E
const buildCharPrompt = (charDef) => {
    const phys = charDef.physical_description || {};
    const parts = [
        charDef.role ? `Role: ${charDef.role} ` : '',
        charDef.age ? `Age: ${charDef.age} ` : '',
        charDef.gender ? `Gender: ${charDef.gender} ` : '',
        charDef.ethnicity ? `Ethnicity: ${charDef.ethnicity} ` : '',
        phys.height ? `Height: ${phys.height} ` : '',
        phys.build ? `Build: ${phys.build} ` : '',
        phys.hair ? `Hair: ${phys.hair} ` : '',
        phys.eyes ? `Eyes: ${phys.eyes} ` : '',
        phys.skin_tone ? `Skin: ${phys.skin_tone} ` : '',
        phys.clothing ? `Clothing: ${phys.clothing} ` : '',
        (phys.distinctive_features && phys.distinctive_features.length > 0)
            ? `Distinctive features: ${phys.distinctive_features.join(', ')} `
            : ''
    ];
    // If fallback with no details, use name (role) as prompt
    if (parts.every(p => !p) && charDef.role) {
        return `A cinematic portrait of ${charDef.role} `;
    }
    return parts.filter(p => p && p.trim() !== '').join('. ');
};

export const createProject = async (req, res) => {
    try {
        const { title, description, qualityTier, aspectRatio, fps } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }

        if (!req.user || !req.user.id) {
            console.error("[ProjectController] Unauthorized: req.user.id is missing");
            return res.status(401).json({ error: 'Unauthorized: No user ID found' });
        }

        // --- FREE PLAN RESTRICTION ---
        if (req.user.plan === 'free') {
            const projectCount = await prisma.project.count({
                where: { userId: req.user.id }
            });

            if (projectCount >= 1) {
                console.warn(`[ProjectController] Free user ${req.user.id} blocked: Project limit reached (1)`);
                return res.status(403).json({
                    error: 'Free plan limit reached',
                    details: 'Free accounts are limited to 1 visual preview. Please upgrade to create more projects.'
                });
            }
        }

        console.log(`[ProjectController] Creating project "${title}" for user ${req.user.id}`);

        const project = await prisma.project.create({
            data: {
                title,
                description: description || null,
                userId: req.user.id,
                qualityTier: qualityTier || "cinematic",
                aspectRatio: aspectRatio || "16:9",
                fps: fps || 24,
                state: "CREATED",
                renderProgress: 0
            }
        });

        console.log(`[ProjectController] Project created successfully: ${project.id}`);
        res.status(201).json(project);
    } catch (error) {
        console.error("[ProjectController] Failed to create project. Full error:", error);

        // Check for specific Prisma errors
        if (error.code === 'P2002') {
            return res.status(400).json({ error: 'A project with this title already exists' });
        }

        res.status(500).json({
            error: 'Failed to create project',
            details: error.message,
            code: error.code
        });
    }
};

export const getProjects = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        console.log(`[ProjectController] Fetching projects for user ${req.user.id}`);

        const projects = await prisma.project.findMany({
            where: { userId: req.user.id },
            include: {
                scenes: {
                    take: 1,
                    orderBy: { orderIndex: 'asc' }
                },
                _count: {
                    select: { scenes: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(projects);
    } catch (error) {
        console.error("[ProjectController] Failed to fetch projects:", error);
        res.status(500).json({ error: 'Failed to fetch projects', details: error.message });
    }
};

export const getProject = async (req, res) => {
    try {
        const { id } = req.params;

        const project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: {
                scenes: { orderBy: { orderIndex: 'asc' } },
                characters: true,
                assets: true
            }
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // SIGN THE FINAL VIDEO
        if (project.finalVideoUrl) {
            // We use direct MP4 URLs now, no HLS fallback needed
            let urlToSign = project.metadata?.mp4_url || project.finalVideoUrl;
            project.finalVideoUrl = await signUrl(urlToSign);
        }

        // SIGN THE SCENE VIDEOS
        for (let scene of project.scenes) {
            if (scene.videoUrl) {
                scene.videoUrl = await signUrl(scene.videoUrl);
            }
        }

        // SIGN CHARACTER PORTRAITS
        if (project.characters) {
            for (let char of project.characters) {
                if (char.portraitUrl) {
                    char.portraitUrl = await signUrl(char.portraitUrl);
                }
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

        // MAP RECORD FIELDS TO FRONTEND UI FIELDS
        if (project.scenes) {
            project.scenes = project.scenes.map((s, i) => ({
                ...s,
                sceneNumber: s.orderIndex !== undefined ? s.orderIndex + 1 : i + 1,
                title: `Clip ${s.orderIndex !== undefined ? s.orderIndex + 1 : i + 1} `,
                description: s.actionDescription || '',
                prompt: s.promptText || '',
            }));
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
            let urlToSign = project.metadata?.mp4_url || project.finalVideoUrl;
            project.finalVideoUrl = await signUrl(urlToSign);
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

        // MAP RECORD FIELDS TO FRONTEND UI FIELDS
        if (project.scenes) {
            project.scenes = project.scenes.map((s, i) => ({
                ...s,
                sceneNumber: s.orderIndex !== undefined ? s.orderIndex + 1 : i + 1,
                title: `Clip ${s.orderIndex !== undefined ? s.orderIndex + 1 : i + 1} `,
                description: s.actionDescription || '',
                prompt: s.promptText || '',
            }));
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
        const text = `${scene.promptText || ''} ${scene.actionDescription || ''} `.toLowerCase();
        return HERO_KEYWORDS.some((keyword) => text.includes(keyword));
    });
};

export const decideVisualIdentity = async (req, res) => {
    try {
        const { id } = req.params;
        let project = await prisma.project.findFirst({
            where: { id, userId: req.user.id },
            include: { scenes: true, assets: true } // Include assets here
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.state !== 'VISUAL_IDENTITY_DECISION') {
            return res.status(400).json({ error: 'Project not ready for visual identity decision' });
        }

        // IMPROVED LOGIC: Check the Asset Sheet first
        // Handle BOTH storage formats: nested (metadata.assetSheet) and flat (metadata IS the assetSheet)
        let assetSheet = project.metadata?.assetSheet;
        if (!assetSheet && project.metadata?.character_bible) {
            // Metadata was saved as assetSheet directly (flat structure)
            assetSheet = project.metadata;
        }
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
                const text = `${obj.name} ${obj.description} `.toLowerCase();
                return livingKeywords.some(kw => text.includes(kw));
            });

            if (livingObjects.length > 0) {
                needsHero = true;
                reason = `Found ${livingObjects.length} creature / character - like objects(e.g.${livingObjects[0].name}).`;
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
        } else {
            // AUTO-GENERATE CAST: Ensure the user sees the full cast immediately
            const charAssets = project.assets?.filter(a => a.type === 'CHARACTER' && a.state === 'READY') || [];

            if (charAssets.length === 0 && bible.length > 0) {
                logger.info({ projectId: id, castCount: bible.length }, "🎬 Auto-generating full cast portraits...");

                // Generate up to 4 characters automatically to keep it snappy
                const castToGenerate = bible.slice(0, 4);
                const style = assetSheet?.tone_and_style?.film_reference || "Cinematic";

                // Generate in parallel to stay within request timeouts
                await Promise.all(castToGenerate.map(async (char) => {
                    try {
                        const description = buildCharPrompt(char);
                        
                        // 1. Generate optimized prompt via LLM
                        const visualPrompt = await generateVisualPrompt(
                            'CHARACTER_PORTRAIT', 
                            char, 
                            style,
                            'flux-dev'
                        );

                        // 2. CHECK: If the AI decided to "IGNORE" the character, mark it so it doesn't show in UX
                        if (visualPrompt.trim().toUpperCase() === 'IGNORE') {
                            logger.info({ charId: char.id }, 'Marking character as IGNORED (Faceless/Background)');
                            await prisma.asset.create({
                                data: {
                                    projectId: id,
                                    type: 'CHARACTER',
                                    state: 'IGNORED',
                                    metadata: JSON.stringify({
                                        characterId: char.id,
                                        role: char.role,
                                        name: char.role,
                                        source: 'auto-initial-cast'
                                    })
                                }
                            });
                            return;
                        }

                        const portraitSeries = await generateCharacterPortraitSeries(visualPrompt, style);
                        const frontal = portraitSeries.find(s => s.view === 'front') || portraitSeries[0];

                        if (portraitSeries && portraitSeries.length > 0) {
                            await Promise.all(portraitSeries.map(async (shot) => {
                                await prisma.asset.create({
                                    data: {
                                        projectId: id,
                                        type: 'CHARACTER',
                                        state: 'READY',
                                        url: shot.url,
                                        metadata: JSON.stringify({
                                            characterId: char.id,
                                            role: char.role,
                                            name: char.role,
                                            description: description || "Auto Generated",
                                            source: 'auto-initial-cast',
                                            view: shot.view
                                        })
                                    }
                                });
                            }));

                            // Although we save assets, we might want a primary one for the Character summary UI?
                            // Currently Character table is not updated here, but the Asset table is the source of truth for UI.
                        }
                    } catch (genErr) {
                        logger.error({ err: genErr, charId: char.id }, "Auto-generation of character failed");
                    }
                }));

                logger.info("✅ Full cast auto-generated successfully");

                // CRITICAL: Refresh project to include the new character assets we just created
                project = await prisma.project.findUnique({
                    where: { id },
                    include: {
                        assets: true,
                        scenes: { orderBy: { orderIndex: 'asc' } }
                    }
                });
            }
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
                    const text = `${obj.name} ${obj.description} `.toLowerCase();
                    return livingKeywords.some(kw => text.includes(kw));
                });
                // Treat these objects as characters
                rawCharacters.push(...livingObjects);
            }

            // ✅ FIX: Correct mapping for character_bible structure
            characters = (await Promise.all(rawCharacters.map(async (c, index) => {
                // Check if an image already exists for this character
                const existingAsset = project.assets?.find(a => {
                    try {
                        const meta = JSON.parse(a.metadata || '{}');
                        return meta.characterId === c.id && a.type === 'CHARACTER';
                    } catch (e) {
                        return false;
                    }
                });

                // 🟢 NEW: Hide IGNORED characters from the Casting/Portrait UI entirely
                // Checks both the asset-level IGNORE and the script-level is_visual_lead flag
                const isFacelessVibe = (c.role + (c.description || '')).toLowerCase().includes('faceless') || 
                                     (c.role + (c.description || '')).toLowerCase().includes('never seen') ||
                                     (c.role + (c.description || '')).toLowerCase().includes('helmeted');
                
                if (existingAsset?.state === 'IGNORED' || c.is_visual_lead === false || (c.is_visual_lead === undefined && isFacelessVibe)) {
                    return null;
                }

                // Build description from physical_description object
                let description = "No description available";
                if (c.physical_description) {
                    const parts = [];

                    if (c.age) parts.push(`${c.age} years old`);
                    if (c.gender) parts.push(c.gender);
                    if (c.ethnicity) parts.push(c.ethnicity);
                    if (c.physical_description.height) parts.push(`${c.physical_description.height} tall`);
                    if (c.physical_description.build) parts.push(`${c.physical_description.build} build`);
                    if (c.physical_description.hair) parts.push(`${c.physical_description.hair} hair`);
                    if (c.physical_description.eyes) parts.push(`${c.physical_description.eyes} eyes`);
                    if (c.physical_description.skin_tone) parts.push(`${c.physical_description.skin_tone} skin`);

                    if (c.physical_description.distinctive_features && Array.isArray(c.physical_description.distinctive_features)) {
                        parts.push(`Features: ${c.physical_description.distinctive_features.join(', ')} `);
                    }

                    description = parts.join('. ');
                } else if (c.description) {
                    description = c.description;
                }

                let imageUrl = existingAsset ? existingAsset.url : (c.image_url || null);
                if (imageUrl) {
                    imageUrl = await signUrl(imageUrl);
                }

                return {
                    id: c.id || `temp - ${index} -${Date.now()} `,
                    name: c.role || c.name || "Unknown Character",
                    description: description,
                    imageUrl: imageUrl,
                    approved: !!(existingAsset && existingAsset.state === 'READY'),
                    role: c.role
                };
            }))).filter(Boolean); // Filter out the nulls (ignored characters)

            // SCENE SCRAPING FALLBACK: If bible and objects fail, check scene consistency data
            if (characters.length === 0) {
                const uniqueCharIds = new Set();
                project.scenes.forEach(scene => {
                    const consistency = scene.consistency_check || {};
                    if (Array.isArray(consistency.character_ids)) {
                        consistency.character_ids.forEach(id => uniqueCharIds.add(id));
                    }
                });

                if (uniqueCharIds.size > 0) {
                    characters = Array.from(uniqueCharIds).map((charId, index) => ({
                        id: charId, // Use the ID from the scene
                        name: charId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), // "detective_noir" -> "Detective Noir"
                        description: "Identified in script. Please generate visual reference.",
                        imageUrl: null,
                        approved: false,
                        role: charId // Use ID as role
                    }));
                }
            }

            // FINAL FALLBACK: Keyword detection if absolutely nothing else found
            if (characters.length === 0) {
                const keywordMatch = project.scenes.find(s =>
                    (s.promptText || '').toLowerCase().includes('alien') ||
                    (s.promptText || '').toLowerCase().includes('creature')
                );

                // Only add this if we are SURE we need heroes but found none
                if (needsHero) {
                    characters.push({
                        id: `fallback - ${Date.now()} `,
                        name: keywordMatch ? "Detected Creature/Alien" : "Unknown Protagonist",
                        description: "Automatically detected from story context. Please generate a reference image.",
                        imageUrl: null,
                        approved: false
                    });
                }
            }
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

        // Handle BOTH storage formats (nested or flat)
        let assetSheet = project.metadata?.assetSheet;
        if (!assetSheet && project.metadata?.character_bible) {
            assetSheet = project.metadata;
        }
        if (!assetSheet) {
            return res.status(400).json({ error: 'Reference Asset Sheet not found. Please regenerate script.' });
        }

        // 1. Handle User Upload (Direct URL save)
        if (imageUrl && characterId) {
            const charDef = getCharDef(assetSheet, characterId); // Use top-level getCharDef
            // No 404 check needed because getCharDef always returns something for fallback

            // Create or Update asset
            await prisma.asset.create({
                data: {
                    projectId: id,
                    type: 'CHARACTER',
                    state: 'READY',
                    url: imageUrl,
                    metadata: JSON.stringify({
                        characterId: charDef.id,
                        role: charDef.role,
                        name: charDef.role, // Use role/name we derived
                        description: charDef.physical_description?.distinctive_features?.join(', ') || "Custom Upload",
                        source: 'upload'
                    })
                }
            });
            return res.json({ message: "Asset uploaded" });
        }

        // 2. Handle Regeneration (Single Character)
        if (regenerate && characterId) {
            const charDef = getCharDef(assetSheet, characterId); // Use top-level getCharDef

            const style = assetSheet.tone_and_style?.film_reference || "Cinematic";
            // Pass userPrompt to influence generation
            const description = buildCharPrompt(charDef);

            // 1. Generate optimized prompt via LLM
            const visualPrompt = await generateVisualPrompt(
                'CHARACTER_PORTRAIT', 
                { ...charDef, user_request: userPrompt }, 
                style,
                'flux-dev'
            );

            // 2. CHECK: If the AI decided to "IGNORE" the character, skip generation
            if (visualPrompt.trim().toUpperCase() === 'IGNORE') {
                logger.info({ charId: charDef.id }, 'Skipping character regeneration (Faceless/Background)');
                return res.status(422).json({ error: 'Character is faceless/obscured and cannot be visually generated.' });
            }

            const portraitSeries = await generateCharacterPortraitSeries(
                visualPrompt,
                style,
                {}, // options
                userPrompt
            );

            const frontal = portraitSeries.find(s => s.view === 'front') || portraitSeries[0];

            // Cleanup old assets
            const oldAssets = project.assets.filter(a => {
                try {
                    const meta = JSON.parse(a.metadata || '{}');
                    return a.type === 'CHARACTER' && meta.characterId === charDef.id;
                } catch(e) { return false; }
            });

            if (oldAssets.length > 0) {
                await prisma.asset.deleteMany({
                    where: { id: { in: oldAssets.map(a => a.id) } }
                });
            }

            await Promise.all(portraitSeries.map(async (shot) => {
                await prisma.asset.create({
                    data: {
                        projectId: id,
                        type: 'CHARACTER',
                        state: 'READY',
                        url: shot.url,
                        metadata: JSON.stringify({
                            characterId: charDef.id,
                            role: charDef.role,
                            name: charDef.role,
                            description: description || "AI Generated from Script ID",
                            source: 'regen',
                            view: shot.view
                        })
                    }
                });
            }));

            // Return the frontal asset for the UI
            const asset = await prisma.asset.findFirst({
                where: { 
                    projectId: id, 
                    type: 'CHARACTER',
                    url: frontal.url
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
            // 🟢 Skip generation for background characters immediately
            if (charDef.is_visual_lead === false) {
                logger.info({ charId: charDef.id }, 'Skipping background character in generation loop');
                continue;
            }

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
            const description = buildCharPrompt(charDef);
            
            // 1. Generate optimized prompt via LLM
            const visualPrompt = await generateVisualPrompt(
                'CHARACTER_PORTRAIT', 
                charDef, 
                style,
                'flux-dev'
            );

            // 2. CHECK: If the AI decided to "IGNORE" the character, mark and skip
            if (visualPrompt.trim().toUpperCase() === 'IGNORE') {
                logger.info({ charId: charDef.id }, 'Marking character as IGNORED (Faceless/Background)');
                await prisma.asset.create({
                    data: {
                        projectId: id,
                        type: 'CHARACTER',
                        state: 'IGNORED',
                        metadata: JSON.stringify({
                            characterId: charDef.id,
                            role: charDef.role,
                            name: charDef.id,
                            source: 'initial'
                        })
                    }
                });
                continue; // Move to the next character
            }

            const portraitResult = await generateCharacterPortrait(visualPrompt);

            const asset = await prisma.asset.create({
                data: {
                    projectId: id,
                    type: 'CHARACTER',
                    state: 'READY',
                    url: portraitResult.url,
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

        // Favor MP4 for downloads and shares to ensure maximum compatibility
        let sourceUrl = project.finalVideoUrl;
        if (project.metadata?.mp4_url) {
            sourceUrl = project.metadata.mp4_url;
        }

        // Extract key from the selected URL
        const urlObj = new URL(sourceUrl);
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
