import dotenv from 'dotenv';
dotenv.config();
import { submitVideoGeneration } from './src/services/evolinkService.js';

async function testKlingIntegration() {
    console.log("🎥 Testing Kling Integration via EvoLink...");
    console.log("API Key Check:", process.env.EVOLINK_API_KEY ? "Found" : "Missing");

    // Using Kling 2.6 to verify connectivity (cheaper than 3.0)
    const prompt = "A high-fidelity cinematic shot of a cyberpunk city in the rain, ultra-detailed, 8k.";

    try {
        const result = await submitVideoGeneration(prompt, {
            model: 'kling-v2.6',
            quality: 'standard',
            duration: 5
        });
        console.log("✅ Submission Success!");
        console.log("Task ID:", result.taskId);
        console.log("Status:", result.status);
    } catch (error) {
        console.error("❌ Submission Failed!");
        console.log("Error:", error.message);
    }
}

testKlingIntegration();
