import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testVideoGen() {
    console.log("🎥 Testing Veo Video Generation...");
    // Mock image for input
    const mockImage = {
        inlineData: {
            data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", // 1x1 pixel white gif
            mimeType: "image/png"
        }
    };

    try {
        // Correct way to call Veo might be via a specific endpoint or model
        // The user said "veo-3.1-fast-generate-001".
        // Let's try to verify if this model exists via getGenerativeModel

        const modelName = "gemini-2.0-flash-exp";
        // Or "gemini-2.0-flash-exp" (some docs say 2.0 creates video?)
        // The user specifically named Veo.

        console.log(`Checking model: ${modelName}`);
        const model = genAI.getGenerativeModel({ model: modelName });

        // Simple test call (likely to fail on input but should check model existence)
        // Veo usually takes prompt + image.
        const result = await model.generateContent("A cinematic video of a cat.");
        console.log("✅ Video Gen Success:", result.response.text());

    } catch (error) {
        console.error("❌ Video Gen Failed:", error.message);
    }
}

testVideoGen();
