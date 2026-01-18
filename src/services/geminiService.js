import OpenAI from 'openai';
import dotenv from 'dotenv';
import { logger } from '../logger.js';

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

/**
 * Generate a cinematic script from story text
 * @param {string} storyText - The story to transform
 * @param {object} options - Optional tier parameters (backward compatible)
 * @param {string} options.plan - 'basic' | 'elite' | 'pro'
 * @param {string} options.productionStyle - 'vlog' | 'standard' | 'cinematic' | 'performance'
 * @param {string} options.artisticAtmosphere - 'photorealistic' | 'cyberpunk' | 'noir' | etc.
 * @param {string} options.length - 'standard' | 'extended'
 */
export const generateScript = async (storyText, options = {}) => {
    // Backward compatibility: if options is a string (old API), treat as plan
    const tierOptions = typeof options === 'string'
        ? { plan: options }
        : options;

    const {
        plan = 'basic',
        productionStyle = 'standard',
        artisticAtmosphere = 'photorealistic',
        length = 'standard'
    } = tierOptions;

    const directorPersona = getDirectorPersona(plan);
    const styleDirective = PRODUCTION_STYLES[productionStyle] || PRODUCTION_STYLES.standard;
    const aestheticDirective = ARTISTIC_ATMOSPHERES[artisticAtmosphere] || ARTISTIC_ATMOSPHERES.photorealistic;
    const durationConstraint = length === 'extended'
        ? "Total duration must be between 60-65 seconds across all scenes."
        : "Total duration must be between 10-12 seconds across all scenes.";

    // Wrap the core logic to allow for retries of the *Generation* step
    return await callWithRetry(async () => {
        const prompt = `
            ${directorPersona}

            You think visually, not textually.
            You design scenes as if they will be shot by a real camera, edited into a real film, and rendered by a high-end AI video engine (Kling 2.6 / Sora-class).

            --- DIRECTOR'S BRIEF ---
            1. Technical Style: ${styleDirective}
            2. Artistic Mood: ${aestheticDirective}
            3. Duration Target: ${durationConstraint}

            Your task is to transform the provided story into a cinematic Scene Breakdown suitable for professional video generation.

            STORY INPUT:
            "${storyText}"

            GLOBAL DIRECTIVES (STRICT):
            - Output MUST be valid JSON only (no markdown, no comments, no explanations)
            - Each scene must be visually distinct and progress the narrative
            - Avoid vague language; describe concrete, observable actions
            - Use professional cinematic camera language
            - Do NOT repeat phrasing across scenes
            - Do NOT break JSON formatting
            - Do NOT include anything outside the JSON array

            SCENE DESIGN RULES:
            - Each scene represents a clear cinematic beat
            - Focus on what is physically visible on screen
            - Include environment, lighting, character movement, and atmosphere
            - Scene flow should feel continuous and film-like
            - Escalate or de-escalate intensity based on story beats

            SHOT & CAMERA GUIDELINES:
            - Vary shot types intentionally (Wide, Medium, Close-up, Tracking, Drone, Handheld, POV)
            - Camera choice must support emotion and storytelling
            - Avoid repetitive shot patterns

            MOTION COMPLEXITY SCALE (1-10):
            1-2: Static or near-static (stillness, tension, atmosphere)
            3-5: Controlled motion (walking, gestures, slow camera movement)
            6-8: Dynamic motion (running, fast tracking, multiple actors)
            9-10: High-intensity action (combat, chaos, rapid movement)

            AUDIO DESIGN REQUIREMENTS:
            - Describe specific sound elements (ambient, Foley, score)
            - Audio must reinforce mood, tension, or emotional shift
            - Avoid generic phrases like "background music"

            OUTPUT FORMAT (STRICT):
            Return ONLY a JSON array of objects.

            Each object MUST contain:
            - scene_id: integer starting from 1
            - action_description: highly detailed visual description of what is seen on screen
            - shot_type: cinematic camera angle or movement
            - motion_complexity: integer (1-10)
            - audio_directive: specific sound or music description
            - duration: integer (seconds, default 8 unless context demands otherwise)

            JSON EXAMPLE STRUCTURE:
            [
            {
                "scene_id": 1,
                "action_description": "A dimly lit alley glistens with rain as a lone figure steps into frame, steam rising from the ground under flickering neon lights.",
                "shot_type": "Wide Tracking Shot",
                "motion_complexity": 4,
                "audio_directive": "Distant traffic hum layered with low atmospheric synth pulses",
                "duration": 8
            }
            ]
        `;

        const openai = getOpenAI(); // Get OpenAI client
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", // or "gpt-4" or "gpt-3.5-turbo"
            messages: [
                {
                    role: "system",
                    content: "You are a professional film director and screenwriter. You respond ONLY with valid JSON."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
        });

        const text = completion.choices[0].message.content;

        // Log token usage (Observability)
        const usage = completion.usage;
        logger.info({
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            totalTokens: usage?.total_tokens
        }, 'Token usage');

        // Try Parsing
        let scenes;
        const cleanedText = cleanMarkdown(text);

        try {
            scenes = JSON.parse(cleanedText);
        } catch (parseError) {
            logger.error({ err: parseError, responseSnippet: text.substring(0, 500) }, 'JSON parsing failed');
            throw new Error(`Failed to parse scene JSON: ${parseError.message}`);
        }

        if (!Array.isArray(scenes) || scenes.length === 0) {
            throw new Error('Invalid scene data: Expected non-empty array');
        }

        return {
            scenes,
            usage: {
                promptTokenCount: usage?.prompt_tokens || 0,
                candidatesTokenCount: usage?.completion_tokens || 0,
                totalTokenCount: usage?.total_tokens || 0
            }
        };
    });
};

export const generateHeroImage = async (actionDescription) => {
    try {
        // Get OpenAI client instance
        const openai = getOpenAI();

        // Generate character/hero image using DALL-E
        const prompt = `Professional character portrait for: ${actionDescription}. Photorealistic, cinematic lighting, 8k quality, detailed facial features.`;

        logger.info({ prompt }, 'Generating hero image with DALL-E');

        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: "1024x1024",
            quality: "standard"
        });

        const imageUrl = response.data[0].url;

        if (!imageUrl) {
            throw new Error('No image URL returned from DALL-E');
        }

        logger.info({ imageUrl }, 'Hero image generated successfully');
        return imageUrl;

    } catch (error) {
        logger.error({ err: error }, 'Failed to generate hero image');
        throw new Error(`Hero image generation failed: ${error.message}`);
    }
};

/**
 * Generate Video for a Scene using Kling AI 2.6
 * @param {string} sceneContext - Text description of the scene
 * @param {string} heroImageUrl - Optional hero character image URL for consistency
 * @returns {Promise<{video_url: string, status: string}>}
 */
export const generateVideo = async (sceneContext, heroImageUrl, options = {}) => {
    const KLING_API_KEY = process.env.KLING_API_KEY;
    const normalizeDuration = (seconds) => {
        const value = Number(seconds);
        if (!Number.isFinite(value)) {
            return 5;
        }
        return value <= 5 ? 5 : 10;
    };
    const duration = String(normalizeDuration(options.durationSeconds));
    const aspectRatio = options.aspectRatio || '16:9';

    if (!KLING_API_KEY) {
        throw new Error('KLING_API_KEY not configured in environment variables');
    }

    logger.info({ promptSnippet: sceneContext.substring(0, 50), duration, aspectRatio }, 'Generating video with Kling AI');

    try {
        // 1. Submit video generation job to Kling AI (via fal.ai)
        logger.info('Submitting Kling AI job');
        const submitResponse = await fetch('https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video', {
            method: 'POST',
            headers: {
                'Authorization': `Key ${KLING_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: sceneContext,
                duration,
                aspect_ratio: aspectRatio
            })
        });

        if (!submitResponse.ok) {
            const errorText = await submitResponse.text();
            throw new Error(`Failed to submit Kling job: ${submitResponse.status} - ${errorText}`);
        }

        const submitData = await submitResponse.json();
        if (submitData?.video?.url) {
            logger.info('Instant result returned from Kling');
            return { video_url: submitData.video.url, status: 'completed' };
        }

        const requestId = submitData.request_id || submitData.requestId || submitData.id;
        if (!requestId) {
            throw new Error(`Kling submit response missing request id: ${JSON.stringify(submitData)}`);
        }

        logger.info({ requestId }, 'Kling job submitted');
        logger.info('Polling for completion');

        // 2. Poll for job completion
        const maxAttempts = 60; // 60 * 5s = 5 minutes
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s

            const statusResponse = await fetch(
                `https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video/requests/${requestId}/status`,
                {
                    headers: {
                        'Authorization': `Key ${KLING_API_KEY}`
                    }
                }
            );

            if (!statusResponse.ok) {
                logger.warn({ attempt, maxAttempts }, 'Kling status check failed');
                continue;
            }

            const statusData = await statusResponse.json();
            logger.info({ attempt, maxAttempts, status: statusData.status }, 'Kling status update');

            if (statusData.status === 'COMPLETED') {
                const videoUrl = statusData.video?.url;

                if (!videoUrl) {
                    throw new Error('Video completed but no URL returned');
                }

                logger.info({ videoUrl }, 'Kling generation complete');
                return {
                    video_url: videoUrl,
                    status: "completed"
                };
            }

            if (statusData.status === 'FAILED') {
                const errorMsg = statusData.error || 'Unknown error';
                throw new Error(`Kling video generation failed: ${errorMsg}`);
            }
        }

        throw new Error('Video generation timed out after 5 minutes');

    } catch (error) {
        logger.error({ err: error }, 'Kling video generation failed');
        throw error;
    }
};
