
import dotenv from 'dotenv';
import { generateScript } from '../src/services/geminiService.js';
import { logger } from '../src/logger.js';

dotenv.config();

const runTest = async () => {
    console.log("🚀 Testing Tiered Script Generation Logic...");

    const story = "A futuristic race car speeds through a neon tunnel.";

    // Test Cases
    const cases = [
        { plan: 'basic', length: 'standard', expectedScenes: 1, name: "Base Plan (Standard)" },
        { plan: 'basic', length: 'extended', expectedScenes: 1, name: "Base Plan (Extended Request - Should Ignore)" },
        { plan: 'pro', length: 'standard', expectedScenes: 1, name: "Pro Plan (Standard)" },
        { plan: 'pro', length: 'extended', expectedScenes: 4, name: "Pro Plan (Extended)" },
        { plan: 'elite', length: 'extended', expectedScenes: 8, name: "Elite Plan (Extended)" },
    ];

    for (const testCase of cases) {
        console.log(`\n------------------------------------------`);
        console.log(`🧪 Testing: ${testCase.name}`);
        try {
            const result = await generateScript(story, {
                plan: testCase.plan,
                length: testCase.length,
                productionStyle: 'cinematic',
                visualMood: 'neutral-auto'
            });

            const assetSheet = result.assetSheet;
            const sceneCount = assetSheet.project_metadata.total_scenes;

            console.log(`Duration String Used: ${assetSheet.project_metadata.duration_seconds}s (approx)`);
            console.log(`Scenes Generated: ${sceneCount}`);

            if (sceneCount === testCase.expectedScenes) {
                console.log("✅ PASS");
            } else {
                console.log(`❌ FAIL: Expected ${testCase.expectedScenes}, got ${sceneCount}`);
            }

        } catch (error) {
            console.error("❌ ERROR:", error.message);
        }
    }
};

runTest();
