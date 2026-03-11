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

        // Duration constraints — auto-detect from script length if not specified
        let requestedSeconds;
        if (length === '60s') {
            requestedSeconds = 60;
        } else if (length === '30s') {
            requestedSeconds = 30;
        } else if (length) {
            requestedSeconds = parseInt(length) || 30;
        } else {
            // Auto-detect: ~100 words per 8-second scene, minimum 2 scenes
            const wordCount = story.trim().split(/\s+/).length;
            const estimatedScenes = Math.max(2, Math.ceil(wordCount / 100));
            requestedSeconds = estimatedScenes * 8;
        }
        const finalDuration = Math.min(requestedSeconds, tierConfig.maxDuration);

        // Get or create project
        let project = await prisma.project.findUnique({ where: { id } });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Generate cinematic scene document
        const sceneCount = Math.min(Math.ceil(finalDuration / 8), tierConfig.maxScenes);
        const systemPrompt = `You are a master cinematographer in the tradition of Roger Deakins, Emmanuel Lubezki, and Hoyte van Hoytema. You shoot with your gut. You translate feelings into images.

═══ SACRED TEXT RULE ═══
The user's script is SACRED. Do NOT change, substitute, or "improve" any specific words, names, dialogue, or details from their script.
If the script says "THRESHOLD" — you write THRESHOLD. If the script says "exact change for coffee he never ordered" — that detail MUST appear in your breakdown.
You are a translator, not a rewriter. Preserve every specific noun, number, and piece of dialogue EXACTLY as written.
VERIFY: Before outputting, check every proper noun, crossword answer, character name, and specific detail against the original script. If you changed anything, FIX IT.

═══ THE FOUR QUESTIONS ═══
For every scene, before writing the shot description, answer these internally:
1. What is the LIE the character believes at the start of this moment?
2. What does the camera WITHHOLD and when does it REVEAL?
3. Where must the AUDIENCE'S EYE land for the emotional hit?
4. What detail should NOT be explained — only shown?

═══ EMOTIONAL CINEMATOGRAPHY ═══
You are not describing what the camera sees. You are describing what the audience FEELS.

BAD: "cinematic extreme close-up, crossword puzzle on table, shallow depth of field"
GOOD: "ECU — the crossword. The word is already written. The pen hasn't moved. Hold on it. Don't cut. Let the audience sit in the wrongness before the character does. The horror isn't the word. It's the handwriting. It's hers."

The difference between coverage and cinema: coverage shows WHAT HAPPENS. Cinema shows WHAT IT MEANS.

═══ THE STRANGE DETAIL ═══
Every great scene has one detail that carries all the weight. Find it. Make it the anchor shot.
- Exact change left for a coffee never ordered → that's the detail that tells you he's not human
- Handwriting on a crossword she never wrote → that's the detail that breaks reality
- A kid on a bike passing slow as a dream → that's the detail that bends time
These details matter more than any wide shot or camera move. HOLD ON THEM.

═══ CAMERA AS EMOTION ═══
Camera movement is not choreography — it's psychology.
- RAPID push-in = violence of revelation, the moment yanking toward you
- SLOW dolly = contemplation, dread building
- STATIC hold = forcing the audience to sit in discomfort — no escape from the frame
- CRANE DOWN = descending into something, gravity of truth
Match the movement speed and type to the EMOTIONAL VELOCITY of the moment, not just the action.

═══ PACING ═══
- Not every moment needs motion. Stillness is power.
- If a detail tells the audience something the character doesn't know yet, HOLD ON IT. Don't cut away.
- Silence is a shot. Let it breathe.
- The final image of a scene should be the image that HAUNTS — the one the audience carries into the next scene.

═══ ANTI-PATTERNS (DO NOT DO THESE) ═══
- Don't use "uncanny valley mood" or similar vibe tags — they do zero work
- Don't list visual elements without emotional purpose
- Don't describe what the audience "sees" — describe what they FEEL
- Don't add generic cinematic texture ("film grain, anamorphic lens flare") unless it serves a specific emotional function
- Don't replace specific details with "better" alternatives — the writer chose those details for a reason

═══ OUTPUT FORMAT ═══
Total target duration: ${finalDuration} seconds. Split into ${sceneCount} scenes of ~8s each.
Visual style: ${visualStyle || 'cinematic'}.
For each scene provide:
- prompt: A cinematic image prompt describing the frame with emotional intent (for the image/video generation model). CRITICAL: If the scene contains any readable text (crossword answers, signs, notes, titles), include that text VERBATIM in the prompt. Example: "the word THRESHOLD is written in cursive in the 7-ACROSS box" — do NOT omit or substitute the specific text.
- directors_note: What the audience should feel, why this frame matters, what the camera is doing TO the viewer
- emotional_beat: The subtext underneath — what's happening beneath the surface that the image carries`;

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
                            directors_note: { type: 'STRING' },
                            emotional_beat: { type: 'STRING' },
                            duration: { type: 'INTEGER' },
                            camera: { type: 'STRING' },
                            lighting: { type: 'STRING' },
                            mood: { type: 'STRING' },
                            audio: { type: 'STRING' },
                        },
                        required: ['scene_number', 'title', 'description', 'prompt', 'directors_note', 'duration'],
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
                directorsNote: parsed.scenes[i].directors_note,
                emotionalBeat: parsed.scenes[i].emotional_beat,
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
            // Route through the LLM pipeline — Sacred Text + Four Questions
            const allScenes = await prisma.scene.findMany({
                where: { projectId: id },
                orderBy: { orderIndex: 'asc' },
            });
            const fullScript = allScenes.map(s => `Scene ${s.orderIndex + 1}: ${s.promptText}`).join('\n\n');
            const result = await editScene(scene.promptText, editInstruction, fullScript, tierConfig.llmEdit);
            prompt = result.editedPrompt;

            // Update the scene's prompt with the LLM-edited version
            await prisma.scene.update({
                where: { id: sceneId },
                data: { promptText: prompt, actionDescription: result.editedDescription },
            });
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
