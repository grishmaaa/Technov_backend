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
import { generateStructuredOutput, safetyCheck, editScene, developScript } from '../services/llmService.js';
import { generateCharacterPortrait, generateStoryboardFrame } from '../services/falService.js';
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

        // Optional safety check on the latest user message
        const latestUserMsg = chatHistory[chatHistory.length - 1];
        if (latestUserMsg && latestUserMsg.role === 'user') {
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

        // Let the AI decide scene structure — only enforce tier cap
        const maxScenes = tierConfig.maxScenes;
        const visualStyleFinal = visualStyle || 'cinematic';

        // Get project
        let project = await prisma.project.findUnique({ where: { id } });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Generate production-ready video API prompts
        const systemPrompt = `You are an expert prompt engineer turning a user's script into a production-ready shot list for the Veo 3.1 video generation model. Your job is not to write a beautiful description for a human director. Your job is to output the exact strings needed by the API to generate consistent, flawless continuity across multiple video clips.

═══ SACRED TEXT RULE (ENFORCED) ═══
The user's script is SACRED. Do NOT change, substitute, or "improve" any specific words, names, dialogue, or details from their script.
- If the script says "THRESHOLD" — you must include "the word 'THRESHOLD'" in the action description.
- DIALOGUE IS THE ANCHOR: If a scene centers around a climactic line (e.g., "Today is the last Wednesday"), you MUST factor that emotional weight into the action or style.
- DIALOGUE SACRED TEXT RULE: Every spoken line in the output must match the user's script verbatim, word for word, including ellipses, pauses, and sentence fragments. You are never permitted to truncate, paraphrase, summarize, or invent dialogue. If a line in the script is "Today is the last Wednesday. Not forever. Just... yours." — that exact string appears in the audio field, nothing removed. If a scene has no dialogue in the source script, the audio field contains no spoken line. You cannot add dialogue that doesn't exist in the script.
- EMPTY CLIP RULE: If a clip has no dialogue in the source script, the audio line must be 'no music, no talking.' You are never permitted to invent dialogue to fill silence. Silence is a valid creative choice. A clip with no spoken words is not incomplete — it is intentional. Do not add dialogue. Do not paraphrase. Do not summarize. If the character says nothing in the source script at this moment, they say nothing in the video.

═══ LOCKED STRINGS (CONTINUITY) ═══
To prevent the model from hallucinating different clothes or settings across clips, you must define "Locked Strings" for the main characters and the primary world/location. These will be automatically prepended to every clip's prompt.
- **characterLock:** Extremely specific, purely visual descriptions of the main character(s). (e.g., "MARA: 38-year-old woman, dark hair pulled back loosely, white collared blouse, tired eyes.")
- **worldLock:** Extremely specific description of the primary setting and lighting. (e.g., "Small American diner, 1990s aesthetic, vinyl booths, fluorescent overhead lighting.")

═══ CLIP-BY-CLIP CONTINUITY ═══
Think of these not as "scenes" but as "clips". Clip 2 starts the frame after Clip 1 ends.
Provide a \`continuity_hook\` describing exactly how Clip N ends, so it perfectly sets up the first frame of Clip N+1.

═══ OUTPUT FORMAT ═══
Each clip prompt must follow this exact structure and nothing else:
Line 1: Plain English wide shot. What is physically happening. Maximum 20 words.
Line 2: [cut] The close-up that carries emotional weight. Maximum 20 words.
Line 3: [cut] The specific detail — exact words, names, objects from the script verbatim. Maximum 20 words.
Line 4: Audio only — music type or 'no music' + dialogue line if spoken, or 'no talking'.

Zero lens specifications. Zero depth of field. Zero cinematography terminology. Zero style descriptors. The model knows how to film. These are shot lists, not film school essays.

Maximum 8 clips (hard limit). Never generate more than 8 clips. Never generate fewer than 1.
Each clip should target exactly 4, 6, or 8 seconds.
EFFICIENCY RULE: If the story is short (e.g., an 8-second moment), do NOT force it into 8 clips. One or two long, high-quality cinematic shots are better than many frantic cuts. Do NOT naturally segment smooth continuous actions. Quality over quantity.

Output must include the \`characterLock\`, \`worldLock\`, and an array of clips containing the exact 4-line structured prompt, duration, and continuity hook.`;

        const sceneSchema = {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING' },
                characterLock: { type: 'STRING', description: 'Locked visual descriptions of main characters' },
                worldLock: { type: 'STRING', description: 'Locked visual description of the primary world/setting' },
                clips: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            clip_number: { type: 'INTEGER' },
                            prompt: { type: 'STRING', description: 'The exact 4-line format: Line 1: Wide, Line 2: [cut] Close-up, Line 3: [cut] Detail, Line 4: Audio' },
                            continuity_hook: { type: 'STRING', description: 'How this clip ends to set up the exact first frame of the next clip' },
                            duration: { type: 'INTEGER', description: 'Must be 4, 6, or 8' },
                            characters_present: {
                                type: 'ARRAY',
                                items: { type: 'STRING' },
                                description: 'Names of characters who appear in this clip, exactly as spelled in the characters array'
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
            required: ['title', 'characterLock', 'worldLock', 'clips', 'characters'],
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
                        promptText: clip.prompt, // The 5-part Veo formula
                        actionDescription: clip.continuity_hook, // Storing continuity hook here temporarily
                        duration: clip.duration_seconds || 8,
                        charactersPresent: clip.characters_present || [],
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
            include: { scenes: true, characters: true },
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Read characters from the DB table (created during generateScript)
        const existingCharacters = project.characters || [];

        if (existingCharacters.length === 0) {
            // No characters — skip to storyboard
            await transitionProjectState({
                projectId: id,
                toState: 'CHARACTERS_APPROVED',
                actorType: 'SYSTEM',
                reason: 'No characters in script — skipping',
            });
            return res.json({ characters: [], message: 'No characters found, skipping to storyboard' });
        }

        // Generate portraits in parallel — they're independent operations
        const visualStyle = project.metadata?.visual_style || 'cinematic';

        const portraitResults = await Promise.allSettled(
            existingCharacters.map(async (charRecord) => {
                const portrait = await generateCharacterPortrait(
                    charRecord.description,
                    visualStyle,
                    tierConfig.image,
                );
                return prisma.character.update({
                    where: { id: charRecord.id },
                    data: { portraitUrl: portrait.url },
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
        const characterLock = project.metadata?.characterLock || '';
        const worldLock = project.metadata?.worldLock || '';

        // Generate all frames in parallel using IP-Adapters for character consistency
        const frameResults = await Promise.allSettled(
            project.scenes.map(async (scene) => {
                let scenePrompt = `${characterLock} ${worldLock} ${scene.promptText}`.trim();

                // Truncate safely - Fal/Flux supports long prompts
                if (scenePrompt.length > 1500) {
                    scenePrompt = scenePrompt.substring(0, 1500);
                }

                // Look up character portraits for characters present in this scene
                const portraits = (scene.charactersPresent || [])
                    .map(charName => {
                        const character = project.characters.find(c => c.name.toLowerCase() === charName.toLowerCase());
                        return character?.portraitUrl;
                    })
                    .filter(url => !!url);

                const frame = await generateStoryboardFrame(
                    scenePrompt,
                    visualStyle,
                    tierConfig.image,
                    project.aspectRatio,
                    portraits
                );

                return prisma.scene.update({
                    where: { id: scene.id },
                    data: {
                        storyboardUrl: frame.url,
                        storyboardPrompt: scenePrompt,
                        storyboardApproved: false,
                    },
                });
            })
        );

        const updatedScenes = frameResults.map((result, i) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                logger.error({ err: result.reason, sceneId: project.scenes[i].id }, 'Storyboard frame generation failed');
                return project.scenes[i];
            }
        });

        await transitionProjectState({
            projectId: id,
            toState: 'STORYBOARD_GENERATED',
            actorType: 'SYSTEM',
            reason: `Generated ${updatedScenes.filter(s => s.storyboardUrl).length} storyboard frames`,
        });

        res.json({
            projectId: id,
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
            // Route through the LLM pipeline — Sacred Text + Four Questions
            const allScenes = await prisma.scene.findMany({
                where: { projectId: id },
                orderBy: { orderIndex: 'asc' },
            });
            const fullScript = allScenes.map(s => `Scene ${s.orderIndex + 1}: ${s.promptText} `).join('\n\n');
            const result = await editScene(scene.promptText, editInstruction, fullScript, tierConfig.llmEdit);
            prompt = result.editedPrompt;

            // Update the scene's prompt with the LLM-edited version
            await prisma.scene.update({
                where: { id: sceneId },
                data: { promptText: prompt, actionDescription: result.editedDescription },
            });
        }

        const characterLock = project.metadata?.characterLock || '';
        const worldLock = project.metadata?.worldLock || '';
        let finalStoryboardPrompt = `${characterLock} ${worldLock} ${prompt}`.trim();

        if (finalStoryboardPrompt.length > 1500) {
            finalStoryboardPrompt = finalStoryboardPrompt.substring(0, 1500);
        }

        const frame = await generateStoryboardFrame(
            finalStoryboardPrompt,
            visualStyle,
            tierConfig.image,
            project?.aspectRatio || '16:9',
        );

        const updated = await prisma.scene.update({
            where: { id: sceneId },
            data: {
                storyboardUrl: frame.url,
                storyboardPrompt: finalStoryboardPrompt,
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
        res.status(500).json({ error: error.message || 'Failed to regenerate storyboard frame' });
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

/**
 * POST /api/projects/:id/storyboard/:sceneId/approve
 * Approve a single storyboard frame.
 */
export const approveStoryboardFrame = async (req, res) => {
    try {
        const { id, sceneId } = req.params;

        const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
        if (!scene || scene.projectId !== id) {
            return res.status(404).json({ error: 'Scene not found' });
        }

        if (!scene.storyboardUrl) {
            return res.status(400).json({ error: 'Scene has no storyboard frame to approve' });
        }

        const updated = await prisma.scene.update({
            where: { id: sceneId },
            data: { storyboardApproved: true },
        });

        res.json({
            scene: {
                id: updated.id,
                storyboardApproved: true,
            },
        });
    } catch (error) {
        logger.error({ err: error }, 'Storyboard frame approval failed');
        res.status(500).json({ error: 'Storyboard frame approval failed' });
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
