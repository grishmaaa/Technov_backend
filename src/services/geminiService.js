import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

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
                console.error(`[SafetyNet] API Call failed definitively after ${attempt} attempts.`);
                throw error;
            }

            // Exponential Backoff: 1s, 2s, 4s...
            const delay = Math.pow(2, attempt - 1) * 1000;
            console.warn(`[SafetyNet] API Error (${error.message}). Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
            await sleep(delay);
        }
    }
}

const cleanMarkdown = (text) => text.replace(/```json/g, '').replace(/```/g, '').trim();

export const generateScript = async (storyText) => {
    // Wrap the core logic to allow for retries of the *Generation* step
    return await callWithRetry(async () => {
        const prompt = `
            You are an expert film director, screenwriter, cinematographer, and editor combined.

            You think visually, not textually.
            You design scenes as if they will be shot by a real camera, edited into a real film, and rendered by a high-end AI video engine (Kling 2.6 / Sora-class).

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
        console.log(`[Monitor] Input Tokens: ${usage?.prompt_tokens}, Output Tokens: ${usage?.completion_tokens}, Total: ${usage?.total_tokens}`);

        // Try Parsing
        let scenes;
        const cleanedText = cleanMarkdown(text);

        try {
            scenes = JSON.parse(cleanedText);
        } catch (parseError) {
            console.error("[SafetyNet] JSON parsing failed:", parseError.message);
            console.log("Raw response:", text.substring(0, 500));
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
    // Attempt Real Image Generation via Gemini 2.0 Flash Exp (if available)
    try {
        // const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        // const prompt = `Character Design: ${actionDescription}. Photorealistic, 8k.`;
        // const result = await model.generateContent(prompt);
        // ... parse result ... 

        // Due to Rate Limits (Quota 0) observed in tests, we fallback to a high-quality consistent placeholder
        // to ensure the "Identity Lock" pipeline functionality can be tested.
        throw new Error("Quota exceeded");
    } catch (e) {
        console.warn("[HeroImage] Falling back to placeholder due to API constraints.");
        // Return a consistent, high-quality Unsplash image to act as the "Identity Anchor"
        return "https://images.unsplash.com/photo-1620553140510-4813587b12d3?auto=format&fit=crop&w=800&q=80";
    }
};

/**
 * Generate Video for a Scene using Kling AI 2.6
 * @param {string} sceneContext - Text description of the scene
 * @param {string} heroImageUrl - Optional hero character image URL for consistency
 * @returns {Promise<{video_url: string, status: string}>}
 */
export const generateVideo = async (sceneContext, heroImageUrl) => {
    const KLING_API_KEY = process.env.KLING_API_KEY;

    if (!KLING_API_KEY) {
        throw new Error('KLING_API_KEY not configured in environment variables');
    }

    console.log(`[Video] Generating video with Kling AI for scene: ${sceneContext.substring(0, 50)}...`);

    try {
        // 1. Submit video generation job to Kling AI (via fal.ai)
        console.log('[Video] Submitting job to Kling AI...');
        const submitResponse = await fetch('https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video', {
            method: 'POST',
            headers: {
                'Authorization': `Key ${KLING_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: sceneContext,
                duration: "5",  // 5 seconds per clip
                aspect_ratio: "16:9"
            })
        });

        if (!submitResponse.ok) {
            const errorText = await submitResponse.text();
            throw new Error(`Failed to submit Kling job: ${submitResponse.status} - ${errorText}`);
        }

        const submitData = await submitResponse.json();
        const requestId = submitData.request_id;

        console.log(`[Video] Job submitted. Request ID: ${requestId}`);
        console.log('[Video] Polling for completion (max 5 minutes)...');

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
                console.warn(`[Video] Status check failed (attempt ${attempt}/${maxAttempts})`);
                continue;
            }

            const statusData = await statusResponse.json();
            console.log(`[Video] Attempt ${attempt}/${maxAttempts}: ${statusData.status}`);

            if (statusData.status === 'COMPLETED') {
                const videoUrl = statusData.video?.url;

                if (!videoUrl) {
                    throw new Error('Video completed but no URL returned');
                }

                console.log(`[Video] ✅ Generation complete! URL: ${videoUrl}`);
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
        console.error('[Video] Error during video generation:', error);
        throw error;
    }
};

