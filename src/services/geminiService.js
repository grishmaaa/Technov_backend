import OpenAI from 'openai';
import { VertexAI } from '@google-cloud/vertexai';
import dotenv from 'dotenv';
import { logger } from '../logger.js';
import { uploadBufferToStorage, buildObjectKey } from './storageService.js';

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
    // Try to extract project_id from GCP_SA_KEY as fallback
    let projectFromSA = null;
    if (process.env.GCP_SA_KEY) {
        try {
            const saKey = JSON.parse(process.env.GCP_SA_KEY);
            projectFromSA = saKey.project_id;
        } catch (e) {
            logger.warn('Could not parse GCP_SA_KEY for project_id, using env vars');
        }
    }

    // Rely on Application Default Credentials set by start.sh (GOOGLE_APPLICATION_CREDENTIALS)
    const project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || projectFromSA;
    const location = process.env.GCP_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    // Trim the model ID to remove any leading/trailing whitespace
    const rawModelId = process.env.VEO_MODEL_ID || process.env.VEO_MODEL;
    const modelId = rawModelId ? rawModelId.trim() : null;

    if (!project) {
        throw new Error("Missing GCP_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or project_id in GCP_SA_KEY.");
    }
    if (!modelId) {
        throw new Error("VEO_MODEL_ID (or VEO_MODEL) is not configured in environment variables.");
    }

    logger.info({ project, location, modelId }, 'Initializing Vertex AI for Veo');

    // --- VEO VIDEO GENERATION VIA REST API (predictLongRunning) ---
    // The Google SDK automatically uses the GOOGLE_APPLICATION_CREDENTIALS env var set by start.sh
    const { GoogleAuth } = await import('google-auth-library');

    const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const authClient = await auth.getClient();
    const accessTokenResponse = await authClient.getAccessToken();
    const accessToken = accessTokenResponse.token;

    if (!accessToken) {
        throw new Error("Failed to get Google Cloud access token. Check service account credentials (GOOGLE_APPLICATION_CREDENTIALS).");
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

    logger.info({ promptSnippet: prompt.substring(0, 100), model: modelId }, "Submitting video generation request to Veo");

    try {
        // Step 1: Start the long-running operation
        // Use v1beta1 for Veo models as they are in preview
        const endpoint = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:predictLongRunning`;

        logger.info({ endpoint }, 'Calling Veo predictLongRunning endpoint');

        const startResponse = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(veoRequest)
        });

        if (!startResponse.ok) {
            const errorBody = await startResponse.text();
            logger.error({ status: startResponse.status, body: errorBody }, "Veo API start request failed");
            throw new Error(`Veo API request failed: ${startResponse.status} - ${errorBody}`);
        }

        const operationData = await startResponse.json();

        // Helper to safely log objects without massive base64 strings
        const safeStringify = (obj) => {
            return JSON.stringify(obj, (key, value) => {
                if (typeof value === 'string' && value.length > 500) {
                    return value.substring(0, 100) + '...[TRUNCATED]';
                }
                return value;
            });
        };

        // Log response (truncated)
        logger.info({ operationData: safeStringify(operationData) }, 'Veo API response');

        const operationName = operationData.name;

        if (!operationName) {
            throw new Error("Veo API did not return an operation name");
        }

        logger.info({ operationName }, "Veo video generation started, polling for completion...");

        // Step 2: Poll for completion
        // Try multiple endpoint formats for Veo operations
        const operationUrlV1 = `https://${location}-aiplatform.googleapis.com/v1/${operationName}`;
        const operationUrlV1Beta1 = `https://${location}-aiplatform.googleapis.com/v1beta1/${operationName}`;
        // Also try fetchPredictOperation for media models
        const fetchOpUrl = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:fetchPredictOperation`;

        const maxPollingAttempts = 120; // 10 minutes max (5s intervals)
        const pollingIntervalMs = 5000;

        logger.info({ operationUrlV1, operationUrlV1Beta1, fetchOpUrl }, 'Will poll these URLs for completion');

        for (let attempt = 0; attempt < maxPollingAttempts; attempt++) {
            await sleep(pollingIntervalMs);

            // Try standard operations endpoints first
            let pollResponse = await fetch(operationUrlV1, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            // If v1 gives 404, try v1beta1
            if (pollResponse.status === 404) {
                pollResponse = await fetch(operationUrlV1Beta1, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
            }

            // If still 404, try fetchPredictOperation with operationName in body
            if (pollResponse.status === 404) {
                pollResponse = await fetch(fetchOpUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ operationName: operationName })
                });
            }

            if (!pollResponse.ok) {
                logger.warn({ status: pollResponse.status, attempt }, "Polling request failed, retrying...");
                continue;
            }

            const pollData = await pollResponse.json();

            if (pollData.done) {
                logger.info({ attempt, pollData: JSON.stringify(pollData) }, "Veo video generation completed");

                // Check for errors
                if (pollData.error) {
                    throw new Error(`Veo generation failed: ${pollData.error.message}`);
                }

                // Try to extract video URL from various possible response formats
                // Veo response structure varies by model version
                const response = pollData.response || pollData.result || pollData;

                // Log the response structure for debugging
                logger.info({ responseKeys: Object.keys(response || {}) }, 'Veo response structure');

                // Try multiple possible paths for video URL
                let videoUrl = null;

                // Format 1: response.predictions[0].videoUri
                const predictions = response?.predictions;
                if (predictions && predictions.length > 0) {
                    videoUrl = predictions[0]?.videoUri ||
                        predictions[0]?.video?.uri ||
                        predictions[0]?.gcsUri ||
                        predictions[0]?.uri;
                }

                // Format 2: response.generatedSamples[0].video.uri
                const samples = response?.generatedSamples;
                if (!videoUrl && samples && samples.length > 0) {
                    videoUrl = samples[0]?.video?.uri ||
                        samples[0]?.uri ||
                        samples[0]?.gcsUri;
                }

                // Format 3: response.videos[0].uri
                const videos = response?.videos;
                if (!videoUrl && videos && videos.length > 0) {
                    videoUrl = videos[0]?.uri || videos[0]?.gcsUri;
                }

                // Format 4: Direct in response
                if (!videoUrl) {
                    videoUrl = response?.videoUri || response?.uri || response?.gcsUri;
                }

                // Format 5: Base64 bytes in videos array (Veo 3.1 default)
                if (!videoUrl && response?.videos && response.videos[0]?.bytesBase64Encoded) {
                    logger.info("Found Base64 video data, uploading to storage...");
                    const base64Data = response.videos[0].bytesBase64Encoded;
                    const buffer = Buffer.from(base64Data, 'base64');

                    // Generate a key for the video
                    const key = buildObjectKey({
                        userId: 'veo-generated',
                        prefix: 'generated-videos',
                        extension: 'mp4'
                    });

                    try {
                        const uploadedUrl = await uploadBufferToStorage({
                            buffer,
                            key,
                            contentType: 'video/mp4'
                        });
                        videoUrl = uploadedUrl;
                        logger.info({ videoUrl }, "Successfully uploaded base64 video to storage");
                    } catch (uploadError) {
                        logger.error({ err: uploadError }, "Failed to upload generated video");
                        throw new Error(`Failed to upload generated video: ${uploadError.message}`);
                    }
                }

                // Last resort: search for gs:// pattern anywhere in response
                if (!videoUrl) {
                    const fullResponseStr = JSON.stringify(pollData);
                    logger.info({ pollDataStr: fullResponseStr.substring(0, 500) }, "Searching for video URL in full response");

                    const gcsMatch = fullResponseStr.match(/gs:\/\/[^"\\]+/);
                    if (gcsMatch) {
                        videoUrl = gcsMatch[0];
                    }

                    // Also try https storage URLs
                    const httpsMatch = fullResponseStr.match(/https:\/\/storage\.googleapis\.com\/[^"\\]+/);
                    if (!videoUrl && httpsMatch) {
                        videoUrl = httpsMatch[0];
                    }
                }

                if (!videoUrl) {
                    logger.error({ pollData: JSON.stringify(pollData) }, "No video URL found in Veo response");
                    throw new Error("Veo response missing video URL - check logs for response structure");
                }

                // Convert gs:// URI to public HTTPS URL if needed
                let publicUrl = videoUrl;
                if (videoUrl.startsWith('gs://')) {
                    const bucketName = videoUrl.split('/')[2];
                    const objectName = videoUrl.split('/').slice(3).join('/');
                    publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;
                }

                logger.info({ videoUrl, publicUrl }, "Veo video generation complete");
                return { video_url: publicUrl, status: 'completed' };
            }

            // Log progress periodically
            if (attempt % 6 === 0) {
                logger.info({ attempt, maxAttempts: maxPollingAttempts }, "Still waiting for Veo video generation...");
            }
        }

        throw new Error("Veo video generation timed out after 10 minutes");

    } catch (error) {
        logger.error({ err: error }, "Veo video generation failed");
        throw new Error(`Veo Generation Failed: ${error.message}`);
    }
};
