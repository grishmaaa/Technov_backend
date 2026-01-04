import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
dotenv.config();

async function testKey() {
    console.log("Checking API Key setup...");
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.error("❌ GEMINI_API_KEY is missing from .env");
        return;
    }
    console.log("Key found (length: " + key.length + ")");

    try {
        console.log("Attempting to call Gemini API...");
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        const result = await model.generateContent("Hello! Are you working?");
        const response = await result.response;
        console.log("✅ Success! Response:", response.text());
    } catch (error) {
        console.error("❌ API Call Failed:", error.message);
    }
}

testKey();
