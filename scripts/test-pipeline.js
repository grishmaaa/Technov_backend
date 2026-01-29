
import dotenv from 'dotenv';
import { generateScript } from '../src/services/geminiService.js';
import { logger } from '../src/logger.js';

dotenv.config();

const runTest = async () => {
    console.log("🚀 Starting 3-Stage Pipeline Test (Veo 8s Timestamp Strategy)...");

    const story = "A noir detective with a distinct cybernetic gold arm is investigating a crime scene in a rainy, neon-lit alleyway. He finds a glowing blue data chip in a puddle. He picks it up and says, 'This shouldn't exist.' A holographic woman flickers into existence behind him.";

    try {
        // Standard length = 8 seconds now
        const result = await generateScript(story, {
            plan: 'pro',
            length: 'standard',
            productionStyle: 'cinematic',
            visualMood: 'high-contrast-noir'
        });

        console.log("\n✅ Pipeline Complete!");
        console.log("------------------------------------------");
        console.log("📝 Title:", result.suggested_title); // This might be undefined if not in top level return, checking schema...

        // Actually generateScript returns { scenesData, assetSheet, validationReport, usage }? 
        // Let's check the return of generateScript in geminiService.js closely.
        // It returns { assetSheet, scenesData, validationReport, usage } (merged or separate?)
        // Looking at code: 
        // return { assetSheet, scenesData, validationReport, usage: ... }

        // ADJUST LOGGING BASED ON EXPECTED RETURN:
        console.log("\n📚 Asset Sheet (Stage 1):");
        if (result.assetSheet) {
            console.log(JSON.stringify(result.assetSheet, null, 2).substring(0, 500) + "...");
        }

        console.log("\n🎬 Generated Scenes (Stage 2):");
        if (result.scenesData && result.scenesData.scenes) {
            result.scenesData.scenes.forEach(scene => {
                console.log(`\n[Scene ${scene.scene_number}] Time: ${scene.timestamp}`);
                console.log(`Title: ${scene.title}`);
                console.log(`Prompt (Partial): ${scene.prompt.substring(0, 100)}...`);
                console.log(`Tech: ${JSON.stringify(scene.technical_breakdown)}`);
                console.log(`Audio: ${JSON.stringify(scene.audio)}`);
            });
        } else {
            console.log("❌ No scenes found in result.scenesData");
            console.log(JSON.stringify(result, null, 2));
        }

        console.log("\n📊 Validation Report (Stage 3):");
        if (result.validationReport) {
            console.log("Status:", result.validationReport.validation_status);
            console.log("Score:", result.validationReport.overall_score);
            console.log("Issues Found:", result.validationReport.issues_found.length);
            if (result.validationReport.issues_found.length > 0) {
                console.log("First Issue:", JSON.stringify(result.validationReport.issues_found[0], null, 2));
            }
        } else {
            console.log("No validation report returned.");
        }

        console.log("\n💰 Token Usage:", result.usage);

    } catch (error) {
        console.error("❌ Test Failed:", error);
    }
};

runTest();
