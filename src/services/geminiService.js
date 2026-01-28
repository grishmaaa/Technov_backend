import OpenAI from 'openai';
import { VertexAI } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { uploadFile } from './fileHostingService.js';
import { isStorageConfigured, getPresignedDownloadUrl } from './storageService.js';
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
                }
            },
            required: ["project_metadata", "character_bible", "object_bible", "location_bible", "brand_elements", "tone_and_style"],
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
const _stage1_planning = async (storyText, duration, category = 'creative') => {
    logger.info({ storyText, duration, category }, "🎬 Stage 1: Generating Asset Sheet (Character/Object Bible)...");

    const prompt = `
You are a professional film production planner. Analyze the user's brief and create a detailed asset specification sheet that will ensure perfect consistency across all video scenes.

USER BRIEF: ${storyText}
DURATION: ${duration}
CATEGORY: ${category}

OUTPUT REQUIREMENTS:
Create a structured JSON asset sheet.
CRITICAL RULES:
1. Character descriptions must be FORENSICALLY detailed.
2. Use EXACT color names.
3. Include measurements when relevant.
4. Define consistency anchors.
5. Plan scene count based on duration.
6. For non-commercial content, set brand_elements to null values.
7. Always populate all required fields even if with minimal/null values.
`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: ASSET_SHEET_SCHEMA,
        temperature: 0.7
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    logger.info("✅ Stage 1 Complete.");
    return { assetSheet: parsed, usage: completion.usage };
};

/**
 * STAGE 2: SCENE GENERATION
 * Purpose: Generate professional Veo 3.1 prompts using the locked asset specifications.
 */
const _stage2_generation = async (assetSheet, options = {}) => {
    logger.info("🎥 Stage 2: Generating Scene Prompts...");

    // Inject Tier Options
    const { plan = 'basic', productionStyle, visualMood } = options;
    const directorPersona = getDirectorPersona(plan);
    const styleDirective = productionStyle ? PRODUCTION_STYLES[productionStyle] : '';
    const moodDirective = visualMood ? VISUAL_MOODS[visualMood] : '';

    const prompt = `
${directorPersona}
${styleDirective}
${moodDirective}

You are an expert Veo 3.1 cinematographer. Using the provided asset sheet, generate professional video prompts following the Veo 3.1 specification.

ASSET SHEET:
${JSON.stringify(assetSheet, null, 2)}

VEO 3.1 PROMPT FORMULA:
[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]

AUDIO REQUIREMENTS (MANDATORY):
- Dialogue: Use double quotes. Format: Character says "exact words"
- SFX: SFX: [description]
- Ambient: Ambient noise: [description]

MANDATORY CONSISTENCY RULES:
1. Copy descriptions VERBATIM from character_bible/object_bible for CORE IDENTIFIERS (hair color, eye color, distinct features).
2. ENHANCE the visual description with cinematic details (lighting, texture, atmosphere) that fit the style.
3. Include consistency anchors in EVERY scene.
4. If the asset sheet says "chestnut brown hair", use exactly "chestnut brown hair", but you can add "glistening in the rain".
5. Do not invent CONTRADICTORY features (e.g. don't give a scar if none exists).
6. JSON output must strictly follow the schema.
`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: SCENE_SCHEMA,
        temperature: 0.8
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    logger.info("✅ Stage 2 Complete.");
    return { scenesData: parsed, usage: completion.usage };
};

/**
 * STAGE 3: VALIDATION & QA
 * Purpose: Automated quality check to catch inconsistencies before delivery.
 */
const _stage3_validation = async (assetSheet, scenesData) => {
    logger.info("✅ Stage 3: Validating Quality...");

    const prompt = `
You are a quality assurance specialist for film production. Validate the generated script against the asset sheet and identify any inconsistencies or quality issues.

ASSET SHEET:
${JSON.stringify(assetSheet, null, 2)}

GENERATED SCENES:
${JSON.stringify(scenesData, null, 2)}

VALIDATION CHECKLIST:

1. CHARACTER CONSISTENCY
   - [ ] Physical descriptions match asset sheet exactly in ALL scenes
   - [ ] Hair color/style identical across scenes
   - [ ] Clothing matches character bible
   - [ ] Consistency anchors present in every appearance
   - [ ] Age/build/features consistent

2. OBJECT CONSISTENCY
   - [ ] Object descriptions match asset sheet verbatim
   - [ ] Size/color/material consistent
   - [ ] Distinctive features always mentioned

3. FORMULA COMPLIANCE
   - [ ] Every scene has all 5 parts: Cinematography, Subject, Action, Context, Style
   - [ ] Cinematography uses professional terms
   - [ ] Context includes lighting description
   - [ ] Style references film aesthetic

4. AUDIO COMPLETENESS
   - [ ] Every scene has audio elements
   - [ ] SFX present and appropriate
   - [ ] Ambient noise defined
   - [ ] Dialogue formatted correctly with quotes

5. NARRATIVE FLOW
   - [ ] Scenes connect logically
   - [ ] Timeline makes sense for duration
   - [ ] Visual variety (not repetitive shot types)
   - [ ] Emotional arc present

6. TECHNICAL QUALITY
   - [ ] Prompts are 60-120 words
   - [ ] Professional vocabulary used
   - [ ] Specific (not vague descriptions)
   - [ ] Camera work supports story

OUTPUT FORMAT (JSON):
{
  "validation_status": "PASS|FAIL|NEEDS_REVISION",
  "overall_score": 8.5, // Float 1-10
  "issues_found": [
    {
      "severity": "CRITICAL|MODERATE|MINOR",
      "category": "character_consistency|audio|formula|narrative|technical",
      "scene_number": number,
      "issue": "Description of problem",
      "current_text": "What the script currently says",
      "required_fix": "Exact correction needed"
    }
  ],
  "strengths": ["array of what works well"],
  "revision_needed": boolean,
  "revised_scenes": [
    // Include the FULL corrected scene objects here (same structure as input scenes) if revision is needed.
    // If status is PASS, this array can be empty.
  ]
}

CRITICAL ISSUE EXAMPLES:
- Character hair described as "auburn" in scene 1 but "reddish-brown" in scene 3 → CRITICAL
- Missing audio elements → CRITICAL
- Vague description "the woman" instead of full character details → CRITICAL
- No lighting specified → MODERATE
- Shot type repeated 3 times → MODERATE
- Minor word choice improvement → MINOR

If validation_status is FAIL or NEEDS_REVISION, YOU MUST PROVIDE THE CORRECTED SCENES in the 'revised_scenes' array.
`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: VALIDATION_SCHEMA,
        temperature: 0.3 // Strict low temp for validation
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    logger.info({ score: parsed.overall_score, status: parsed.validation_status }, "✅ Stage 3 Complete.");
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
    if (audio.sfx && Array.isArray(audio.sfx) && audio.sfx.length) parts.push(`SFX: ${audio.sfx.join(', ')}`);
    if (audio.ambient) parts.push(`Ambient: ${audio.ambient}`);
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
        throw new Error(`SAFETY_VIOLATION: ${safetyCheck.violations.join(', ')}. Suggestion: ${safetyCheck.suggested_alternative}`);
    }
    if (safetyCheck.severity === 'WARNING') {
        logger.warn({ violations: safetyCheck.violations }, "Safety Check Warning (Proceeding)");
    }

    const tierOptions = typeof options === 'string' ? { plan: options } : options;
    const { plan = 'basic', length = 'standard' } = tierOptions;

    // Constraints
    const isExtended = length === 'extended';
    const durationString = isExtended ? "60 seconds" : "15 seconds";

    // --- EXECUTE PIPELINE ---
    return await callWithRetry(async () => {
        // 2. Stage 1: Planning
        const { assetSheet, usage: u1 } = await _stage1_planning(storyText, durationString);

        // 3. Stage 2: Generation (Injecting styles/moods)
        const { scenesData, usage: u2 } = await _stage2_generation(assetSheet, tierOptions);

        // 4. Stage 3: Validation
        const { validationReport, usage: u3 } = await _stage3_validation(assetSheet, scenesData);

        // QUALITY GATE
        const MIN_PRODUCTION_SCORE = 8.5;
        const MIN_ACCEPTABLE_SCORE = 7.5;

        // Strict Enforcement
        if (validationReport.overall_score < MIN_ACCEPTABLE_SCORE) {
            const criticalIssues = validationReport.issues_found.filter(i => i.severity === 'CRITICAL');
            logger.error({
                score: validationReport.overall_score,
                issues: criticalIssues
            }, "❌ Quality check failed");

            // Throw to stop delivery of bad scripts
            throw new Error(
                `Quality check failed: Score ${validationReport.overall_score}/10 is below minimum (${MIN_ACCEPTABLE_SCORE}). ` +
                `Critical issues: ${criticalIssues.map(i => i.issue).join('; ')}`
            );
        }

        if (validationReport.overall_score < MIN_PRODUCTION_SCORE) {
            logger.warn({ score: validationReport.overall_score, target: MIN_PRODUCTION_SCORE }, "⚠️ Quality score below production standard but acceptable.");
        }

        // 5. Merge / Revision Logic (Improved merging)
        let finalScenes = scenesData.scenes;
        if (validationReport.revision_needed && validationReport.revised_scenes && validationReport.revised_scenes.length > 0) {
            logger.warn({
                original_count: finalScenes.length,
                revised_count: validationReport.revised_scenes.length,
                issues: validationReport.issues_found
            }, "⚠️ Applying validation corrections");

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

export const generateHeroImage = async (actionDescription) => {
    try {
        const openai = getOpenAI();
        let prompt = `Professional character portrait for: ${actionDescription}. Photorealistic, cinematic lighting, 8k quality.`;

        logger.info({ prompt }, 'Generating hero image with DALL-E');

        try {
            const response = await openai.images.generate({
                model: "dall-e-3",
                prompt: prompt,
                n: 1,
                size: "1024x1024",
                quality: "standard"
            });
            return response.data[0].url;
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
                return retryResponse.data[0].url;
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
    const rawModelId = process.env.VEO_MODEL_ID || process.env.VEO_MODEL;
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
            sampleCount: 1,
            // durationSeconds is not directly supported - Veo generates fixed 8s clips
            storageUri: bucketName ? `gs://${bucketName}/generated/${crypto.randomUUID()}` : undefined
        }
    };

    if (bucketName) {
        logger.info({ storageUri: veoRequest.parameters.storageUri }, "Configured GCS output destination for Veo");
    } else {
        logger.info("No GCS bucket configured. Veo will return Base64 or default storage URI.");
    }

    // If a hero image is provided, add it to the request
    if (heroImageUrl) {
        try {
            logger.info({ imageUrl: heroImageUrl }, "Fetching character reference image for Veo prompt.");
            const imageResponse = await fetch(heroImageUrl);
            if (imageResponse.ok) {
                const imageBuffer = await imageResponse.arrayBuffer();
                const base64Image = Buffer.from(imageBuffer).toString('base64');
                veoRequest.instances[0].image = {
                    bytesBase64Encoded: base64Image
                };
            }
        } catch (error) {
            logger.error({ err: error }, "Failed to process character reference image; proceeding with text-only.");
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
        // Auto-Retry logic for Guardrails
        if (error.message.includes("GUARDRAIL_ERROR") && !options.isRetry) {
            logger.warn({ originalPrompt: prompt }, "Guardrail triggered. Retrying with sanitized prompt...");

            // Fallback strategy: Strip brand names, keep style. 
            // Since we can't easily NLP detect brands here without valid regex or libraries, 
            // we will reduce the prompt to its core style directives + generic subject.
            const sanitizedPrompt = `Cinematic product shot, high quality, 4k. A generic unbranded bottle in a clean environment. ${options.visualMood || ''}`;

            return generateVideo(sanitizedPrompt, heroImageUrl, { ...options, isRetry: true });
        }

        logger.error({ err: error }, "Veo video generation failed");
        throw new Error(`Veo Generation Failed: ${error.message}`);
    }
    // End of generateVideo (logic dispatched to extractVideoFromResponse)
};


// Helper to extracting video URL or Base64 from the Veo response
const extractVideoFromResponse = async (responseOrResult, project, location, modelId, accessToken, bucketName) => {
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

    // 1. Explicit Check for Veo 3.1 GCS URI (Highest Priority)
    // Structure typically: [ { video: { uri: "gs://..." } } ] or just { video: { uri: "..." } }
    // Note: responseOrResult might be the whole pollData or just the 'response' part.
    const container = Array.isArray(responseOrResult) ? responseOrResult[0] : responseOrResult;

    // Inspect known keys for Veo 3.1
    let videoUrl = container?.video?.uri || container?.video?.videoUri || container?.uri || container?.video_uri || container?.gcsUri;

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
