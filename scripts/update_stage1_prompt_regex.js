
import fs from 'fs';

const filePath = '/home/navin/Desktop/grishma/Technov_AI/Technov_backend/src/services/geminiService.js';
let content = fs.readFileSync(filePath, 'utf8');

// Regex to match from "Create a \"scene_progression_blueprint\"" down to the end of the 60s example
// Using [\s\S]*? for multiline matching
const regex = /Create a "scene_progression_blueprint" that maps out what happens in each scene:[\s\S]*?Resolution - show aftermath\/new status quo"\s*\}/;

const replacement = `Create a "scene_progression_blueprint" list of objects:

EXAMPLE for 4 scenes (30 seconds):
[
  { "scene_id": 1, "narrative_beat": "Establishing shot - introduce character and setting" },
  { "scene_id": 2, "narrative_beat": "Inciting incident - character discovers/encounters something" },
  { "scene_id": 3, "narrative_beat": "Rising action - character responds/investigates" },
  { "scene_id": 4, "narrative_beat": "Climax/resolution - dramatic conclusion or revelation" }
]

EXAMPLE for 8 scenes (60 seconds):
[
  { "scene_id": 1, "narrative_beat": "Wide establishing - show world/environment" },
  { "scene_id": 2, "narrative_beat": "Introduce protagonist - show their current state" },
  { "scene_id": 3, "narrative_beat": "Inciting incident - problem/discovery appears" },
  { "scene_id": 4, "narrative_beat": "First reaction - character begins to respond" },
  { "scene_id": 5, "narrative_beat": "Complication - situation escalates or changes" },
  { "scene_id": 6, "narrative_beat": "Turning point - crucial decision made" },
  { "scene_id": 7, "narrative_beat": "Climax - peak of action/emotion" },
  { "scene_id": 8, "narrative_beat": "Resolution - show aftermath/new status quo" }
]`;

if (content.match(regex)) {
    const newContent = content.replace(regex, replacement);
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log("Successfully updated _stage1_planning prompt via regex!");
} else {
    console.error("Regex failed to match content.");
    // Debug output to see what text looks like around the expected area
    const startIdx = content.indexOf('Create a "scene_progression_blueprint"');
    if (startIdx !== -1) {
        console.log("Found start at index:", startIdx);
        console.log("Next 500 chars:", content.substring(startIdx, startIdx + 500));
    } else {
        console.log("Could not find start string.");
    }
    process.exit(1);
}
