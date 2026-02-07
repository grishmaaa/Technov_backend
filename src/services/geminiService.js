//geminiservice.js
import OpenAI from 'openai';
import { VertexAI } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { uploadFile } from './fileHostingService.js';
import { isStorageConfigured, getPresignedDownloadUrl, uploadBufferToStorage, buildObjectKey } from './storageService.js';
import { logger } from '../logger.js';
import crypto from 'crypto';

dotenv.config();

// Lazy-load OpenAI client - only initialize when needed
let _openaiInstance = null;
const getOpenAI = () => {
    if (!_openaiInstance) {
        if (!process.env.OPENAI_API_KEY) {
            logger.warn('OPENAI_API_KEY not set - AI features disabled');
            throw new Error('OpenAI API key not configured');
        }
        _openaiInstance = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }
    return _openaiInstance;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callWithRetry(fn, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await fn();
        } catch (error) {
            attempt++;

            // Check for retryable errors (429 Too Many Requests, 503 Service Unavailable)
            const isRetryable = error.message.includes('429') || error.message.includes('503') || error.message.includes('OVER_QUERY_LIMIT');

            if (!isRetryable || attempt >= maxRetries) {
                logger.error({ attempt }, 'API call failed after retries');
                throw error;
            }

            // Exponential Backoff: 1s, 2s, 4s...
            const delay = Math.pow(2, attempt - 1) * 1000;
            logger.warn({ err: error, delay, attempt, maxRetries }, 'API error, retrying');
            await sleep(delay);
        }
    }
}

const cleanMarkdown = (text) => text.replace(/```json/g, '').replace(/```/g, '').trim();

// Tiered Director Personas for Pro vs Basic plans
const getDirectorPersona = (plan) => {
    if (plan === 'elite' || plan === 'pro') {
        return `You are an Oscar-winning Cinematographer with 30 years of experience.
    Your shot descriptions must be poetic and use advanced cinematic terms (e.g., 'chiaroscuro lighting', 'anamorphic lens flare').
    Add visual subtext and emotional layers to every scene.`;
    }
    return `You are an expert film director, screenwriter, cinematographer, and editor combined.`;
};

// Production style maps for different tiers
const PRODUCTION_STYLES = {
    vlog: "Filming Style: Handheld, authentic vlog feel with natural lighting.",
    standard: "Filming Style: Stable tripod, professional corporate lighting.",
    cinematic: "Filming Style: Sweeping gimbal movements, dramatic lighting, epic scale.",
    performance: "Filming Style: Macro lens on face, focus on lip-sync and micro-expressions."
};

const ARTISTIC_ATMOSPHERES = {
    photorealistic: "Aesthetic: Hyper-realistic, 8K textures, natural colors.",
    cyberpunk: "Aesthetic: Neon pink and cyan, rainy streets, high-tech grit.",
    noir: "Aesthetic: High-contrast black and white, deep shadows.",
    anime: "Aesthetic: Modern Japanese animation style, vibrant cel-shading.",
    vintage: "Aesthetic: 35mm film grain, faded colors, warm tones.",
    sketch: "Aesthetic: Animated charcoal sketch style."
};

// Visual Mood - lighting and color grading directives
const VISUAL_MOODS = {
    'neutral-auto': "Lighting: Natural, context-appropriate lighting.",
    'raw-gritty': "Lighting: Harsh, desaturated, raw reality look. Gritty urban aesthetic.",
    'golden-ethereal': "Lighting: Golden hour warmth, soft lens flares, ethereal glow.",
    'high-contrast-noir': "Lighting: High contrast, deep blacks, dramatic rim lighting.",
    'hyper-saturated': "Lighting: Punchy, vibrant colors, high saturation throughout."
};

// 3-STAGE PIPELINE CONSTANTS & SCHEMAS

// SCENE GENERATION SCHEMA (Stage 2)
const SCENE_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "scenes_output",
        strict: true,
        schema: {
            type: "object",
            properties: {
                scenes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            scene_number: { type: "number" },
                            timestamp: { type: "string" },
                            title: { type: "string" },
                            prompt: { type: "string" },
                            technical_breakdown: {
                                type: "object",
                                properties: {
                                    cinematography: { type: "string" },
                                    subject: { type: "string" },
                                    action: { type: "string" },
                                    context: { type: "string" },
                                    style_ambiance: { type: "string" }
                                },
                                required: ["cinematography", "subject", "action", "context", "style_ambiance"],
                                additionalProperties: false
                            },
                            audio: {
                                type: "object",
                                properties: {
                                    dialogue: { type: ["string", "null"] },
                                    sfx: { type: "array", items: { type: "string" } },
                                    ambient: { type: "string" }
                                },
                                required: ["dialogue", "sfx", "ambient"],
                                additionalProperties: false
                            },
                            consistency_check: {
                                type: "object",
                                properties: {
                                    character_ids: { type: "array", items: { type: "string" } },
                                    object_ids: { type: "array", items: { type: "string" } },
                                    location_id: { type: "string" }
                                },
                                required: ["character_ids", "object_ids", "location_id"],
                                additionalProperties: false
                            },
                            duration: { type: "number" }
                        },
                        required: ["scene_number", "timestamp", "title", "prompt", "technical_breakdown", "audio", "consistency_check", "duration"],
                        additionalProperties: false
                    }
                },
                narrative_flow: { type: "string" },
                audio_continuity: { type: "string" }
            },
            required: ["scenes", "narrative_flow", "audio_continuity"],
            additionalProperties: false
        }
    }
};

// VALIDATION SCHEMA (Stage 3)
const VALIDATION_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "validation_report",
        strict: true,
        schema: {
            type: "object",
            properties: {
                validation_status: { type: "string", enum: ["PASS", "FAIL", "NEEDS_REVISION"] },
                overall_score: { type: "number" },
                issues_found: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            severity: { type: "string", enum: ["CRITICAL", "MODERATE", "MINOR"] },
                            category: { type: "string" },
                            scene_number: { type: "number" },
                            issue: { type: "string" },
                            current_text: { type: "string" },
                            required_fix: { type: "string" }
                        },
                        required: ["severity", "category", "scene_number", "issue", "current_text", "required_fix"],
                        additionalProperties: false
                    }
                },
                strengths: { type: "array", items: { type: "string" } },
                revision_needed: { type: "boolean" },
                revised_scenes: {
                    type: "array",
                    items: {
                        // Replicate Scene Schema structure for revised scenes
                        type: "object",
                        properties: {
                            scene_number: { type: "number" },
                            timestamp: { type: "string" },
                            title: { type: "string" },
                            prompt: { type: "string" },
                            technical_breakdown: {
                                type: "object",
                                properties: {
                                    cinematography: { type: "string" },
                                    subject: { type: "string" },
                                    action: { type: "string" },
                                    context: { type: "string" },
                                    style_ambiance: { type: "string" }
                                },
                                required: ["cinematography", "subject", "action", "context", "style_ambiance"],
                                additionalProperties: false
                            },
                            audio: {
                                type: "object",
                                properties: {
                                    dialogue: { type: ["string", "null"] },
                                    sfx: { type: "array", items: { type: "string" } },
                                    ambient: { type: "string" }
                                },
                                required: ["dialogue", "sfx", "ambient"],
                                additionalProperties: false
                            },
                            consistency_check: {
                                type: "object",
                                properties: {
                                    character_ids: { type: "array", items: { type: "string" } },
                                    object_ids: { type: "array", items: { type: "string" } },
                                    location_id: { type: "string" }
                                },
                                required: ["character_ids", "object_ids", "location_id"],
                                additionalProperties: false
                            },
                            duration: { type: "number" }
                        },
                        required: ["scene_number", "timestamp", "title", "prompt", "technical_breakdown", "audio", "consistency_check", "duration"],
                        additionalProperties: false
                    }
                }
            },
            required: ["validation_status", "overall_score", "issues_found", "strengths", "revision_needed", "revised_scenes"],
            additionalProperties: false
        }
    }
};

// Safety Schema (Stage 0)
const SECURITY_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "safety_check",
        strict: true,
        schema: {
            type: "object",
            properties: {
                safe: { type: "boolean" },
                violations: { type: "array", items: { type: "string" } },
                severity: { type: "string", enum: ["BLOCK", "WARNING", "SAFE"] },
                suggested_alternative: { type: "string" }
            },
            required: ["safe", "violations", "severity", "suggested_alternative"],
            additionalProperties: false
        }
    }
};

// Asset Sheet Schema (Stage 1) - Strict
const ASSET_SHEET_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "asset_sheet",
        strict: true,
        schema: {
            type: "object",
            properties: {
                project_metadata: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        duration_seconds: { type: "number" },
                        total_scenes: { type: "number" },
                        category: { type: "string", enum: ["entertainment", "commercial", "creative"] },
                        visual_style: { type: "string" }
                    },
                    required: ["title", "duration_seconds", "total_scenes", "category", "visual_style"],
                    additionalProperties: false
                },
                character_bible: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            role: { type: "string" },
                            age: { type: "string" },
                            gender: { type: "string" },
                            ethnicity: { type: "string" },
                            physical_description: {
                                type: "object",
                                properties: {
                                    height: { type: "string" },
                                    build: { type: "string" },
                                    hair: { type: "string" },
                                    eyes: { type: "string" },
                                    skin_tone: { type: "string" },
                                    distinctive_features: { type: "array", items: { type: "string" } }
                                },
                                required: ["hair", "eyes", "skin_tone", "distinctive_features", "height", "build"],
                                additionalProperties: false
                            },
                            costume: {
                                type: "object",
                                properties: {
                                    primary_outfit: { type: "string" },
                                    accessories: { type: "array", items: { type: "string" } },
                                    footwear: { type: "string" }
                                },
                                required: ["primary_outfit", "accessories", "footwear"],
                                additionalProperties: false
                            },
                            personality_note: { type: "string" }
                        },
                        required: ["id", "role", "age", "gender", "ethnicity", "physical_description", "costume", "personality_note"],
                        additionalProperties: false
                    }
                },
                object_bible: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            description: { type: "string" },
                            consistency_rules: { type: "string" }
                        },
                        required: ["id", "name", "description", "consistency_rules"],
                        additionalProperties: false
                    }
                },
                location_bible: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            description: { type: "string" },
                            lighting_default: { type: "string" },
                            ambient_sound_default: { type: "string" }
                        },
                        required: ["id", "name", "description", "lighting_default", "ambient_sound_default"],
                        additionalProperties: false
                    }
                },
                brand_elements: {
                    type: "object",
                    properties: {
                        product_name: { type: ["string", "null"] },
                        product_description: { type: ["string", "null"] },
                        integration_style: { type: ["string", "null"] }
                    },
                    required: ["product_name", "product_description", "integration_style"],
                    additionalProperties: false
                },
                tone_and_style: {
                    type: "object",
                    properties: {
                        genre: { type: "string" },
                        mood: { type: "string" },
                        color_palette: { type: "array", items: { type: "string" } },
                        film_reference: { type: "string" },
                        camera_philosophy: { type: "string" }
                    },
                    required: ["genre", "mood", "color_palette", "film_reference", "camera_philosophy"],
                    additionalProperties: false
                },
                scene_progression_blueprint: {
                    type: "array",
                    description: "List of narrative beats for each scene",
                    items: {
                        type: "object",
                        properties: {
                            scene_id: { type: "integer" },
                            narrative_beat: { type: "string" }
                        },
                        required: ["scene_id", "narrative_beat"],
                        additionalProperties: false
                    }
                }
            },
            required: ["project_metadata", "character_bible", "object_bible", "location_bible", "brand_elements", "tone_and_style", "scene_progression_blueprint"],
            additionalProperties: false
        }
    }
};

/**
 * STAGE 0: SAFETY CHECK
 */
const _stage0_safety_check = async (storyText) => {
    const prompt = `
    You are a content safety specialist. Analyze this creative brief for policy violations.

    USER BRIEF: ${storyText}

    Check for:
    1. Sexual or explicit adult content
    2. Content involving minors in harmful contexts
    3. Graphic realistic violence or gore
    4. Hate speech or discrimination
    5. Instructions for illegal activities
    6. Identifiable real people without consent

    If the brief is creative (horror, action, commercial) but within acceptable bounds, mark as SAFE.
    `;
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: SECURITY_SCHEMA,
        temperature: 0.3
    });

    return JSON.parse(completion.choices[0].message.content);
};

/**
 * STAGE 1: PLANNING
 * Purpose: Lock down all visual elements BEFORE generating scenes.
 */
// ==========================================
// ==========================================
// ANTI-REPETITION FIX: ENSURE UNIQUE SCENES
// ==========================================

// STAGE 1 UPDATE: Add narrative progression blueprint

// STAGE 1 UPDATE: Add narrative progression blueprint

export const stage1_planning = async (storyText, duration, category = 'creative') => {
    logger.info({ storyText, duration, category }, "🎬 Stage 1: Generating Asset Sheet...");

    // Parse duration
    let durationSeconds = 8;
    if (typeof duration === 'string') {
        const match = duration.match(/(\d+)/);
        if (match) durationSeconds = parseInt(match[1]);
    } else if (typeof duration === 'number') {
        durationSeconds = duration;
    }

    const scenesNeeded = Math.ceil(durationSeconds / 8);

    logger.info({
        durationSeconds,
        scenesNeeded,
        calculation: `Math.ceil(${durationSeconds} / 8) = ${scenesNeeded}`
    }, "Scene calculation");

    const prompt = `
You are a professional film production planner. Create a detailed asset specification sheet.

USER BRIEF: ${storyText}
DURATION: ${durationSeconds} seconds
CATEGORY: ${category}

CRITICAL REQUIREMENT: You MUST generate EXACTLY ${scenesNeeded} scenes.

SCENE PLANNING LOGIC:
- Total duration: ${durationSeconds} seconds
- Each scene = 8 seconds (one Veo generation)
- Required scenes: ${scenesNeeded}

Examples:
- 8 seconds  → 1 scene  (single moment)
- 15 seconds → 2 scenes (setup + payoff)
- 30 seconds → 4 scenes (beginning, development, climax, resolution)
- 60 seconds → 8 scenes (full story arc with multiple beats)

====================
CRITICAL: NARRATIVE PROGRESSION BLUEPRINT
====================

For ${scenesNeeded} scenes, you MUST create a SCENE-BY-SCENE story progression that ensures:

1. NO REPETITION: Each scene shows a DIFFERENT moment/action/location
2. CLEAR PROGRESSION: Scenes must advance the story chronologically
3. DISTINCT BEATS: Each scene has a unique narrative purpose

Create a "scene_progression_blueprint" list of objects:

EXAMPLE for 4 scenes (30 seconds):
[
  { "scene_id": 1, "narrative_beat": "Establishing shot - introduce character and setting" },
  { "scene_id": 2, "narrative_beat": "Inciting incident - character discovers/encounters something" },
  { "scene_id": 3, "narrative_beat": "Rising action - character responds/investigates" },
  { "scene_id": 4, "narrative_beat": "Climax/resolution - dramatic conclusion or revelation" }
]

EXAMPLE for 8 scenes (60 seconds):
[
  { "scene_id": 1, "narrative_beat": "Wide establishing - show world/environment" },
  { "scene_id": 2, "narrative_beat": "Introduce protagonist - show their current state" },
  { "scene_id": 3, "narrative_beat": "Inciting incident - problem/discovery appears" },
  { "scene_id": 4, "narrative_beat": "First reaction - character begins to respond" },
  { "scene_id": 5, "narrative_beat": "Complication - situation escalates or changes" },
  { "scene_id": 6, "narrative_beat": "Turning point - crucial decision made" },
  { "scene_id": 7, "narrative_beat": "Climax - peak of action/emotion" },
  { "scene_id": 8, "narrative_beat": "Resolution - show aftermath/new status quo" }
]

ANTI-REPETITION RULES:
- Scene 2 cannot show the same action as Scene 1
- Each scene must have a unique camera position or subject focus
- If Scene 1 is "character walks", Scene 2 must be "character arrives" or "character discovers"
- Avoid phrases like "continues to" or "still walking" - each scene is a NEW beat

CHARACTER BIBLE RULES:
1. FORENSICALLY detailed - specific enough to draw
2. Exact color names: "cobalt blue" not "blue"
3. 3-5 DISTINCTIVE FEATURES in CAPS (appear in EVERY scene)
4. Measurements: "5'4\"", "6-foot tall"

OBJECT BIBLE RULES:
1. Exact dimensions, colors, materials
2. Brand names if relevant
3. Consistency anchors

LOCATION BIBLE RULES:
1. Specific lighting conditions
2. Ambient sound defaults
3. Architectural details

ADDITIONAL REQUIRED FIELD:
Add a "scene_progression_blueprint" object to your output with ${scenesNeeded} entries defining what makes each scene unique.

Generate the complete asset sheet now following the strict JSON schema.
`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: ASSET_SHEET_SCHEMA,
        temperature: 0.7
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // VALIDATION: Verify scene count
    if (parsed.project_metadata.total_scenes !== scenesNeeded) {
        logger.error({
            expected: scenesNeeded,
            got: parsed.project_metadata.total_scenes
        }, "❌ CRITICAL: Wrong scene count!");
        parsed.project_metadata.total_scenes = scenesNeeded;
    }

    // ADD: Scene progression blueprint if missing
    if (!parsed.scene_progression_blueprint) {
        logger.warn("⚠️ No scene progression blueprint found, adding default");
        parsed.scene_progression_blueprint = generateDefaultProgression(scenesNeeded);
    }

    logger.info({
        scenes: parsed.project_metadata.total_scenes,
        duration: durationSeconds,
        has_blueprint: !!parsed.scene_progression_blueprint,
        character_count: parsed.character_bible?.length || 0,
        first_character: parsed.character_bible?.[0] ? { role: parsed.character_bible[0].role, id: parsed.character_bible[0].id } : 'None'
    }, "✅ Stage 1 Complete - Asset Sheet Debug");

    return { assetSheet: parsed, usage: completion.usage };
};

// Helper: Generate default progression if GPT-4 fails
const generateDefaultProgression = (sceneCount) => {
    const progressions = {
        1: [
            { scene_id: 1, narrative_beat: "Complete moment showing setup and resolution" }
        ],
        2: [
            { scene_id: 1, narrative_beat: "Establishing shot introducing character/situation" },
            { scene_id: 2, narrative_beat: "Action/reaction or dramatic reveal" }
        ],
        4: [
            { scene_id: 1, narrative_beat: "Establishing - introduce world and character" },
            { scene_id: 2, narrative_beat: "Inciting incident - problem/discovery appears" },
            { scene_id: 3, narrative_beat: "Rising action - character responds to situation" },
            { scene_id: 4, narrative_beat: "Climax/resolution - dramatic conclusion" }
        ],
        8: [
            { scene_id: 1, narrative_beat: "Wide establishing shot of environment" },
            { scene_id: 2, narrative_beat: "Introduce protagonist in their element" },
            { scene_id: 3, narrative_beat: "Inciting incident triggers story" },
            { scene_id: 4, narrative_beat: "First reaction - character begins response" },
            { scene_id: 5, narrative_beat: "Complication - situation escalates" },
            { scene_id: 6, narrative_beat: "Turning point - crucial decision made" },
            { scene_id: 7, narrative_beat: "Climax - peak action/emotion" },
            { scene_id: 8, narrative_beat: "Resolution - new equilibrium established" }
        ]
    };

    return progressions[sceneCount] || progressions[4];
};

// ==========================================
// STAGE 2 UPDATE: Use blueprint to prevent repetition
// ==========================================

const _stage2_generation = async (assetSheet, options = {}) => {
    logger.info("🎥 Stage 2: Generating Veo 3.1 Prompts...");

    const { plan = 'basic', productionStyle, visualMood } = options;
    const directorPersona = getDirectorPersona(plan);
    const styleDirective = productionStyle ? PRODUCTION_STYLES[productionStyle] : '';
    const moodDirective = visualMood ? VISUAL_MOODS[visualMood] : '';

    // Extract scene progression blueprint
    const blueprint = assetSheet.scene_progression_blueprint || generateDefaultProgression(assetSheet.project_metadata.total_scenes);

    const safetyDirective = `
====================
SAFETY & COMPLIANCE DIRECTIVE:
====================
The video engine (Veo 3.1) has strict safety filters. 
DO NOT include any of the following in your prompts:
- Weapons of any kind (guns, knives, explosives)
- Physical violence, blood, or gore
- Illegal acts, drug use, or extreme grit
- Specific copyrighted logos or brand names
Focus on atmospheric lighting, character mystery, and cinematic environment to convey tension without using prohibited elements.
`;

    const prompt = `
${directorPersona}
${styleDirective}
${moodDirective}
${safetyDirective}

You are an expert Veo 3.1 prompt engineer. Generate ${assetSheet.project_metadata.total_scenes} UNIQUE 8-second video prompts.

ASSET SHEET:
${JSON.stringify(assetSheet, null, 2)}

====================
CRITICAL: ANTI-REPETITION REQUIREMENTS
====================

SCENE PROGRESSION BLUEPRINT (FOLLOW THIS EXACTLY):
${JSON.stringify(blueprint, null, 2)}

Each scene MUST:
1. Match its blueprint purpose exactly
2. Show a DIFFERENT action/moment than previous scenes
3. Have a DISTINCT camera angle or subject focus
4. Advance the narrative forward

FORBIDDEN:
- ❌ Two scenes showing the same action (e.g., "walking" in Scene 1 and Scene 2)
- ❌ Repeating the same camera angle consecutively
- ❌ Using phrases like "continues to" or "still doing"
- ❌ Same environment/lighting without progression
- ❌ Identical subject positions between scenes

REQUIRED:
- ✅ Each scene shows a NEW story beat
- ✅ Camera positions vary between scenes (if Scene 1 is wide, Scene 2 could be medium)
- ✅ Character performs DIFFERENT actions in each scene
- ✅ Time progression is evident (environmental changes, character state changes)

====================
EXAMPLE PROGRESSION (4 scenes - Detective Story):
====================

Scene 1 (Establishing):
- Blueprint: "Establishing - introduce world and character"
- Action: Detective WALKS into alley, approaching crime scene
- Camera: Wide shot showing environment
- Key difference: This is the ARRIVAL moment

Scene 2 (Discovery):
- Blueprint: "Inciting incident - problem/discovery appears"  
- Action: Detective KNEELS DOWN, examining data chip on ground
- Camera: Medium shot focusing on detective and chip
- Key difference: This is the INVESTIGATION moment (NOT walking anymore)

Scene 3 (Reaction):
- Blueprint: "Rising action - character responds"
- Action: Detective PICKS UP chip, examining it in his hand
- Camera: Extreme close-up on hand and chip
- Key difference: This is the INTERACTION moment (NOT examining ground anymore)

Scene 4 (Revelation):
- Blueprint: "Climax - dramatic conclusion"
- Action: Detective STANDS UP as hologram APPEARS behind him
- Camera: Low angle showing both characters
- Key difference: This is the CONFRONTATION moment (new character appears)

Notice: Each scene has DIFFERENT:
- Action verb (walks → kneels → picks up → stands)
- Camera distance (wide → medium → extreme close-up → low angle)
- Narrative purpose (arrival → investigation → interaction → revelation)

====================
WORD COUNT REQUIREMENTS:
====================

PER TIMESTAMP:
- Minimum: 60 words
- Maximum: 80 words
- Target: 70 words

PER SCENE:
- Total: 250-320 words (4 timestamps × 70-80 words)

====================
STRUCTURE (75 words per timestamp):
====================

1. Shot Type (5 words): "Wide establishing shot" or "Medium close-up"
2. Environment (25 words): Location details, lighting, atmosphere
3. Subject (25 words): Character/object with CAPS features, clothing, action
4. Style (20 words): Cinematography, film reference, audio

====================
EXAMPLE TIMESTAMP (75 words):
====================

[00:00-00:02] Wide establishing shot, narrow rain-soaked alleyway with vibrant pink and cyan neon signs reflecting off wet cobblestone pavement, steam rising from metal grates, distant city lights creating depth. DETECTIVE with CYBERNETIC GOLD ARM glinting under neon reflections, wearing dark leather trench coat, SCAR ON LEFT CHEEK visible in pink light, approaches camera through heavy rain with determined stride. Chiaroscuro lighting with deep shadows and bright neon highlights, neo-noir aesthetic shot on vintage anamorphic lenses, moody atmospheric tone. SFX: Heavy rain, footsteps splashing. Ambient: Urban night sounds, neon hum.

====================
GENERATION STRATEGY FOR MULTI-SCENE VIDEOS:
====================

When generating Scene N, remember:
- Scene 1 has already shown [previous action]
- Scene 2 has already shown [previous action]
- Scene N must show [NEW action from blueprint]

For each scene, ask yourself:
1. Does this scene show a different action than the previous one?
2. Does this match the blueprint purpose for this scene number?
3. Would someone watching notice a clear progression?

If the answer to any is "no", revise the scene.

====================
MANDATORY REQUIREMENTS:
====================

1. WORD COUNT: Each timestamp 60-80 words, total scene 250-320 words
2. DISTINCTIVE FEATURES: CAPS in EVERY timestamp
3. SHOT VARIETY WITHIN SCENE: Wide → Medium → Close-up → Dynamic
4. SCENE VARIETY ACROSS VIDEO: Each scene shows unique narrative beat
5. CONSISTENCY: Character descriptions identical across ALL timestamps and scenes
6. PROGRESSION: Each scene advances story according to blueprint

====================
JSON OUTPUT:
====================

{
  "scenes": [
    {
      "scene_number": 1,
      "timestamp": "[00:00-00:08]",
      "title": "3-5 word title reflecting unique beat",
      "prompt": "All 4 timestamps (240-360 words total)",
      "blueprint_adherence": "How this scene fulfills its blueprint purpose",
      "unique_elements": ["List 2-3 things that make this scene different from others"],
      "technical_breakdown": {
        "cinematography": "Brief summary of shot progression",
        "subject": "Who/what appears",
        "action": "What happens",
        "context": "Where it happens",
        "style_ambiance": "Visual style and mood"
      },
      "audio": {
        "dialogue": "Spoken lines or null",
        "sfx": ["array", "of", "sounds"],
        "ambient": "background atmosphere"
      },
      "consistency_check": {
        "character_ids": ["ids from asset sheet"],
        "object_ids": ["ids from asset sheet"],
        "location_id": "id from asset sheet"
      },
      "duration": 8
    }
  ],
  "narrative_flow": "How scenes connect narratively",
  "audio_continuity": "How audio evolves across scenes"
}

====================
QUALITY CHECKLIST:
====================

Before submitting, verify:
- [ ] Each scene matches its blueprint purpose
- [ ] No two scenes show the same action
- [ ] Character performs different action in each scene
- [ ] Camera angles vary between scenes
- [ ] Each scene word count is 250-320 words
- [ ] Distinctive features in CAPS in all timestamps across all scenes
- [ ] Narrative progresses logically scene to scene

Generate ${assetSheet.project_metadata.total_scenes} UNIQUE scenes now.
`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: SCENE_SCHEMA,
        temperature: 0.7
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // VALIDATION: Check for repetition
    const countWords = (text) => text.trim().split(/\s+/).length;

    // Extract action verbs from each scene to detect repetition
    const sceneActions = [];

    for (const scene of parsed.scenes) {
        const totalWords = countWords(scene.prompt);

        // Basic repetition detection: Check if scenes contain very similar text
        const sceneText = scene.prompt.toLowerCase();
        sceneActions.push(sceneText);

        // Word count validation
        if (totalWords > 320) {
            logger.error({
                scene_number: scene.scene_number,
                total_words: totalWords,
                target: "250-320 words"
            }, "❌ Scene too long!");
        } else if (totalWords < 250) {
            logger.warn({
                scene_number: scene.scene_number,
                total_words: totalWords
            }, "⚠️ Scene might be too short");
        } else {
            logger.info({
                scene_number: scene.scene_number,
                total_words: totalWords
            }, "✅ Scene length optimal");
        }
    }

    // Check for repetition between consecutive scenes
    for (let i = 1; i < sceneActions.length; i++) {
        const prev = sceneActions[i - 1];
        const curr = sceneActions[i];

        // Simple similarity check: count common significant words
        const prevWords = new Set(prev.split(/\s+/).filter(w => w.length > 4));
        const currWords = new Set(curr.split(/\s+/).filter(w => w.length > 4));

        const commonWords = [...prevWords].filter(w => currWords.has(w));
        const similarity = commonWords.length / Math.max(prevWords.size, currWords.size);

        if (similarity > 0.6) {
            logger.warn({
                scene_pair: `${i} and ${i + 1}`,
                similarity: `${Math.round(similarity * 100)}%`,
                common_words: commonWords.slice(0, 5)
            }, "⚠️ High similarity detected between consecutive scenes!");
        }
    }

    const avgWords = Math.round(
        parsed.scenes.reduce((sum, s) => sum + countWords(s.prompt), 0) / parsed.scenes.length
    );

    logger.info({
        scene_count: parsed.scenes.length,
        avg_words: avgWords,
        target: "300 words"
    }, "✅ Stage 2 Complete");

    return { scenesData: parsed, usage: completion.usage };
};

/**
 * STAGE 3: VALIDATION & QA
 * Purpose: Automated quality check to catch inconsistencies before delivery.
 */
// ==========================================
// STAGE 3 UPDATE: Add repetition check to validation
// ==========================================

const _stage3_validation = async (assetSheet, scenesData) => {
    logger.info("✅ Stage 3: Validating Quality...");

    const prompt = `
You are a quality assurance specialist for film production. Validate against repetition and consistency issues.

ASSET SHEET:
${JSON.stringify(assetSheet, null, 2)}

GENERATED SCENES:
${JSON.stringify(scenesData, null, 2)}

VALIDATION CHECKLIST:

1. ANTI-REPETITION CHECK (CRITICAL FOR MULTI-SCENE VIDEOS)
   - [ ] Each scene shows a DIFFERENT action/moment
   - [ ] No two consecutive scenes have the same camera angle
   - [ ] No phrases like "continues to" or "still doing"
   - [ ] Each scene advances the narrative forward
   - [ ] Character performs different actions in each scene

2. TIMESTAMP STRUCTURE
   - [ ] Each scene has 4 timestamps: [00:00-00:02], [00:02-00:04], [00:04-00:06], [00:06-00:08]
   - [ ] Total prompt length 240-360 words per scene

3. CHARACTER CONSISTENCY
   - [ ] Distinctive features in CAPS in EVERY timestamp in EVERY scene
   - [ ] Same character descriptions across all scenes
   - [ ] Clothing consistent throughout

4. NARRATIVE PROGRESSION
   - [ ] Scenes follow a logical story arc
   - [ ] Each scene has unique narrative purpose
   - [ ] No redundant or repetitive scenes

5. CINEMATOGRAPHY
   - [ ] Shot variety within each scene
   - [ ] Different camera angles between scenes
   - [ ] No static or repetitive compositions

CRITICAL ISSUE EXAMPLES:

REPETITION ISSUES (HIGHEST PRIORITY):
- Scene 1 and Scene 2 both show "character walking" → CRITICAL
- Two consecutive scenes with same camera angle → CRITICAL  
- Scene describes "continues from previous" → CRITICAL
- Identical actions across scenes → CRITICAL

CONSISTENCY ISSUES:
- Distinctive feature missing in a timestamp → MODERATE
- Character description changes between scenes → CRITICAL
- Wrong word count → MODERATE

OUTPUT FORMAT:
{
  "validation_status": "PASS|FAIL|NEEDS_REVISION",
  "overall_score": 8.5,
  "issues_found": [
    {
      "severity": "CRITICAL|MODERATE|MINOR",
      "category": "repetition|consistency|word_count|cinematography",
      "scene_number": number,
      "issue": "Description",
      "current_text": "text",
      "required_fix": "fix"
    }
  ],
  "strengths": ["array"],
  "revision_needed": boolean,
  "revised_scenes": []
}

If scenes are repetitive, YOU MUST revise them to be unique and include in revised_scenes array.
`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: VALIDATION_SCHEMA,
        temperature: 0.3
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // Log repetition issues specifically
    const repetitionIssues = parsed.issues_found.filter(i => i.category === 'repetition');
    if (repetitionIssues.length > 0) {
        logger.warn({
            count: repetitionIssues.length,
            issues: repetitionIssues.map(i => i.issue)
        }, "⚠️ Scene repetition detected!");
    }

    logger.info({
        score: parsed.overall_score,
        status: parsed.validation_status,
        repetition_issues: repetitionIssues.length
    }, "✅ Stage 3 Complete");

    return { validationReport: parsed, usage: completion.usage };
};

// HELPER: Motion Complexity Derivation
const deriveMotionComplexity = (cinematographyText) => {
    if (!cinematographyText) return 50;
    const lower = cinematographyText.toLowerCase();
    if (lower.includes('static') || lower.includes('tripod')) return 10;
    if (lower.includes('pan') || lower.includes('tilt')) return 40;
    if (lower.includes('dolly') || lower.includes('tracking')) return 70;
    if (lower.includes('fpv') || lower.includes('drone') || lower.includes('fast')) return 90;
    return 50;
};

// HELPER: Audio Directive Formatting
const formatAudioDirective = (audio) => {
    if (!audio) return "Ambient sound";
    const parts = [];
    if (audio.dialogue) parts.push(`Dialogue: "${audio.dialogue}"`);
    if (audio.sfx && Array.isArray(audio.sfx) && audio.sfx.length) parts.push(`SFX: ${audio.sfx.join(', ')} `);
    if (audio.ambient) parts.push(`Ambient: ${audio.ambient} `);
    return parts.join(' | ');
};

// HELPER: Time Parsing
const calculateDuration = (timestamp) => {
    if (!timestamp) return 5;
    // Parse "[00:00-00:08]" → 8 seconds
    const match = timestamp.match(/\[(\d+):(\d+)-(\d+):(\d+)\]/);
    if (!match) return 5;
    const start = parseInt(match[1]) * 60 + parseInt(match[2]);
    const end = parseInt(match[3]) * 60 + parseInt(match[4]);
    return Math.max(end - start, 3); // Min 3s
};


/**
 * Generate a cinematic script using the 3-Stage Pipeline (Planning -> Generation -> Validation).
 */
export const generateScript = async (storyText, options = {}) => {
    // 1. SAFETY CHECK (Stage 0)
    // NOTE: If story is empty or too short, we might skip, but good to be safe.
    const safetyCheck = await _stage0_safety_check(storyText);
    if (safetyCheck.severity === 'BLOCK') {
        logger.warn({ violations: safetyCheck.violations }, "Safety Check Blocked Request");
        throw new Error(`SAFETY_VIOLATION: ${safetyCheck.violations.join(', ')}.Suggestion: ${safetyCheck.suggested_alternative} `);
    }
    if (safetyCheck.severity === 'WARNING') {
        logger.warn({ violations: safetyCheck.violations }, "Safety Check Warning (Proceeding)");
    }

    const tierOptions = typeof options === 'string' ? { plan: options } : options;
    const { plan = 'basic', length = 'standard' } = tierOptions;

    // Constraints & Durations (Base=8s, Pro=32s, Elite=64s)
    // Support both legacy "extended" and new explicit "30s"/"60s" from frontend
    // Constraints & Durations (Base=8s, Pro=32s, Elite=64s)
    let requestedSeconds = 8;

    // 1. Parse Requested Length
    if (length === '60s') requestedSeconds = 64;
    else if (length === '30s') requestedSeconds = 32;
    else if (length === 'extended') requestedSeconds = (plan === 'elite') ? 64 : 32;

    // 2. Determine Plan Cap
    let planCap = 8;
    if (plan === 'elite') planCap = 64;
    else if (plan === 'pro') planCap = 32;

    // 3. Enforce Limit
    const finalSeconds = Math.min(requestedSeconds, planCap);
    const durationString = `${finalSeconds} seconds`;

    if (finalSeconds !== requestedSeconds) {
        logger.warn({ plan, requested: length, enforced: durationString }, "⚠️ Duration capped by plan limit");
    } else {
        logger.info({ plan, duration: durationString }, "✅ Duration within plan limits");
    }


    // --- EXECUTE PIPELINE ---
    return await callWithRetry(async () => {
        // 2. Stage 1: Planning
        const { assetSheet, usage: u1 } = await stage1_planning(storyText, durationString);

        // 3. Stage 2: Generation (Injecting styles/moods)
        const { scenesData, usage: u2 } = await _stage2_generation(assetSheet, tierOptions);

        // 4. Stage 3: Validation
        const { validationReport, usage: u3 } = await _stage3_validation(assetSheet, scenesData);

        // 5. Merge / Revision Logic (Improved merging)
        // Apply revisions BEFORE checking the final quality score
        let finalScenes = scenesData.scenes;
        let selfHealed = false;

        if (validationReport.revision_needed && validationReport.revised_scenes && validationReport.revised_scenes.length > 0) {
            logger.warn({
                original_count: finalScenes.length,
                revised_count: validationReport.revised_scenes.length,
                issues: validationReport.issues_found
            }, "⚠️ Applying validation corrections (Self-Healing active)");

            // Optimistic replacement
            if (validationReport.revised_scenes.length === finalScenes.length) {
                finalScenes = validationReport.revised_scenes;
            } else {
                const revisedMap = new Map(validationReport.revised_scenes.map(s => [s.scene_number, s]));
                finalScenes = finalScenes.map(scene => {
                    const revised = revisedMap.get(scene.scene_number);
                    if (revised) {
                        logger.info({ scene_number: scene.scene_number }, "Applying correction");
                        return revised;
                    }
                    return scene;
                });
            }
            selfHealed = true;
        }

        // QUALITY GATE
        const MIN_PRODUCTION_SCORE = 8.5;
        const MIN_ACCEPTABLE_SCORE = 7.5;

        // Strict Enforcement - BUT allow passing if we just applied a fix
        if (validationReport.overall_score < MIN_ACCEPTABLE_SCORE && !selfHealed) {
            const criticalIssues = validationReport.issues_found.filter(i => i.severity === 'CRITICAL');
            logger.error({
                score: validationReport.overall_score,
                issues: criticalIssues
            }, "❌ Quality check failed (No auto-fix available)");

            // Throw to stop delivery of bad scripts
            throw new Error(
                `Quality check failed: Score ${validationReport.overall_score}/10 is below minimum (${MIN_ACCEPTABLE_SCORE}). ` +
                `Critical issues: ${criticalIssues.map(i => i.issue).join('; ')}`
            );
        }

        if (selfHealed) {
            logger.info("✅ Quality check failed initially, but script was self-healed by auto-revision.");
        } else if (validationReport.overall_score < MIN_PRODUCTION_SCORE) {
            logger.warn({ score: validationReport.overall_score, target: MIN_PRODUCTION_SCORE }, "⚠️ Quality score below production standard but acceptable.");
        }

        // 6. Mapping to Database Format (High Fidelity)
        const mappedScenes = finalScenes.map((s, i) => ({
            scene_id: s.scene_number || (i + 1),
            // The "Prompt" is the action description for the DB
            action_description: s.prompt,
            shot_type: s.technical_breakdown?.cinematography || "Cinematic Shot",
            motion_complexity: deriveMotionComplexity(s.technical_breakdown?.cinematography),
            audio_directive: formatAudioDirective(s.audio),
            duration: s.duration || calculateDuration(s.timestamp),

            // Metadata for debugging
            character_ids: s.consistency_check?.character_ids || [],
            object_ids: s.consistency_check?.object_ids || []
        }));

        const totalTokens = (u1?.total_tokens || 0) + (u2?.total_tokens || 0) + (u3?.total_tokens || 0);
        const promptTokens = (u1?.prompt_tokens || 0) + (u2?.prompt_tokens || 0) + (u3?.prompt_tokens || 0);
        const completionTokens = (u1?.completion_tokens || 0) + (u2?.completion_tokens || 0) + (u3?.completion_tokens || 0);

        return {
            scenes: mappedScenes,
            suggested_title: assetSheet.project_metadata?.title || "Untitled Project",
            // Return the Asset Sheet so Controller can save it to DB
            assetSheet: assetSheet,
            validationReport: validationReport,
            usage: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: completionTokens,
                totalTokenCount: totalTokens
            }
        };
    });
};

export const generateHeroImage = async (actionDescription, userInstructions = "") => {
    try {
        const openai = getOpenAI();
        let prompt;
        if (userInstructions) {
            prompt = `Professional character portrait based on user request: "${userInstructions}". Context: ${actionDescription}. Photorealistic, cinematic lighting, 8k quality.`;
        } else {
            prompt = `Professional character portrait for: ${actionDescription}. Photorealistic, cinematic lighting, 8k quality.`;
        }

        logger.info({ prompt }, 'Generating hero image with DALL-E');

        try {
            const response = await openai.images.generate({
                model: "dall-e-3",
                prompt: prompt,
                n: 1,
                size: "1024x1024",
                quality: "standard"
            });
            const imageUrl = response.data[0].url;

            // PERSISTENCE: Download from OpenAI and upload to Railway/S3 Storage
            // Only if storage is configured (Railway prod)
            if (isStorageConfigured()) {
                try {
                    logger.info("Downloading hero image from OpenAI for persistence...");
                    const imgRes = await fetch(imageUrl);
                    if (!imgRes.ok) throw new Error("Failed to download image from OpenAI");

                    const arrayBuffer = await imgRes.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const key = buildObjectKey({
                        userId: 'hero-assets', // Generic folder or use specific if passed
                        extension: 'png'
                    });

                    const validStorageUrl = await uploadBufferToStorage({
                        buffer,
                        key,
                        contentType: 'image/png'
                    });

                    logger.info({ validStorageUrl }, "Hero image persisted to storage");
                    return validStorageUrl;
                } catch (persistErr) {
                    logger.error({ err: persistErr }, "Failed to persist hero image to storage, returning temporary URL");
                    return imageUrl; // Fallback to temp URL if storage fails
                }
            }

            return imageUrl;
        } catch (initialError) {
            // If safety violation, try a sanitized/simpler prompt
            if (initialError.message.includes('safety') || initialError.status === 400) {
                logger.warn({ err: initialError }, 'Initial DALL-E prompt rejected, retrying with simplified prompt');

                const safePrompt = `A cinematic portrait of a character in a movie scene. High quality, photorealistic.`;
                const retryResponse = await openai.images.generate({
                    model: "dall-e-3",
                    prompt: safePrompt, // Genuine generic fallback to avoid blocking
                    n: 1,
                    size: "1024x1024",
                    quality: "standard"
                });

                const retryImageUrl = retryResponse.data[0].url;
                if (isStorageConfigured()) {
                    try {
                        const imgRes = await fetch(retryImageUrl);
                        const buffer = Buffer.from(await imgRes.arrayBuffer());
                        const key = buildObjectKey({ userId: 'hero-assets', extension: 'png' });
                        return await uploadBufferToStorage({ buffer, key, contentType: 'image/png' });
                    } catch (e) {
                        return retryImageUrl;
                    }
                }
                return retryImageUrl;
            }
            throw initialError;
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to generate hero image');
        // Don't crash the whole job, just return null or a placeholder if you want
        // But for now throwing is okay as long as the user knows why
        throw new Error(`Hero image generation failed: ${error.message}`);
    }
};

/**
 * Generate a character portrait using DALL-E 3.
 * @param {string} description - The base physical description from the character bible.
 * @param {string} style - The visual style of the project.
 * @param {string} [userPrompt] - Optional user override/instruction for regeneration.
 * @returns {Promise<string>} - The URL of the generated image.
 */
export const generateCharacterPortrait = async (description, style, userPrompt = null) => {
    const openai = getOpenAI();

    let prompt;
    if (userPrompt) {
        // Regeneration Case: User provides specific feedback
        prompt = `Character Design Update: ${userPrompt}. Base Description: ${description}. Style: ${style}. Generate a consistent character portrait sheet, front facing, neutral expression, 8k resolution, cinematic lighting.`;
    } else {
        // Initial Generation Case
        prompt = `Character Reference Portrait: ${description}. Visual Style: ${style}. Front facing, detailed facial features, neutral expression, simple background, 8k resolution, cinematic lighting.`;
    }

    logger.info({ prompt }, 'Generating character portrait with DALL-E');

    try {
        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: "1024x1024",
            quality: "standard"
        });

        const imageUrl = response.data[0].url;

        // Attempt persistence
        if (isStorageConfigured()) {
            try {
                const imgRes = await fetch(imageUrl);
                if (imgRes.ok) {
                    const buffer = Buffer.from(await imgRes.arrayBuffer());
                    const key = buildObjectKey({ userId: 'character-assets', extension: 'png' });
                    return await uploadBufferToStorage({ buffer, key, contentType: 'image/png' });
                }
            } catch (e) {
                logger.warn({ err: e }, "Failed to persist character image, using temp URL");
            }
        }

        return imageUrl;
    } catch (error) {
        logger.error({ err: error }, 'Failed to generate character portrait');
        // Retry logic for safety violations could be added here similar to generateHeroImage
        throw new Error(`Character generation failed: ${error.message}`);
    }
};

/**
 * Generate Video for a Scene using Google Cloud's Veo model via Vertex AI.
 * This function is now the primary video generator.
 * @param {string} prompt - The detailed text prompt for the video.
 * @param {string} heroImageUrl - Optional URL to a character reference image for consistency.
 * @param {object} options - Contains duration, aspectRatio, etc.
 * @returns {Promise<{video_url: string, status: string}>}
 */
export const generateVideo = async (prompt, heroImageUrl, options = {}) => {
    // Authentication and setup logic remains the same
    let projectFromSA = null;
    if (process.env.GCP_SA_KEY) {
        try {
            const saKey = JSON.parse(process.env.GCP_SA_KEY);
            projectFromSA = saKey.project_id;
        } catch (e) {
            logger.warn('Could not parse GCP_SA_KEY for project_id, using env vars');
        }
    } else {
        // Fallback to vertex-key.json if present (matches test-veo.js behavior)
        try {
            const keyPath = path.resolve('./vertex-key.json');
            const keyExists = await fs.access(keyPath).then(() => true).catch(() => false);
            if (keyExists) {
                process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
                const keyData = JSON.parse(await fs.readFile(keyPath, 'utf8'));
                projectFromSA = keyData.project_id;
                logger.info("Using vertex-key.json for authentication");
            }
        } catch (e) {
            logger.warn('Could not load vertex-key.json, using default credentials');
        }
    }
    const project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || projectFromSA;
    const location = process.env.GCP_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    // Model Selection: Check options first (Tier Logic), then Env Var
    const rawModelId = options.videoModel || process.env.VEO_MODEL_ID || process.env.VEO_MODEL;
    const modelId = rawModelId ? rawModelId.trim() : null;

    // Fix for missing bucketName variable
    let bucketName = null;
    if (process.env.GCP_BUCKET_NAME) {
        bucketName = process.env.GCP_BUCKET_NAME;
    }

    if (!project || !modelId) {
        throw new Error("Missing GCP Project ID or Veo Model ID.");
    }

    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const authClient = await auth.getClient();
    const accessTokenResponse = await authClient.getAccessToken();
    const accessToken = accessTokenResponse.token;

    // Log the identity being used so the user knows exactly who to authorize
    const serviceAccountEmail = authClient.email || 'unknown (check GCP_SA_KEY or defaults)';
    logger.info({ serviceAccountEmail }, "Authenticated with Google Cloud Identity");

    if (!accessToken) {
        throw new Error("Failed to get Google Cloud access token.");
    }

    // Build the Veo request payload
    const veoRequest = {
        instances: [
            {
                prompt: prompt
            }
        ],
        parameters: {
            aspectRatio: options.aspectRatio || '16:9',
            sampleCount: 1
            // durationSeconds is not directly supported - Veo generates fixed 8s clips
        }
    };

    if (bucketName) {
        logger.info({ bucket: bucketName }, "GCS bucket available (Veo will decide output mode)");
    } else {
        logger.info("No GCS bucket configured. Veo will return Base64 or default storage URI.");
    }

    // Multi-Reference Image Support (Up to 3 images)
    const heroImageUrls = Array.isArray(heroImageUrl) ? heroImageUrl : (heroImageUrl ? [heroImageUrl] : []);
    if (heroImageUrls.length > 0) {
        try {
            const base64Images = [];
            // Veo supports up to 3 reference images
            for (const url of heroImageUrls.slice(0, 3)) {
                logger.info({ imageUrl: url }, "Fetching character reference image for Veo prompt.");
                const imageResponse = await fetch(url);
                if (imageResponse.ok) {
                    const imageBuffer = await imageResponse.arrayBuffer();
                    const base64Image = Buffer.from(imageBuffer).toString('base64');
                    const contentType = imageResponse.headers.get('content-type') || 'image/png';

                    base64Images.push({
                        bytesBase64Encoded: base64Image,
                        mimeType: contentType
                    });
                }
            }

            if (base64Images.length > 0) {
                // Veo 3.1 "Ingredients to Video" (Reference-to-Video)
                // Supports up to 3 asset reference images to lock character/object identity.
                // Note: v1beta1 REST API often requires snake_case for these specific sub-objects.
                veoRequest.instances[0].reference_images = base64Images.map(img => ({
                    bytes: img.bytesBase64Encoded,
                    mime_type: img.mimeType,
                    type: "asset"
                }));

                logger.info({
                    imageCount: base64Images.length,
                    field: "reference_images"
                }, "Injected multi-image 'Ingredients' into Veo request");
            }
        } catch (error) {
            logger.error({ err: error }, "Failed to process character reference image(s); proceeding with text-only.");
        }
    }

    logger.info({ project, location, modelId }, 'Initializing Vertex AI for Veo');

    try {
        const endpoint = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:predictLongRunning`;
        logger.info({ endpoint }, 'Calling Veo predictLongRunning endpoint');

        const startResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(veoRequest)
        });

        if (!startResponse.ok) {
            const errorBody = await startResponse.text();

            // Check for immediate policy error on start
            if (errorBody.includes("35561574") || errorBody.includes("policy")) {
                throw new Error(`GUARDRAIL_ERROR: ${errorBody}`);
            }

            logger.error({ status: startResponse.status, body: errorBody }, "Veo API start request failed");
            throw new Error(`Veo API start request failed: ${startResponse.status} - ${errorBody}`);
        }

        const operationData = await startResponse.json();
        const operationName = operationData.name;
        if (!operationName) throw new Error("Veo API did not return an operation name");

        logger.info({ operationName }, "Veo video generation started, polling for completion...");

        const pollingEndpoint = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:fetchPredictOperation`;
        const maxPollingAttempts = 120;
        const pollingIntervalMs = 5000;

        let finalResponse = null;

        for (let attempt = 0; attempt < maxPollingAttempts; attempt++) {
            await sleep(pollingIntervalMs);

            const pollResponse = await fetch(pollingEndpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ operationName })
            });

            if (!pollResponse.ok) {
                const errorBody = await pollResponse.text();
                logger.warn({ status: pollResponse.status, body: errorBody }, "Polling failed, retrying...");
                continue;
            }

            const pollData = await pollResponse.json();

            if (pollData.done) {
                if (pollData.error) {
                    const errMsg = pollData.error.message || 'Unknown Veo Error';
                    if (errMsg.includes("third-party content") || errMsg.includes("policy") || errMsg.includes("35561574")) {
                        throw new Error(`GUARDRAIL_ERROR: ${errMsg}`);
                    }
                    throw new Error(`Veo generation failed: ${errMsg}`);
                }

                finalResponse = pollData.response || pollData.result || pollData;
                break;
            }
        }

        if (!finalResponse) {
            throw new Error("Veo video generation timed out after 10 minutes");
        }

        return await extractVideoFromResponse(finalResponse, project, location, modelId, accessToken, bucketName);

    } catch (error) {
        const errorContext = {
            message: error.message,
            promptLength: prompt.length,
            heroImageCount: Array.isArray(heroImageUrl) ? heroImageUrl.length : (heroImageUrl ? 1 : 0),
            bucketConfigured: !!bucketName,
            attemptNumber: options.isRetry ? 2 : 1
        };

        // Guardrail or Generic Generation errors (Auto-Retry with sanitized prompt)
        const isGenericFailure = error.message.includes("Veo could not generate vid");
        if ((error.message.includes("GUARDRAIL_ERROR") || isGenericFailure) && !options.isRetry) {
            logger.warn({ ...errorContext, type: isGenericFailure ? 'generic_fail' : 'guardrail', originalPrompt: prompt },
                "Veo generation failed. Retrying with stripped prompt (removing metadata) to rescue the core narrative...");

            // Fallback strategy: Strip injected metadata (Character Info, Style, etc.)
            // This attempts to keep the user's story while removing potential safety/copyright triggers in the bible.
            let sanitizedPrompt = prompt
                .split('Character Information:')[0]
                .split('Visual Style:')[0]
                .split('Cinematography:')[0]
                .split('Color Palette:')[0]
                .trim();

            // Additional Safety: Remove common "gritty" trigger words that often trip RAI
            const safetyCleanup = (txt) => {
                return txt
                    .replace(/\[\d{2}:\d{2}-\d{2}:\d{2}\]/g, '') // Strip timestamps
                    .replace(/gun|pistol|weapon|knife|blade|blood|kill|dead|corpse|violence|attack|fight|punch/gi, 'heavy shadow')
                    .replace(/smoke|cigarette|cigar|tobacco|wine|whiskey|alcohol|drunk|murder|crime|stolen/gi, 'cinematic mystery')
                    .replace(/noir|gritty|dark alley|sinister/gi, 'atmospheric mystery')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            sanitizedPrompt = safetyCleanup(sanitizedPrompt);

            // If the prompt didn't change (no metadata found), or became too short, fallback to a safe generic structure
            if (sanitizedPrompt === prompt || sanitizedPrompt.length < 10) {
                logger.warn("Prompt stripping yielded no change or too short. Using generic fallback.");
                sanitizedPrompt = `Cinematic scene, high quality, professional lighting, 4k. ${prompt.substring(0, 150)}...`;
            }

            logger.info({ sanitizedPrompt, originalLength: prompt.length, newLength: sanitizedPrompt.length }, "Retrying with sanitized prompt");

            return generateVideo(sanitizedPrompt, heroImageUrl, { ...options, isRetry: true });
        }

        // Internal/transient errors (retry once after delay)
        if ((error.message.includes("Internal error") ||
            error.message.includes("503") ||
            error.message.includes("timeout")) && !options.isRetry) {
            logger.warn({ ...errorContext, type: 'transient' }, "Veo transient error, retrying after 5s delay...");
            await sleep(5000);
            return generateVideo(prompt, heroImageUrl, { ...options, isRetry: true });
        }

        // Permission errors (don't retry)
        if (error.message.includes("permission") || error.message.includes("403")) {
            logger.error({ ...errorContext, type: 'permission' }, "GCS permission error - check service account");
            throw new Error(`GCS Permission Error: Your service account needs storage.objects.create permission on bucket ${bucketName}`);
        }

        logger.error({ ...errorContext, type: 'unknown', stack: error.stack }, "Veo generation failed");
        throw new Error(`Veo Generation Failed: ${error.message}`);
    }
    // End of generateVideo (logic dispatched to extractVideoFromResponse)
};


// Helper to extracting video URL or Base64 from the Veo response
const extractVideoFromResponse = async (responseOrResult, project, location, modelId, accessToken, bucketName) => {
    // CRITICAL DEBUG: Log full response structure for Veo 3.1
    const safeStringify = (obj, maxLen = 2000) => {
        try {
            const str = JSON.stringify(obj, null, 2);
            return str.length > maxLen ? str.substring(0, maxLen) + '...[truncated]' : str;
        } catch {
            return '[Unable to stringify]';
        }
    };

    logger.info({
        responseKeys: responseOrResult ? Object.keys(responseOrResult) : [],
        isArray: Array.isArray(responseOrResult),
        fullResponse: safeStringify(responseOrResult)
    }, "Extracting video from Veo response - FULL DEBUG");

    // Recursive finder
    const findVal = (obj, keys) => {
        if (!obj || typeof obj !== 'object') return null;
        for (const key of keys) {
            if (key in obj && obj[key]) return obj[key];
        }
        for (const k in obj) {
            const found = findVal(obj[k], keys);
            if (found) return found;
        }
        return null;
    };

    // 1. Check for Veo 3.1 predictions array structure
    // Structure: { predictions: [ { video: { uri: "gs://..." } } ] }
    const predictions = responseOrResult?.predictions || responseOrResult?.result?.predictions;

    // CHECK FOR RAI FILTERING (Safety Block)
    const filteredCount = responseOrResult?.raiMediaFilteredCount || responseOrResult?.result?.raiMediaFilteredCount;
    if (filteredCount > 0) {
        const reasons = responseOrResult?.raiMediaFilteredReasons || responseOrResult?.result?.raiMediaFilteredReasons;
        logger.warn({ filteredCount, reasons }, "Veo generation blocked by RAI filters.");
        throw new Error(`GUARDRAIL_ERROR: Video blocked by safety filters. Reasons: ${reasons ? JSON.stringify(reasons) : 'Unknown'}`);
    }

    let videoUrl = null;

    if (predictions && Array.isArray(predictions) && predictions.length > 0) {
        logger.info({ predictionsCount: predictions.length }, "Found predictions array");
        const firstPred = predictions[0];
        videoUrl = firstPred?.video?.uri || firstPred?.videoUri || firstPred?.uri;
        if (videoUrl) {
            logger.info({ videoUrl }, "Found video URI in predictions");
        }
    }

    // 2. Explicit Check for Veo 3.1 GCS URI (Highest Priority)
    const container = Array.isArray(responseOrResult) ? responseOrResult[0] : responseOrResult;

    logger.info({
        hasVideo: !!container?.video,
        hasUri: !!container?.uri,
        hasPredictions: !!container?.predictions,
        containerKeys: container ? Object.keys(container) : []
    }, "Response container structure");

    // Inspect known keys for Veo 3.1
    if (!videoUrl) {
        videoUrl = container?.video?.uri || container?.video?.videoUri || container?.uri || container?.video_uri || container?.gcsUri;
    }

    // 2. Recursive Search for URL if not found directly
    // Added 'video_uri', 'gcs_uri', 'output_uri' to recursive search
    if (!videoUrl) {
        videoUrl = findVal(responseOrResult, ['videoUri', 'gcsUri', 'uri', 'videoUrl', 'url', 'video_uri', 'gcs_uri', 'outputUri']);
    }

    // SECURITY CHECK: If GCS was requested but no URL returned, something is wrong (Permissions?)
    if (process.env.GCP_BUCKET_NAME && !videoUrl) {
        // Check if we have base64 data instead (meaning Veo ignored the GCS config)
        const base64Check = findVal(responseOrResult, ['bytesBase64Encoded', 'base64Encoded']);
        if (!base64Check) {
            const safeLog = (obj) => {
                const seen = new WeakSet();
                return JSON.stringify(obj, (key, value) => {
                    if (typeof value === 'object' && value !== null) {
                        if (seen.has(value)) return '[Circular]';
                        seen.add(value);
                    }
                    if (typeof value === 'string' && value.length > 500) return `[String Length: ${value.length}]`;
                    return value;
                }, 2);
            };
            logger.error({
                bucket: process.env.GCP_BUCKET_NAME,
                responseStructure: safeLog(responseOrResult)
            }, "GCS Bucket configured but no URI returned. Veo likely fell back to Base64 (failed) or error occurred.");
            // Allow fall-through to Base64 handler below if it exists, otherwise error.
        }
    }

    // 3. Base64 Fallback (Only if no URL found OR if we want to handle "ignored config" case gracefully)
    let base64Data = container?.video?.bytesBase64Encoded || container?.bytesBase64Encoded;
    if (!base64Data) {
        base64Data = findVal(responseOrResult, ['bytesBase64Encoded', 'base64Encoded']);
    }

    if (base64Data) {
        logger.info("Found Base64 video data (fallback), processing internally...");
        const videoBuffer = Buffer.from(base64Data, 'base64');
        const tempFilePath = path.join(os.tmpdir(), `veo-output-${Date.now()}.mp4`);
        try {
            await fs.writeFile(tempFilePath, videoBuffer);
            const key = `generated/${crypto.randomUUID()}.mp4`;
            const publicUrl = await uploadFile(tempFilePath, { objectKey: key });

            // If using S3/Railway Storage, return a Signed URL
            if (isStorageConfigured()) {
                try {
                    const signedUrl = await getPresignedDownloadUrl({ key, expiresIn: 3600 });
                    return { video_url: signedUrl, status: 'completed' };
                } catch (signErr) {
                    logger.warn({ err: signErr }, "Failed to generate signed URL, falling back to public URL");
                }
            }
            return { video_url: publicUrl, status: 'completed' };
        } finally {
            await fs.rm(tempFilePath, { force: true }).catch(() => { });
        }
    }

    // 4. Handle GCS URL / found URL
    if (videoUrl && (typeof videoUrl === 'string') && (videoUrl.startsWith('gs://') || videoUrl.startsWith('http'))) {
        logger.info({ foundUrl: videoUrl }, "Found video URL from Veo");

        // If it's a GCS URL, we need to download it securely and re-upload to our public storage
        // because the worker cannot access private GCS links directly.
        if (videoUrl.startsWith('gs://')) {
            try {
                const gsParts = videoUrl.replace('gs://', '').split('/');
                const bucketName = gsParts[0];
                const objectName = gsParts.slice(1).join('/');
                // GCS API requires URI encoded object name
                const gcsApiUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(objectName)}?alt=media`;

                logger.info({ gcsApiUrl }, "Downloading video from GCS using Auth Token...");
                const downloadResponse = await fetch(gcsApiUrl, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });

                if (!downloadResponse.ok) {
                    throw new Error(`Failed to download from GCS: ${downloadResponse.status} ${downloadResponse.statusText}`);
                }

                const videoBuffer = Buffer.from(await downloadResponse.arrayBuffer());
                const tempFilePath = path.join(os.tmpdir(), `gcs-download-${Date.now()}.mp4`);

                await fs.writeFile(tempFilePath, videoBuffer);
                logger.info("Video downloaded locally, uploading to primary storage...");

                const key = `generated/${crypto.randomUUID()}.mp4`;
                const publicUrl = await uploadFile(tempFilePath, { objectKey: key });
                await fs.rm(tempFilePath, { force: true }).catch(() => { });

                logger.info({ publicUrl }, "Video successfully bridged to public storage");

                if (isStorageConfigured()) {
                    try {
                        const signedUrl = await getPresignedDownloadUrl({ key, expiresIn: 3600 });
                        logger.info({ signedUrl }, "Generated Signed URL for Worker access to bridged video");
                        return { video_url: signedUrl, status: 'completed' };
                    } catch (signErr) {
                        logger.error({ err: signErr }, "Failed to generate signed URL, falling back to public URL");
                    }
                }
                return { video_url: publicUrl, status: 'completed' };

            } catch (transferError) {
                logger.error({ err: transferError }, "Failed to transfer video from GCS to Public Storage");
                throw transferError;
            }
        }
        // Fallback for non-gs URLs (unlikely with Veo)
        return { video_url: videoUrl, status: 'completed' };
    }

    throw new Error("No video URL or Base64 data found in Veo response (Recursive search failed)");
};

/**
 * Generate a short, creative title for the project based on the story.
 * Ported from aiService.js to consolidate AI logic.
 */
export const generateTitle = async (story) => {
    if (!story) return null;

    const prompt = `
    Generate a short, creative, and catchy title (3-6 words) for a video based on this story:
    "${story}"
    
    Return ONLY the title. No quotes, no "Title:", just the text.
    `;

    const openai = getOpenAI();

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Cheaper, faster
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
            max_tokens: 20
        });

        const title = completion.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
        return title || null;
    } catch (error) {
        logger.warn({ err: error }, 'Failed to generate AI title');
        return null; // Non-blocking failure
    }
};
