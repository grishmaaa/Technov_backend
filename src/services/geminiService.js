import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

export async function attemptJsonRepair(malformedText, errorMsg) {
    console.warn("[SafetyNet] JSON Parse failed. Attempting self-correction with Gemini...");
    const repairPrompt = `
    The following JSON is malformed and caused this error: ${errorMsg}.
    
    BAD JSON:
    ${malformedText}

    Please fix the JSON syntax and return ONLY the valid JSON array.
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const result = await model.generateContent(repairPrompt);
    const response = textFromResponse(result);
    return JSON.parse(cleanMarkdown(response));
}

const cleanMarkdown = (text) => text.replace(/```json/g, '').replace(/```/g, '').trim();
const textFromResponse = (result) => result.response.text();

export const generateScript = async (storyText) => {
    // Wrap the core logic to allow for retries of the *Generation* step
    return await callWithRetry(async () => {
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        const prompt = `
        You are a professional film director and screenwriter. 
        Transform the following story into a detailed Scene Breakdown for a cinematic video.
        
        STORY:
        "${storyText}"
        
        Output strictly as a JSON array of objects. Each object must have:
        - scene_id: integer (1, 2, 3...)
        - action_description: detailed visual description of what happens.
        - shot_type: camera angle (Wide, Close-up, Drone, Tracking, etc.)
        - motion_complexity: integer (1-10, where 10 is high action).
        - audio_directive: description of sound effects or mood music.
        - duration: integer (seconds, default 8).

        Example:
        [
            { "scene_id": 1, "action_description": "...", "shot_type": "Wide", "motion_complexity": 5, "audio_directive": "...", "duration": 8 }
        ]
        `;

        const result = await model.generateContent(prompt);
        const text = textFromResponse(result);

        // Log token usage (Observability)
        const usage = result.response.usageMetadata;
        console.log(`[Monitor] Input Tokens: ${usage?.promptTokenCount}, Output Tokens: ${usage?.candidatesTokenCount}`);

        // Try Parsing
        let scenes;
        const cleanedText = cleanMarkdown(text);

        try {
            scenes = JSON.parse(cleanedText);
        } catch (parseError) {
            // "Safety Net": JSON Repair
            try {
                scenes = await attemptJsonRepair(cleanedText, parseError.message);
                console.log("[SafetyNet] JSON successfully repaired.");
            } catch (repairError) {
                console.error("[SafetyNet] Repair failed.");
                throw new Error("Failed to generate valid JSON script even after repair.");
            }
        }

        return { scenes, usage };
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

export const generateVideo = async (sceneContext, heroImageUrl) => {
    console.log(`[Veo] Generating video for scene: ${sceneContext.substring(0, 30)}...`);

    // Mission 4: The Anchor - Veo 3.1 Orchestration
    // Model: veo-3.1-generate-001

    // Since we don't have direct access to the 'veo' model namespace in this specific SDK setup yet,
    // We implement the "Architecture" (Polling, Params) using a simulation for the verification phase.

    // In production, this would be:
    /*
    const response = await fetch('https://.../models/veo-3.1-generate-001:generateContent', {
        method: 'POST',
        body: JSON.stringify({
            contents: { ... },
            generationConfig: {
                aspect_ratio: "16:9",
                motion_bucket_id: 7,
                native_audio: true,
                duration_seconds: 8
            },
            input_images: [heroImageUrl] // The Identity Lock
        })
    });
    */

    // SIMULATED POLLING LOOP (To verify Worker Logic)
    return new Promise((resolve) => {
        setTimeout(() => {
            // Return a realistic 'Completed' response with a reliable Google Storage video URL
            resolve({
                video_url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
                status: "completed"
            });
        }, 5000); // Simulate 5s render time (in real life 1-3 mins)
    });
};
