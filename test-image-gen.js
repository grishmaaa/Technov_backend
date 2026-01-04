import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testImageGen() {
    console.log("🎨 Testing Image Generation...");
    // Using the model ID found in the earlier list
    const modelName = "gemini-2.0-flash-exp";
    // "gemini-2.0-flash-exp-image-generation" might be the one, but let's try the multimodal capability of flash-exp first
    // Or check if the SDK supports 'imagen' specifically.

    // Actually, let's try the specific model listed:
    const specificModel = "gemini-2.0-flash-exp"; // Often standard flash supports creating images if prompted? 
    // No, usually it's a separate model for pure image gen in the API, e.g. imagen-3. 
    // BUT the list showed "models/gemini-2.0-flash-exp-image-generation". Let's try THAT.

    const imageModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    // Wait, typically 'generateContent' just returns text. 
    // If it's a dedicated image model, we might need to look for 'images' in the response.

    const prompt = "A cinematic shot of a futuristic cyberpunk detective standing in neon rain. Photorealistic, 8k.";

    try {
        console.log(`Sending prompt to ${specificModel}...`);
        const result = await imageModel.generateContent(prompt);
        const response = await result.response;

        console.log("Response received.");

        // Inspect candidates for images
        // Usually images come as inline data if supported.
        console.log(JSON.stringify(response, null, 2));

        // Attempt to access text (might fail if it's only image)
        try {
            console.log("Text:", response.text());
        } catch (e) { console.log("No text returned."); }

    } catch (error) {
        console.error("❌ Generation Failed:", error.message);
    }
}

testImageGen();
