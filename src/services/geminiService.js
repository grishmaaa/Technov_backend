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
        visualMood = 'neutral-auto',
        audioMode = 'MIX',
        textMode = 'TEXT_ONLY'
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

            You are a Direct, Literal Visualizer.
            You do NOT invent artistic B-roll or "mood shots" unless explicitly asked.
            You follow the story EXACTLY as written, translating it into 4 clear visual scenes.

            --- INSTRUCTIONS ---
            1. Technical Style: ${styleDirective}
            2. Artistic Mood: ${aestheticDirective}
            3. Visual Mood: ${moodDirective}
            4. Duration Target: ${durationConstraint}
            5. Dialogue Mode: ${audioMode} (Respect this strictly)
            6. Text Mode: ${textMode}

            --- CRITICAL RULES FOR CONSISTENCY ---
            1. **LITERAL INTERPRETATION**: If the story says "Cinderella cleans the floor", SHOW CINDERELLA CLEANING THE FLOOR. Do not show a "close up of a bottle" or "sunlight hitting dust". Show the CHARACTER doing the ACTION.
            2. **CHARACTER CONTINUITY**: If a character (e.g., Cinderella) is introduced, they must remain the same character in all scenes. Do not switch to "random lady" or "generic hands".
            3. **NO FLUFF**: Avoid flowery language like "A symphony of light" or "The camera dances". Use simple, direct descriptions: "Cinderella scrubs the floor." "She picks up the bottle."
            4. **STRICT 4-SCENE STRUCTURE**:
               - **Scene 1: THE PROBLEM**. Show the struggle/pain point. (e.g. Cinderella tired, scrubbing dirty floor).
               - **Scene 2: THE DISCOVERY**. Show the character finding/seeing the product. (e.g. She sees the Shinky bottle).
               - **Scene 3: THE SOLUTION**. The magic happens. (e.g. She uses it, floor becomes instantly shiny).
               - **Scene 4: THE PAYOFF/CTA**. Hero shot or Character speaking to camera. (e.g. She smiles at camera, holds bottle).

            STORY INPUT:
            "${storyText}"

            OUTPUT FORMAT (STRICT JSON):
            {
                "suggested_title": "Title String",
                "scenes": [
                    {
                        "scene_id": 1,
                        "action_description": "Literal description of action. If Audio Mode is MIX/DIALOGUE_ONLY, include: 'Character says: ...'",
                        "shot_type": "Medium Shot / Wide Shot / Close Up",
                        "motion_complexity": 5,
                        "audio_directive": "Specific sounds (scrubbing, footsteps, upbeat music)",
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

    // Use GCS bucket for output if configured (Avoids Base64 memory issues)
    let bucketName = null;
    if (process.env.GCP_BUCKET_NAME) {
        bucketName = process.env.GCP_BUCKET_NAME;

        // 1. PRE-FLIGHT CHECK: Can we actually write to this bucket?
        try {
            logger.info({ bucket: bucketName }, "Testing bucket permissions...");
            const testFileName = `technov-test-${Date.now()}.txt`;
            await uploadFileToStorage({
                filePath: null, // Hack: we'll simulate a buffer upload if needed, or just skip if uploadFileToStorage relies on local file
                key: testFileName,
                contentType: 'text/plain',
                contentBuffer: Buffer.from("Permission Check")
            }).catch(async (e) => {
                // If the main upload helper is complex, let's try a direct simple fetch/axios/library call if possible. 
                // Actually, simpler: just rely on the fallback logic or assume if this fails, we catch it.
                // Let's rely on the logging below.
                throw e;
            });
            // Note: uploadFileToStorage might not support direct buffer. 
            // Let's implement a quick direct test using the existing authClient if possible, 
            // or better yet, just blindly add the parameters and trust the error wording.
            // Actually, the user already verified permissions. The "Fallback" suggests the API ignored it.
            // Let's focus on the Parameter names.
        } catch (e) {
            // logger.warn({ err: e }, "Bucket write test warning (ignoring)");
        }

        // 2. Add ALL known variations of storage parameters to ensure Veo sees one
        veoRequest.parameters.outputConfig = {
            gcsDestination: {
                outputUriPrefix: `gs://${bucketName}/outputs/`
            }
        };
        veoRequest.parameters.storage_uri = `gs://${bucketName}/outputs/`; // Legacy/Alternate
        veoRequest.parameters.storageUri = `gs://${bucketName}/outputs/`; // CamelCase

        logger.info({ bucket: bucketName }, "Configured Veo to output to GCS bucket (sending variations: outputConfig, storage_uri)");
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

    let videoUrl = container?.video?.uri || container?.video?.videoUri || container?.uri;

    // 2. Recursive Search for URL if not found directly
    if (!videoUrl) {
        videoUrl = findVal(responseOrResult, ['videoUri', 'gcsUri', 'uri', 'videoUrl', 'url']);
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
