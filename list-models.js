import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
dotenv.config();

async function listModels() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.error("❌ GEMINI_API_KEY is missing");
        return;
    }

    try {
        console.log("Fetching available models via REST...");

        // If we want to truly list, we'd need to fetch from the API endpoint directly
        // since the simplified SDK sometimes hides the list management.
        const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await listRes.json();

        if (data.models) {
            console.log("\n=== AVAILABLE MODELS ===");
            data.models.forEach(m => {
                if (m.supportedGenerationMethods?.includes("generateContent")) {
                    console.log(`- ${m.name}`);
                }
            });
            console.log("========================\n");
        } else {
            console.log("Could not list models via REST:", data);
        }

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

listModels();
