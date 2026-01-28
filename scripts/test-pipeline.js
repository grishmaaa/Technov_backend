
import dotenv from 'dotenv';
import { generateScript } from '../src/services/geminiService.js';
import { logger } from '../src/logger.js';

dotenv.config();

// Mock console logging if logger is complex, but here we just use it
// Ensure OPENAI_API_KEY is in .env

const runTest = async () => {
    console.log("🚀 Starting 3-Stage Pipeline Test...");

    const story = "A young cybersecurity analyst discovers a hidden backdoor in her company's server room. She traces the cable to a dusty ventilation shaft.";

    try {
        const result = await generateScript(story, {
            plan: 'pro',
            length: 'standard', // 10-12s, so likely 2 scenes or so, but let's see.
            productionStyle: 'cinematic',
            visualMood: 'high-contrast-noir'
        });

        console.log("\n✅ Pipeline Complete!");
        console.log("------------------------------------------");
        console.log("📝 Title:", result.suggested_title);

        console.log("\n📚 Asset Sheet (Stage 1 Output):");
        console.log(JSON.stringify(result.assetSheet, null, 2).substring(0, 500) + "..."); // Truncate for readability

        console.log("\n🎬 Generated Scenes (Stage 2 Output):");
        result.scenes.forEach(scene => {
            console.log(`\n[Scene ${scene.scene_id}] (${scene.duration}s)`);
            console.log(`Action: ${scene.action_description}`);
            console.log(`Shot: ${scene.shot_type}`);
            console.log(`Audio: ${scene.audio_directive}`);
        });

        console.log("\n📊 Validation Report (Stage 3 Output):");
        if (result.validationReport) {
            console.log("Status:", result.validationReport.validation_status);
            console.log("Score:", result.validationReport.overall_score);
            console.log("Issues:", result.validationReport.issues_found.length);
        } else {
            console.log("No validation report returned (Logic error?)");
        }

        console.log("\n💰 Token Usage:");
        console.log(result.usage);

    } catch (error) {
        console.error("❌ Test Failed:", error);
    }
};

runTest();
