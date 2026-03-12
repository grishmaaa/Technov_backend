import 'dotenv/config';
import { generateCharacterPortrait } from './src/services/falService.js';

async function run() {
    try {
        const res = await generateCharacterPortrait("A cool hacker girl", "cyberpunk styling", { model: 'fal-ai/flux/schnell' });
        console.log("Success:", res);
    } catch(err) {
        console.error("Error:", err);
    }
}
run();
