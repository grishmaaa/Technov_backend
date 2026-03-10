/**
 * pipelineController.js
 * 
 * New controller for the 7-stage pipeline.
 * Handles all the stage transitions from script generation through storyboard approval.
 * Each function corresponds to a user action in the studio dashboard.
 */

import prisma from '../config/database.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { getTierConfig, calculateCreditCost } from '../config/modelConfig.js';
import { generateStructuredOutput, safetyCheck, editScene } from '../services/llmService.js';
import { generateCharacterPortrait, generateStoryboardFrame } from '../services/falService.js';
import { logger } from '../logger.js';

// ============================================================
// STAGE 1: Cinematic Translation (Script Generation)
// ============================================================

/**
 * POST /api/projects/:id/generate-script
 * Takes user story → generates cinematic scene document via Gemini.
 */
export const generateScript = async (req, res) => {
    try {
        const { id } = req.params;
        const { story, visualStyle, length } = req.body;

        if (!story || story.trim().length < 10) {
            return res.status(400).json({ error: 'Story must be at least 10 characters' });
        }

        const userPlan = req.user?.plan || 'free';
        const tierConfig = getTierConfig(userPlan);

        // Safety check
        const safety = await safetyCheck(story, tierConfig.safety);
        if (safety.severity === 'BLOCK') {
            return res.status(422).json({
                error: 'Content blocked by safety filters',
                violations: safety.violations,
                suggestion: safety.suggested_alternative,
            });
        }

        // Duration constraints
        let requestedSeconds = 8;
        if (length === '60s') requestedSeconds = 60;
        else if (length === '30s') requestedSeconds = 30;
        const finalDuration = Math.min(requestedSeconds, tierConfig.maxDuration);

        // Get or create project
        let project = await prisma.project.findUnique({ where: { id } });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Generate cinematic scene document
        const systemPrompt = `You are a master cinematographer and screenwriter. 
Convert the user's story into a cinematic scene-by-scene breakdown. 
Think in shots: camera angle, lighting, motion, mood, sound design.
Write in director language — clear, visual, evocative. NOT AI prompt language.
Total target duration: ${finalDuration} seconds. Split into ${Math.ceil(finalDuration / 8)} scenes of ~8s each.
Visual style: ${visualStyle || 'cinematic'}.`;

        const sceneSchema = {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING' },
                scenes: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            scene_number: { type: 'INTEGER' },
                            title: { type: 'STRING' },
                            description: { type: 'STRING' },
                            prompt: { type: 'STRING' },
                            duration: { type: 'INTEGER' },
                            camera: { type: 'STRING' },
                            lighting: { type: 'STRING' },
                            mood: { type: 'STRING' },
                            audio: { type: 'STRING' },
                        },
                        required: ['scene_number', 'title', 'description', 'prompt', 'duration'],
                    },
                },
                characters: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            name: { type: 'STRING' },
                            role: { type: 'STRING' },
                            description: { type: 'STRING' },
                        },
                        required: ['name', 'role', 'description'],
                    },
                },
                asset_sheet: { type: 'OBJECT' },
            },
            required: ['title', 'scenes', 'characters'],
        };

        const { parsed, usage } = await generateStructuredOutput(
            systemPrompt,
            `Transform this story into a cinematic production:\n\n"${story}"`,
            sceneSchema,
            { model: tierConfig.llm.model, temperature: 0.8, maxTokens: 8192 },
        );

        if (!parsed?.scenes?.length) {
            throw new Error('AI failed to generate scenes');
        }

        // Save scenes to DB
        const scenes = await Promise.all(
            parsed.scenes.map((scene, index) =>
                prisma.scene.create({
                    data: {
                        projectId: id,
                        orderIndex: index,
                        promptText: scene.prompt,
                        actionDescription: scene.description,
                        duration: scene.duration || 8,
                        state: 'DRAFT',
                    },
                })
            )
        );

        // Create characters in DB for persistence
        if (parsed.characters?.length > 0) {
            await Promise.all(
                parsed.characters.map(char =>
                    prisma.character.create({
                        data: {
                            projectId: id,
                            name: char.name,
                            role: char.role,
                            description: char.description,
                            approved: false,
                        },
                    })
                )
            );
        }

        // Update project with title, story, and metadata
        await prisma.project.update({
            where: { id },
            data: {
                title: parsed.title || `Project ${new Date().toLocaleDateString()}`,
                story,
                metadata: {
                    asset_sheet: parsed.asset_sheet || {},
                    visual_style: visualStyle,
                    safety_check: safety,
                    llm_usage: usage,
                },
            },
        });

        // Transition state
        await transitionProjectState({
            projectId: id,
            toState: 'SCRIPT_GENERATED',
            actorType: 'SYSTEM',
            reason: `Script generated with ${tierConfig.llm.model}`,
        });

        res.json({
            title: parsed.title,
            scenes: scenes.map((s, i) => ({
                id: s.id,
                sceneNumber: i + 1,
                title: parsed.scenes[i].title,
                description: parsed.scenes[i].description,
                prompt: s.promptText,
                duration: s.duration,
                camera: parsed.scenes[i].camera,
                lighting: parsed.scenes[i].lighting,
                mood: parsed.scenes[i].mood,
                audio: parsed.scenes[i].audio,
                approved: false,
            })),
            characters: parsed.characters || [],
            usage,
        });
    } catch (error) {
        logger.error({ err: error }, 'Script generation failed');
        res.status(500).json({ error: 'Script generation failed', details: error.message });
    }
};

// ============================================================
// STAGE 2: Script Review Loop (Scene Editing & Approval)
// ============================================================

/**
 * POST /api/projects/:id/scenes/:sceneId/edit
 * Chat-style edit of a single scene. AI patches only that scene.
 */
export const editSceneEndpoint = async (req, res) => {
    try {
        const { id, sceneId } = req.params;
        const { instruction } = req.body;

        if (!instruction) {
            return res.status(400).json({ error: 'Edit instruction is required' });
        }

        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
        if (!scene || scene.projectId !== id) {
            return res.status(404).json({ error: 'Scene not found' });
        }

        // Get full script context
        const allScenes = await prisma.scene.findMany({
            where: { projectId: id },
            orderBy: { orderIndex: 'asc' },
        });
        const fullScript = allScenes.map(s => `Scene ${s.orderIndex + 1}: ${s.promptText}`).join('\n\n');

        // AI edit
        const result = await editScene(scene.promptText, instruction, fullScript, tierConfig.llmEdit);

        // Update scene
        const updated = await prisma.scene.update({
            where: { id: sceneId },
            data: {
                promptText: result.editedPrompt,
                actionDescription: result.editedDescription,
                approved: false, // Reset approval on edit
            },
        });

        res.json({
            scene: {
                id: updated.id,
                prompt: updated.promptText,
                description: updated.actionDescription,
                approved: false,
            },
            changesMade: result.changesMade,
        });
    } catch (error) {
        logger.error({ err: error }, 'Scene edit failed');
        res.status(500).json({ error: 'Scene edit failed', details: error.message });
    }
};

/**
 * POST /api/projects/:id/scenes/:sceneId/approve
 * Approve a single scene.
 */
export const approveScene = async (req, res) => {
    try {
        const { id, sceneId } = req.params;

        const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
        if (!scene || scene.projectId !== id) {
            return res.status(404).json({ error: 'Scene not found' });
        }

        const updated = await prisma.scene.update({
            where: { id: sceneId },
            data: { approved: true, approvedAt: new Date() },
        });

        res.json({ scene: { id: updated.id, approved: true } });
    } catch (error) {
        logger.error({ err: error }, 'Scene approval failed');
        res.status(500).json({ error: 'Scene approval failed' });
    }
};

/**
 * POST /api/projects/:id/scenes/approve-all
 * Approve all scenes and transition to SCRIPT_APPROVED.
 */
export const approveAllScenes = async (req, res) => {
    try {
        const { id } = req.params;

        const scenes = await prisma.scene.findMany({
            where: { projectId: id },
        });

        if (scenes.length === 0) {
            return res.status(400).json({ error: 'No scenes to approve' });
        }

        // Approve all
        await prisma.scene.updateMany({
            where: { projectId: id },
            data: { approved: true, approvedAt: new Date(), state: 'LOCKED' },
        });

        await transitionProjectState({
            projectId: id,
            toState: 'SCRIPT_APPROVED',
            actorType: 'USER',
            actorId: req.user?.id,
            reason: `All ${scenes.length} scenes approved`,
        });

        res.json({ message: `All ${scenes.length} scenes approved`, state: 'SCRIPT_APPROVED' });
    } catch (error) {
        logger.error({ err: error }, 'Approve all scenes failed');
        res.status(500).json({ error: 'Failed to approve scenes' });
    }
};

// ============================================================
// STAGE 3: Character Acceptance
// ============================================================

/**
 * POST /api/projects/:id/characters/generate
 * Extract characters from approved script and generate portraits.
 */
export const generateCharacters = async (req, res) => {
    try {
        const { id } = req.params;
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const project = await prisma.project.findUnique({
            where: { id },
            include: { scenes: true },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Extract characters from metadata (set during script generation)
        const characterData = project.metadata?.characters || [];

        if (characterData.length === 0) {
            // No characters — skip to storyboard
            await transitionProjectState({
                projectId: id,
                toState: 'CHARACTERS_APPROVED',
                actorType: 'SYSTEM',
                reason: 'No characters in script — skipping',
            });
            return res.json({ characters: [], message: 'No characters found, skipping to storyboard' });
        }

        // Generate portraits for each character
        const visualStyle = project.metadata?.visual_style || 'cinematic';
        const characters = [];

        for (const charData of characterData) {
            try {
                const portrait = await generateCharacterPortrait(
                    charData.description,
                    visualStyle,
                    tierConfig.image,
                );

                const character = await prisma.character.create({
                    data: {
                        projectId: id,
                        name: charData.name,
                        role: charData.role,
                        description: charData.description,
                        portraitUrl: portrait.url,
                        metadata: charData,
                    },
                });

                characters.push(character);
            } catch (charErr) {
                logger.error({ err: charErr, character: charData.name }, 'Character portrait generation failed');
                // Create character record without portrait
                const character = await prisma.character.create({
                    data: {
                        projectId: id,
                        name: charData.name,
                        role: charData.role,
                        description: charData.description,
                        metadata: charData,
                    },
                });
                characters.push(character);
            }
        }

        await transitionProjectState({
            projectId: id,
            toState: 'CHARACTERS_GENERATED',
            actorType: 'SYSTEM',
            reason: `Generated ${characters.length} characters`,
        });

        res.json({ characters });
    } catch (error) {
        logger.error({ err: error }, 'Character generation failed');
        res.status(500).json({ error: 'Character generation failed', details: error.message });
    }
};

/**
 * POST /api/projects/:id/characters/:charId/regenerate
 * Regenerate a single character portrait.
 */
export const regenerateCharacter = async (req, res) => {
    try {
        const { id, charId } = req.params;
        const { userPrompt } = req.body;
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const character = await prisma.character.findUnique({ where: { id: charId } });
        if (!character || character.projectId !== id) {
            return res.status(404).json({ error: 'Character not found' });
        }

        const project = await prisma.project.findUnique({ where: { id } });
        const visualStyle = project?.metadata?.visual_style || 'cinematic';

        const portrait = await generateCharacterPortrait(
            character.description,
            visualStyle,
            tierConfig.image,
            userPrompt,
        );

        const updated = await prisma.character.update({
            where: { id: charId },
            data: {
                portraitUrl: portrait.url,
                approved: false, // Reset approval on regen
            },
        });

        res.json({ character: updated });
    } catch (error) {
        logger.error({ err: error }, 'Character regeneration failed');
        res.status(500).json({ error: 'Character regeneration failed' });
    }
};

/**
 * POST /api/projects/:id/characters/:charId/upload
 * User uploads a reference photo for a character.
 */
export const uploadCharacterPhoto = async (req, res) => {
    try {
        const { id, charId } = req.params;
        const { imageUrl } = req.body;

        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required' });
        }

        const character = await prisma.character.findUnique({ where: { id: charId } });
        if (!character || character.projectId !== id) {
            return res.status(404).json({ error: 'Character not found' });
        }

        const updated = await prisma.character.update({
            where: { id: charId },
            data: {
                portraitUrl: imageUrl,
                approved: false,
            },
        });

        res.json({ character: updated });
    } catch (error) {
        logger.error({ err: error }, 'Character photo upload failed');
        res.status(500).json({ error: 'Upload failed' });
    }
};

/**
 * POST /api/projects/:id/characters/:charId/approve
 * Approve a single character.
 */
export const approveCharacter = async (req, res) => {
    try {
        const { id, charId } = req.params;

        const character = await prisma.character.findUnique({ where: { id: charId } });
        if (!character || character.projectId !== id) {
            return res.status(404).json({ error: 'Character not found' });
        }

        const updated = await prisma.character.update({
            where: { id: charId },
            data: { approved: true, approvedAt: new Date() },
        });

        res.json({ character: updated });
    } catch (error) {
        logger.error({ err: error }, 'Character approval failed');
        res.status(500).json({ error: 'Character approval failed' });
    }
};

/**
 * POST /api/projects/:id/characters/approve-all
 * Approve all characters → transition to CHARACTERS_APPROVED.
 */
export const approveAllCharacters = async (req, res) => {
    try {
        const { id } = req.params;

        const characters = await prisma.character.findMany({
            where: { projectId: id },
        });

        // Check all have portraits
        const missingPortraits = characters.filter(c => !c.portraitUrl);
        if (missingPortraits.length > 0) {
            return res.status(400).json({
                error: 'All characters must have portraits before approval',
                missing: missingPortraits.map(c => c.name),
            });
        }

        await prisma.character.updateMany({
            where: { projectId: id },
            data: { approved: true, approvedAt: new Date() },
        });

        await transitionProjectState({
            projectId: id,
            toState: 'CHARACTERS_APPROVED',
            actorType: 'USER',
            actorId: req.user?.id,
            reason: `All ${characters.length} characters approved`,
        });

        res.json({ message: `All ${characters.length} characters approved`, state: 'CHARACTERS_APPROVED' });
    } catch (error) {
        logger.error({ err: error }, 'Approve all characters failed');
        res.status(500).json({ error: 'Failed to approve characters' });
    }
};

// ============================================================
// STAGE 4: Storyboard Generation
// ============================================================

/**
 * POST /api/projects/:id/storyboard/generate
 * Generate storyboard frames for all approved scenes.
 */
export const generateStoryboard = async (req, res) => {
    try {
        const { id } = req.params;
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const project = await prisma.project.findUnique({
            where: { id },
            include: {
                scenes: { orderBy: { orderIndex: 'asc' } },
                characters: { where: { approved: true } },
            },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const visualStyle = project.metadata?.visual_style || 'cinematic';
        const updatedScenes = [];

        for (const scene of project.scenes) {
            try {
                // Build scene prompt with character context
                let scenePrompt = scene.promptText;
                if (project.characters.length > 0) {
                    const charContext = project.characters
                        .map(c => `${c.name} (${c.role}): ${c.description}`)
                        .join('. ');
                    scenePrompt += ` Characters present: ${charContext}`;
                }

                const frame = await generateStoryboardFrame(
                    scenePrompt,
                    visualStyle,
                    tierConfig.image,
                    project.aspectRatio,
                );

                const updated = await prisma.scene.update({
                    where: { id: scene.id },
                    data: {
                        storyboardUrl: frame.url,
                        storyboardPrompt: scenePrompt,
                        storyboardApproved: false,
                    },
                });

                updatedScenes.push(updated);
            } catch (frameErr) {
                logger.error({ err: frameErr, sceneId: scene.id }, 'Storyboard frame generation failed');
                updatedScenes.push(scene); // Keep original on failure
            }
        }

        await transitionProjectState({
            projectId: id,
            toState: 'STORYBOARD_GENERATED',
            actorType: 'SYSTEM',
            reason: `Generated ${updatedScenes.filter(s => s.storyboardUrl).length} storyboard frames`,
        });

        res.json({
            scenes: updatedScenes.map(s => ({
                id: s.id,
                orderIndex: s.orderIndex,
                storyboardUrl: s.storyboardUrl,
                storyboardApproved: s.storyboardApproved,
                prompt: s.promptText,
            })),
        });
    } catch (error) {
        logger.error({ err: error }, 'Storyboard generation failed');
        res.status(500).json({ error: 'Storyboard generation failed', details: error.message });
    }
};

/**
 * POST /api/projects/:id/storyboard/:sceneId/regenerate
 * Regenerate a single storyboard frame.
 */
export const regenerateStoryboardFrame = async (req, res) => {
    try {
        const { id, sceneId } = req.params;
        const { editInstruction } = req.body;
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
        if (!scene || scene.projectId !== id) {
            return res.status(404).json({ error: 'Scene not found' });
        }

        const project = await prisma.project.findUnique({ where: { id } });
        const visualStyle = project?.metadata?.visual_style || 'cinematic';

        let prompt = scene.promptText;
        if (editInstruction) {
            prompt = `${editInstruction}. Original scene: ${scene.promptText}`;
        }

        const frame = await generateStoryboardFrame(
            prompt,
            visualStyle,
            tierConfig.image,
            project?.aspectRatio || '16:9',
        );

        const updated = await prisma.scene.update({
            where: { id: sceneId },
            data: {
                storyboardUrl: frame.url,
                storyboardPrompt: prompt,
                storyboardApproved: false,
            },
        });

        res.json({
            scene: {
                id: updated.id,
                storyboardUrl: updated.storyboardUrl,
                storyboardApproved: false,
            },
        });
    } catch (error) {
        logger.error({ err: error }, 'Storyboard frame regeneration failed');
        res.status(500).json({ error: 'Storyboard regeneration failed' });
    }
};

/**
 * POST /api/projects/:id/storyboard/approve-all
 * Approve all storyboard frames → unlock video generation.
 */
export const approveStoryboard = async (req, res) => {
    try {
        const { id } = req.params;

        const scenes = await prisma.scene.findMany({
            where: { projectId: id },
        });

        // Check all have storyboard frames
        const missingFrames = scenes.filter(s => !s.storyboardUrl);
        if (missingFrames.length > 0) {
            return res.status(400).json({
                error: 'All scenes must have storyboard frames before approval',
                missing: missingFrames.map(s => s.orderIndex + 1),
            });
        }

        await prisma.scene.updateMany({
            where: { projectId: id },
            data: { storyboardApproved: true },
        });

        await transitionProjectState({
            projectId: id,
            toState: 'STORYBOARD_APPROVED',
            actorType: 'USER',
            actorId: req.user?.id,
            reason: 'All storyboard frames approved — video generation unlocked',
        });

        res.json({
            message: 'Storyboard approved — video generation unlocked!',
            state: 'STORYBOARD_APPROVED',
        });
    } catch (error) {
        logger.error({ err: error }, 'Storyboard approval failed');
        res.status(500).json({ error: 'Storyboard approval failed' });
    }
};
