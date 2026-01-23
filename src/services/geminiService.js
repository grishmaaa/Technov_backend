import OpenAI from 'openai';
import { VertexAI } from '@google-cloud/vertexai';
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

// Visual Mood - lighting and color grading directives
const VISUAL_MOODS = {
    'neutral-auto': "Lighting: Natural, context-appropriate lighting.",
    'raw-gritty': "Lighting: Harsh, desaturated, raw reality look. Gritty urban aesthetic.",
    'golden-ethereal': "Lighting: Golden hour warmth, soft lens flares, ethereal glow.",
    'high-contrast-noir': "Lighting: High contrast, deep blacks, dramatic rim lighting.",
    'hyper-saturated': "Lighting: Punchy, vibrant colors, high saturation throughout."
};

/**
 * Generate a cinematic script from story text
 * @param {string} storyText - The story to transform
 * @param {object} options - Optional tier parameters (backward compatible)
 * @param {string} options.plan - 'basic' | 'elite' | 'pro'
 * @param {string} options.productionStyle - 'vlog' | 'standard' | 'cinematic' | 'performance'
 * @param {string} options.artisticAtmosphere - 'photorealistic' | 'cyberpunk' | 'noir' | etc.
 * @param {string} options.length - 'standard' | 'extended'
 * @param {string} options.visualMood - 'neutral-auto' | 'raw-gritty' | 'golden-ethereal' | etc.
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
        length = 'standard',
        visualMood = 'neutral-auto'
    } = tierOptions;

    const directorPersona = getDirectorPersona(plan);
    const styleDirective = PRODUCTION_STYLES[productionStyle] || PRODUCTION_STYLES.standard;
    const aestheticDirective = ARTISTIC_ATMOSPHERES[artisticAtmosphere] || ARTISTIC_ATMOSPHERES.photorealistic;
    const moodDirective = VISUAL_MOODS[visualMood] || VISUAL_MOODS['neutral-auto'];
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
            3. Visual Mood: ${moodDirective}
            4. Duration Target: ${durationConstraint}

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
            Return ONLY a single JSON object.

            The object MUST contain:
            - "suggested_title": A creative, cinematic title for the film based on the story (e.g., "The Last Sunrise", "Echoes in the Chrome", "Shadows on Cobblestone"). Make it evocative and memorable.
            - "scenes": An array of scene objects where each object contains:
                - scene_id: integer starting from 1
                - action_description: highly detailed visual description of what is seen on screen
                - shot_type: cinematic camera angle or movement
                - motion_complexity: integer (1-10)
                - audio_directive: specific sound or music description
                - duration: integer (seconds, default 8 unless context demands otherwise)

            JSON EXAMPLE STRUCTURE:
            {
                "suggested_title": "Shadows on Cobblestone",
                "scenes": [
                    {
                        "scene_id": 1,
                        "action_description": "A dimly lit alley glistens with rain as a lone figure steps into frame, steam rising from the ground under flickering neon lights.",
                        "shot_type": "Wide Tracking Shot",
                        "motion_complexity": 4,
                        "audio_directive": "Distant traffic hum layered with low atmospheric synth pulses",
                        "duration": 8
                    }
                ]
            }
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
        const cleanedText = cleanMarkdown(text);
        let parsedResponse;

        try {
            parsedResponse = JSON.parse(cleanedText);
        } catch (parseError) {
            logger.error({ err: parseError, responseSnippet: text.substring(0, 500) }, 'JSON parsing failed');
            throw new Error(`Failed to parse scene JSON: ${parseError.message}`);
        }

        // Handle both new format (object with suggested_title + scenes) and legacy format (array)
        const suggested_title = parsedResponse.suggested_title || null;
        const scenes = Array.isArray(parsedResponse) ? parsedResponse : parsedResponse.scenes;

        if (!Array.isArray(scenes) || scenes.length === 0) {
            throw new Error('Invalid scene data: Expected non-empty scenes array');
        }

        return {
            scenes,
            suggested_title, // AI-generated creative title
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
 * Generate Video for a Scene using Google Cloud's Veo model via Vertex AI.
 * This function is now the primary video generator.
 * @param {string} prompt - The detailed text prompt for the video.
 * @param {string} heroImageUrl - Optional URL to a character reference image for consistency.
 * @param {object} options - Contains duration, aspectRatio, etc.
 * @returns {Promise<{video_url: string, status: string}>}
 */
export const generateVideo = async (prompt, heroImageUrl, options = {}) => {
    // 1. Initialize Vertex AI Client
    const vertex_ai = new VertexAI({
        project: process.env.GCP_PROJECT_ID,
        location: process.env.GCP_LOCATION
    });

    const model = process.env.VEO_MODEL_ID;
    if (!model) {
        throw new Error("VEO_MODEL_ID is not configured in environment variables.");
    }

    const generativeModel = vertex_ai.getGenerativeModel({ model });

    // 2. Build the Multi-Modal Request Parts
    const requestParts = [{ text: prompt }];

    // If a character reference image is provided, fetch it and add it to the prompt.
    if (heroImageUrl) {
        try {
            logger.info({ imageUrl: heroImageUrl }, "Fetching character reference image for Veo prompt.");
            const imageResponse = await fetch(heroImageUrl);
            if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);

            const imageBuffer = await imageResponse.arrayBuffer();
            const base64Image = Buffer.from(imageBuffer).toString('base64');

            requestParts.unshift({ // Add the image BEFORE the text prompt
                inlineData: {
                    mimeType: imageResponse.headers.get('content-type') || 'image/jpeg',
                    data: base64Image,
                },
            });
        } catch (error) {
            logger.error({ err: error }, "Failed to process character reference image; proceeding with text-only.");
        }
    }

    const request = {
        contents: [{ role: 'user', parts: requestParts }],
        generationConfig: {
            // Add any Veo-specific parameters here if needed
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        ],
    };

    logger.info({ promptSnippet: prompt.substring(0, 100) }, "Submitting generation request to Vertex AI (Veo)");

    // 3. Make the API call
    const result = await generativeModel.generateContent(request);
    const response = result.response;

    // 4. Extract the Video URL
    // The response structure might vary slightly, inspect `response.candidates` if this fails.
    const videoPart = response.candidates[0].content.parts.find(part => part.fileData);
    const gcsUri = videoPart?.fileData?.fileUri;

    if (!gcsUri) {
        throw new Error("Vertex AI (Veo) did not return a video file URI.");
    }

    // Convert the private gs:// URI to a public HTTPS URL.
    const bucketName = gcsUri.split('/')[2];
    const objectName = gcsUri.split('/').slice(3).join('/');
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;

    logger.info({ gcsUri, publicUrl }, "Vertex AI (Veo) generation complete");
    return { video_url: publicUrl, status: 'completed' };
};
