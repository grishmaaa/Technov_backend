/**
 * pipelineController.js
 * 
 * New controller for the 7-stage pipeline.
 * Handles all the stage transitions from script generation through world assets approval.
 * Each function corresponds to a user action in the studio dashboard.
 */

import prisma from '../config/database.js';
import { transitionProjectState } from '../services/projectStateService.js';
import { getTierConfig, calculateCreditCost } from '../config/modelConfig.js';
import { generateStructuredOutput, safetyCheck, editScene, developScript } from '../services/llmService.js';
import { generateCharacterPortraitSeries, generateIngredientImage } from '../services/googleImageService.js';
import { logger } from '../logger.js';

// ============================================================
// STAGE 0: Script Development (Idea to Script)
// ============================================================

/**
 * POST /api/projects/:id/develop
 * Conversational loop to help user build their raw idea into a script.
 */
export const developIdea = async (req, res) => {
    try {
        const { id } = req.params;
        const { chatHistory } = req.body;

        if (!chatHistory || !Array.isArray(chatHistory) || chatHistory.length === 0) {
            return res.status(400).json({ error: 'Chat history is required' });
        }

        let project = await prisma.project.findUnique({ where: { id } });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const tierConfig = getTierConfig(req.user?.plan || 'free');

        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'AI generation features are only available on paid plans. Please upgrade to start creating.'
            });
        }

        // Optional safety check on the latest user message
        const latestUserMsg = chatHistory[chatHistory.length - 1];
        if (latestUserMsg && latestUserMsg.role === 'user' && (req.user?.plan === 'free' || !req.user?.plan)) {
            const safety = await safetyCheck(latestUserMsg.text, tierConfig.safety);
            if (safety.severity === 'BLOCK') {
                return res.status(422).json({
                    error: 'Content blocked by safety filters',
                    violations: safety.violations,
                    suggestion: safety.suggested_alternative,
                });
            }
        }

        const result = await developScript(chatHistory, tierConfig.llmEdit);

        // PERSIST CHAT HISTORY
        // We store it in metadata.chatHistory
        const updatedHistory = [...chatHistory, { role: 'ai', text: result.text }];
        const existingMetadata = project.metadata || {};

        await prisma.project.update({
            where: { id },
            data: {
                metadata: {
                    ...existingMetadata,
                    chatHistory: updatedHistory
                }
            }
        });

        res.json({
            text: result.text,
        });
    } catch (error) {
        logger.error({ err: error }, 'Develop idea failed');
        res.status(500).json({ error: 'Failed to develop idea', details: error.message });
    }
};

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

        if (!story || story.trim().length < 1) {
            return res.status(400).json({ error: 'Story content is required' });
        }

        const userPlan = req.user?.plan || 'free';

        // --- FREE PLAN RESTRICTION ---
        if (userPlan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'Script generation is only available on paid plans. Please upgrade to continue.'
            });
        }

        const tierConfig = getTierConfig(userPlan);

        // Safety check
        const safety = await safetyCheck(story, tierConfig.safety);
        // Skip block for paid users to allow full creative freedom
        if (safety.severity === 'BLOCK' && (userPlan === 'free' || !userPlan)) {
            return res.status(422).json({
                error: 'Content blocked by safety filters',
                violations: safety.violations,
                suggestion: safety.suggested_alternative,
            });
        }

        // Let the AI decide scene structure — only enforce tier cap
        const maxScenes = tierConfig.maxScenes;
        const visualStyleFinal = visualStyle || 'cinematic';

        // Generate production-ready video API prompts
        const systemPrompt = `You are an elite cinematic director and producer. Your task is to analyze a story and determine the most effective way to break it down into cinematic clips.

═══ AI DIRECTORSHIP & JUDGEMENT ═══
1. SCENE COUNT: You are the judge of pacing. 
   - If the story is concise or meant to be a single impactful moment, output only ONE scene (8 seconds).
   - If the story has emotional beats, transitions, or progress, break it into the MINIMUM number of scenes required to tell it effectively (typically 1 to 5 scenes).
   - Only use the maximum of ${maxScenes} scenes for truly complex, epic narratives.
   - Do not stretch a short story into multiple scenes. Quality over quantity.
2. DURATION JUDGEMENT: For each scene, decide if it needs 4, 6, or 8 seconds to land the emotional beat.

═══ PRODUCTION INSTRUCTIONS ═══
1. VISUAL IDENTITY: Define 'characterLock' (visual descriptions of characters) and 'worldLock' (primary setting aesthetic).
2. INGREDIENTS: Identify the key world assets (Locations and Props) that need visual consistency. 
3. CLIPS: Break the story into continuous cinematic clips based on your judgement. Each clip prompt must follow the 4-line structure.

═══ OUTPUT FORMAT ═══
Line 1: Plain English wide shot. What is physically happening. Maximum 20 words.
Line 2: [cut] The close-up that carries emotional weight. Maximum 20 words.
Line 3: [cut] The specific detail from the script. Maximum 20 words.
Line 4: Audio only — music type or 'no music' + dialogue/ambient details.

Zero lens/DOF specs. Output must include \`characterLock\`, \`worldLock\`, \`ingredients\`, and \`clips\`.`;

        const sceneSchema = {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING' },
                characterLock: { type: 'STRING', description: 'Locked visual descriptions of main characters' },
                worldLock: { type: 'STRING', description: 'Locked visual description of the primary world/setting' },
                ingredients: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            name: { type: 'STRING' },
                            type: { type: 'STRING', description: 'LOCATION or PROP' },
                            description: { type: 'STRING', description: 'Visual description for Flux gen' }
                        },
                        required: ['name', 'type', 'description']
                    },
                    description: 'Up to 6 visual ingredients (Locations or Props)'
                },
                clips: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            clip_number: { type: 'INTEGER' },
                            prompt: { type: 'STRING', description: 'Line 1: Wide, Line 2: [cut] Close-up, Line 3: [cut] Detail, Line 4: Audio' },
                            continuity_hook: { type: 'STRING', description: 'How this clip ends to set up the next' },
                            duration: { type: 'INTEGER', description: 'Must be 4, 6, or 8' },
                            characters_present: {
                                type: 'ARRAY',
                                items: { type: 'STRING' },
                                description: 'Names of characters present'
                            }
                        },
                        required: ['clip_number', 'prompt', 'continuity_hook', 'duration', 'characters_present'],
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
            },
            required: ['title', 'characterLock', 'worldLock', 'ingredients', 'clips', 'characters'],
        };

        const { parsed, usage } = await generateStructuredOutput(
            systemPrompt,
            `Transform this story into a cinematic production: \n\n"${story}"`,
            sceneSchema,
            { model: tierConfig.llm.model, temperature: 0.8, maxTokens: 8192 },
        );

        if (!parsed?.clips?.length) {
            throw new Error('AI failed to generate clips');
        }

        // Save scenes (clips) to DB
        const scenes = await Promise.all(
            parsed.clips.map((clip, index) =>
                prisma.scene.create({
                    data: {
                        projectId: id,
                        orderIndex: clip.clip_number !== undefined ? clip.clip_number - 1 : index,
                        promptText: clip.prompt,
                        actionDescription: clip.continuity_hook,
                        duration: clip.duration || 8,
                        charactersPresent: clip.characters_present || [],
                        state: 'DRAFT',
                    },
                })
            )
        );

        // Create characters in DB
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

        // Create World Ingredients (Assets)
        if (parsed.ingredients?.length > 0) {
            await Promise.all(
                parsed.ingredients.map(ing =>
                    prisma.asset.create({
                        data: {
                            projectId: id,
                            type: ing.type, // LOCATION or PROP
                            state: 'DRAFT',
                            metadata: ing.description,
                            url: null,
                        }
                    })
                )
            );
        }

        // Update project with title, story, and strongly-typed locked strings in metadata
        await prisma.project.update({
            where: { id },
            data: {
                title: parsed.title || `Project ${new Date().toLocaleDateString()} `,
                story,
                metadata: {
                    characterLock: parsed.characterLock, // Saving the locked string
                    worldLock: parsed.worldLock,         // Saving the locked string
                    visual_style: visualStyleFinal,
                    safety_check: safety,
                    llm_usage: usage,
                    chatHistory: [{ role: 'user', text: story }] // Initialize chat history with the prompt
                },
            },
        });

        // Transition state
        await transitionProjectState({
            projectId: id,
            toState: 'SCRIPT_GENERATED',
            actorType: 'SYSTEM',
            reason: `Script generated with ${tierConfig.llm.model} `,
        });

        res.json({
            title: parsed.title,
            worldLock: parsed.worldLock,
            characterLock: parsed.characterLock,
            scenes: scenes.map((s, i) => ({
                id: s.id,
                sceneNumber: s.orderIndex !== undefined ? s.orderIndex + 1 : i + 1, // Expose sceneNumber for frontend mapping
                title: `Clip ${s.orderIndex !== undefined ? s.orderIndex + 1 : i + 1}`,
                description: s.actionDescription, // Mapped to continuity_hook
                prompt: s.promptText,       // Mapped to 5-part formula
                directorsNote: s.directorsNote,
                duration: s.duration,
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

        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'AI editing is only available on paid plans.'
            });
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
        const fullScript = allScenes.map(s => `Scene ${s.orderIndex + 1}: ${s.promptText} `).join('\n\n');

        // AI edit
        const result = await editScene(scene.promptText, instruction, fullScript, tierConfig.llmEdit);

        // Update scene
        const updated = await prisma.scene.update({
            where: { id: sceneId },
            data: {
                promptText: result.editedPrompt,
                actionDescription: result.editedDescription,
                approved: false, // Reset approval on edit
                state: 'DRAFT',  // Reset state to ensure worker regenerates it
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
        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'AI generation features are only available on paid plans.'
            });
        }
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const project = await prisma.project.findUnique({
            where: { id },
            include: { scenes: true, characters: true },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Read characters from the DB table (created during generateScript)
        const existingCharacters = project.characters || [];

        if (existingCharacters.length === 0) {
            // No characters — skip to ingredients
            await transitionProjectState({
                projectId: id,
                toState: 'CHARACTERS_APPROVED',
                actorType: 'SYSTEM',
                reason: 'No characters in script — skipping',
            });
            return res.json({ characters: [], message: 'No characters found, skipping to world ingredients' });
        }

        // Generate portrait series (Frontal, Left, Right) in parallel for each character
        const visualStyle = project.metadata?.visual_style || 'cinematic';

        const portraitResults = await Promise.allSettled(
            existingCharacters.map(async (charRecord) => {
                // Returns [{url, view: 'front'}, {url, view: 'left'}, {url, view: 'right'}]
                const series = await generateCharacterPortraitSeries(
                    charRecord.description,
                    visualStyle,
                    tierConfig.image,
                );

                // 1. Find the frontal shot to update the main character record
                const frontal = series.find(s => s.view === 'front') || series[0];

                // 2. Persist all 3 views to the Asset table so the worker can find them
                await Promise.all(series.map(shot => 
                    prisma.asset.create({
                        data: {
                            projectId: id,
                            type: 'CHARACTER',
                            state: 'READY',
                            url: shot.url,
                            metadata: JSON.stringify({ 
                                characterId: charRecord.id, 
                                view: shot.view, 
                                role: charRecord.role 
                            })
                        }
                    })
                ));

                // 3. Update character record with frontal shot
                return prisma.character.update({
                    where: { id: charRecord.id },
                    data: { portraitUrl: frontal.url },
                });
            })
        );

        const characters = portraitResults.map((result, i) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                logger.error({ err: result.reason, character: existingCharacters[i].name }, 'Character portrait generation failed');
                return existingCharacters[i]; // Keep record as-is
            }
        });

        await transitionProjectState({
            projectId: id,
            toState: 'CHARACTERS_GENERATED',
            actorType: 'SYSTEM',
            reason: `Generated ${characters.length} characters`,
        });

        res.json({ characters });
    } catch (error) {
        logger.error({ err: error }, 'Character generation failed');
        res.status(500).json({ error: error.message || 'Character generation failed', details: error.message });
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
        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'AI generation features are only available on paid plans.'
            });
        }
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const character = await prisma.character.findUnique({ where: { id: charId } });
        if (!character || character.projectId !== id) {
            return res.status(404).json({ error: 'Character not found' });
        }

        const project = await prisma.project.findUnique({ where: { id }, include: { assets: true } });
        const visualStyle = project?.metadata?.visual_style || 'cinematic';

        // 1. Generate 3-shot series
        const series = await generateCharacterPortraitSeries(
            character.description,
            visualStyle,
            tierConfig.image,
            userPrompt,
        );

        const frontal = series.find(s => s.view === 'front') || series[0];

        // 2. Cleanup old assets for this character to prevent "bloat" in reference lists
        const oldAssets = project.assets.filter(a => {
            try {
                if (a.type !== 'CHARACTER') return false;
                const meta = JSON.parse(a.metadata || '{}');
                return meta.characterId === charId;
            } catch (e) { return false; }
        });
        
        if (oldAssets.length > 0) {
            await prisma.asset.deleteMany({
                where: { id: { in: oldAssets.map(a => a.id) } }
            });
        }

        // 3. Create new assets for the 3 shots
        await Promise.all(series.map(shot => 
            prisma.asset.create({
                data: {
                    projectId: id,
                    type: 'CHARACTER',
                    state: 'READY',
                    url: shot.url,
                    metadata: JSON.stringify({ characterId: charId, view: shot.view, role: character.role })
                }
            })
        ));

        // 4. Update the character record with the frontal shot
        const updated = await prisma.character.update({
            where: { id: charId },
            data: {
                portraitUrl: frontal.url,
                approved: false, // Reset approval on regen
                elementId: null, // Clear elementId so worker creates a new one for new portrait
            },
        });

        res.json({ character: updated });
    } catch (error) {
        logger.error({ err: error }, 'Character regeneration failed');
        res.status(500).json({ error: error.message || 'Character regeneration failed' });
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
                elementId: null, // Clear elementId for new manual photo
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
// STAGE 4: World Ingredients Generation (Global Assets)
// ============================================================

/**
 * POST /api/projects/:id/ingredients/generate
 * Generate reference images for all world assets (Locations and Props).
 */
export const generateIngredients = async (req, res) => {
    try {
        const { id } = req.params;
        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'AI generation features are only available on paid plans.'
            });
        }
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const project = await prisma.project.findUnique({
            where: { id },
            include: {
                assets: { where: { state: 'DRAFT' } },
            },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const visualStyle = project.metadata?.visual_style || 'cinematic';
        const worldLock = project.metadata?.worldLock || '';

        // Generate all ingredient images in parallel
        const assetResults = await Promise.allSettled(
            project.assets.map(async (asset) => {
                // Combine worldLock with the specific ingredient description
                const assetPrompt = `${worldLock} ${asset.metadata}`.trim();

                const image = await generateIngredientImage(
                    assetPrompt,
                    visualStyle,
                    { ...tierConfig.image, aspectRatio: project.aspectRatio }
                );

                return prisma.asset.update({
                    where: { id: asset.id },
                    data: {
                        url: image.url,
                        state: 'GENERATED',
                    },
                });
            })
        );

        const updatedAssets = assetResults.map((result, i) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                logger.error({ err: result.reason, assetId: project.assets[i].id }, 'Ingredient image generation failed');
                return project.assets[i];
            }
        });

        await transitionProjectState({
            projectId: id,
            toState: 'WORLD_ASSETS_GENERATED',
            actorType: 'SYSTEM',
            reason: `Generated ${updatedAssets.filter(a => a.url).length} world ingredients`,
        });

        res.json({
            message: 'Ingredients generated successfully',
            assets: updatedAssets,
            state: 'WORLD_ASSETS_GENERATED'
        });
    } catch (error) {
        logger.error({ err: error }, 'Generate ingredients failed');
        res.status(500).json({ error: 'Failed to generate ingredients', details: error.message });
    }
};

/**
 * POST /api/projects/:id/ingredients/:assetId/regenerate
 * Regenerate a single ingredient image.
 */
export const regenerateIngredient = async (req, res) => {
    try {
        const { id, assetId } = req.params;
        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'AI generation features are only available on paid plans.'
            });
        }
        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const project = await prisma.project.findUnique({
            where: { id }
        });
        const asset = await prisma.asset.findUnique({ where: { id: assetId } });

        if (!project || !asset) {
            return res.status(404).json({ error: 'Project or asset not found' });
        }

        const visualStyle = project.metadata?.visual_style || 'cinematic';
        const worldLock = project.metadata?.worldLock || '';
        let finalPrompt = `${worldLock} ${asset.metadata}`.trim();

        const frame = await generateIngredientImage(
            finalPrompt,
            visualStyle,
            { ...tierConfig.image, aspectRatio: project?.aspectRatio || '16:9' },
        );

        const updated = await prisma.asset.update({
            where: { id: assetId },
            data: {
                url: frame.url,
                state: 'GENERATED',
            },
        });

        res.json(updated);
    } catch (error) {
        logger.error({ err: error }, 'Ingredient regeneration failed');
        res.status(500).json({ error: error.message || 'Failed to regenerate ingredient' });
    }
};

/**
 * POST /api/projects/:id/ingredients/approve-all
 * Approve all ingredients → transition to WORLD_ASSETS_APPROVED.
 */
export const approveAllIngredients = async (req, res) => {
    try {
        const { id } = req.params;

        const assets = await prisma.asset.findMany({
            where: { projectId: id, state: 'GENERATED' }
        });

        // Check if all ingredients were generated
        const draftAssets = await prisma.asset.count({
            where: { projectId: id, state: 'DRAFT' }
        });

        if (draftAssets > 0) {
            return res.status(400).json({ error: 'Some ingredients have not been generated yet' });
        }

        // IDEMPOTENCY: If already approved or generating, just return success
        const project = await prisma.project.findUnique({ where: { id } });
        if (['WORLD_ASSETS_APPROVED', 'VIDEO_GENERATION', 'COMPLETE'].includes(project?.state)) {
            return res.json({ message: 'Ingredients already approved', state: project.state });
        }

        await prisma.asset.updateMany({
            where: { projectId: id, state: 'GENERATED' },
            data: { state: 'APPROVED' },
        });

        await transitionProjectState({
            projectId: id,
            toState: 'WORLD_ASSETS_APPROVED',
            actorType: 'USER',
            actorId: req.user?.id,
            reason: `All world ingredients approved — video generation unlocked`,
        });

        res.json({ message: 'All ingredients approved', state: 'WORLD_ASSETS_APPROVED' });
    } catch (error) {
        logger.error({ err: error }, 'Approve all ingredients failed');
        res.status(500).json({ error: 'Failed to approve ingredients' });
    }
};

/**
 * POST /api/projects/:id/ingredients/:assetId/approve
 * Approve a single ingredient.
 */
export const approveIngredient = async (req, res) => {
    try {
        const { id, assetId } = req.params;

        const asset = await prisma.asset.findUnique({ where: { id: assetId } });
        if (!asset || asset.projectId !== id) {
            return res.status(404).json({ error: 'Ingredient not found' });
        }

        const updated = await prisma.asset.update({
            where: { id: assetId },
            data: { state: 'APPROVED' },
        });

        res.json(updated);
    } catch (error) {
        logger.error({ err: error }, 'Approve ingredient failed');
        res.status(500).json({ error: 'Failed to approve ingredient' });
    }
};

// ============================================================
// STAGE 6: Video Agent Loop (Post-Generation Editing)
// ============================================================

/**
 * POST /api/projects/:id/edit-video
 * Uses LLM to parse user feedback, identify affected clips, and requeue them.
 */
export const editVideo = async (req, res) => {
    try {
        const { id } = req.params;
        const { feedback } = req.body;

        // --- FREE PLAN RESTRICTION ---
        if (req.user?.plan === 'free') {
            return res.status(403).json({
                error: 'Subscription required',
                details: 'Video Agent editing is only available on paid plans.'
            });
        }

        const tierConfig = getTierConfig(req.user?.plan || 'free');

        const project = await prisma.project.findUnique({
            where: { id },
            include: { scenes: { orderBy: { orderIndex: 'asc' } } }
        });

        if (!project || project.state !== 'COMPLETED' && project.state !== 'POST_PROCESSING') {
            return res.status(400).json({ error: 'Project not ready for video editing' });
        }

        const systemPrompt = `You are a Video Editing AI Agent. The user has generated a video consisting of multiple sequential clips. They are now providing feedback to change specific parts of the video.
        
Read the user's feedback and the list of current clips. Identify EXACTLY which clips need to be regenerated to satisfy the user's request. 
Output a JSON array of the clip numbers that need to be regenerated, and provide a short rewritten prompt for those clips reflecting the requested change.

Example: If user says "Make clip 3 raining", output: { "affected_clips": [3], "edits": [{ "clip_number": 3, "new_prompt": "...[original prompt]... Heavy rain falling."}] }
If they say "The ending is too slow", maybe clip 4 and 5 need action adjustments.`;

        const clipContext = project.scenes.map(s => `Clip ${s.orderIndex + 1}: ${s.promptText}`).join('\n');

        const schema = {
            type: 'OBJECT',
            properties: {
                affected_clips: { type: 'ARRAY', items: { type: 'INTEGER' } },
                edits: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            clip_number: { type: 'INTEGER' },
                            new_prompt: { type: 'STRING' }
                        },
                        required: ['clip_number', 'new_prompt']
                    }
                }
            },
            required: ['affected_clips', 'edits']
        };

        const { parsed } = await generateStructuredOutput(
            systemPrompt,
            `Current Clips:\n${clipContext}\n\nUser Feedback: "${feedback}"`,
            schema,
            { model: tierConfig.llm.model }
        );

        if (!parsed.affected_clips || parsed.affected_clips.length === 0) {
            return res.json({ message: "No visual changes detected.", affectedClips: [] });
        }

        // Update the prompts for the affected clips and reset their state
        await Promise.all(
            parsed.edits.map(async (edit) => {
                const sceneToUpdate = project.scenes.find(s => s.orderIndex === edit.clip_number - 1);
                if (sceneToUpdate) {
                    await prisma.scene.update({
                        where: { id: sceneToUpdate.id },
                        data: {
                            promptText: edit.new_prompt,
                            state: 'PENDING_REGENERATION' // Worker will pick this up
                        }
                    });
                }
            })
        );

        // Transition project back to generation state
        await transitionProjectState({
            projectId: id,
            toState: 'VIDEO_GENERATION',
            actorType: 'USER',
            actorId: req.user.id,
            reason: `Video Agent requested regeneration for clips: ${parsed.affected_clips.join(', ')}`
        });

        res.json({
            message: `Regenerating clips: ${parsed.affected_clips.join(', ')}`,
            affectedClips: parsed.affected_clips,
            edits: parsed.edits
        });

    } catch (error) {
        logger.error({ err: error }, 'Video edit parsing failed');
        res.status(500).json({ error: 'Failed to process video edit request' });
    }
};
