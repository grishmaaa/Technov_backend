
import fs from 'fs';

const filePath = '/home/navin/Desktop/grishma/Technov_AI/Technov_backend/src/services/geminiService.js';
let content = fs.readFileSync(filePath, 'utf8');

const targetContent = `Create a "scene_progression_blueprint" that maps out what happens in each scene:

EXAMPLE for 4 scenes (30 seconds):
{
  "scene_1": "Establishing shot - introduce character and setting",
  "scene_2": "Inciting incident - character discovers/encounters something",
  "scene_3": "Rising action - character responds/investigates",
  "scene_4": "Climax/resolution - dramatic conclusion or revelation"
}

EXAMPLE for 8 scenes (60 seconds):
{
  "scene_1": "Wide establishing - show world/environment",
  "scene_2": "Introduce protagonist - show their current state",
  "scene_3": "Inciting incident - problem/discovery appears",
  "scene_4": "First reaction - character begins to respond",
  "scene_5": "Complication - situation escalates or changes",
  "scene_6": "Turning point - crucial decision made",
  "scene_7": "Climax - peak of action/emotion",
  "scene_8": "Resolution - show aftermath/new status quo"
}`;

const replacementContent = `Create a "scene_progression_blueprint" list of objects:

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

if (content.includes(targetContent)) {
    const newContent = content.replace(targetContent, replacementContent);
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log("Successfully updated _stage1_planning prompt!");
} else {
    // Normalization attempt: remove indentation
    const normalize = (s) => s.replace(/\s+/g, ' ').trim();
    if (normalize(content).includes(normalize(targetContent))) {
        console.log("Found match with normalization, but safer to do manual replacement via script logic that handles indentation.");
        // Using a more flexible replacement
        // We know the structure: "Create a ... " followed by examples.
        const startMarker = `Create a "scene_progression_blueprint" that maps out what happens in each scene:`;
        const endMarker = `ANTI-REPETITION RULES:`;

        const startIndex = content.indexOf(startMarker);
        const endIndex = content.indexOf(endMarker);

        if (startIndex !== -1 && endIndex !== -1) {
            const before = content.substring(0, startIndex);
            const after = content.substring(endIndex);
            const newContent = before + replacementContent + "\n\n" + after;
            fs.writeFileSync(filePath, newContent, 'utf8');
            console.log("Successfully updated _stage1_planning prompt (flexible match)!");
        } else {
            console.error("Could not find prompt block.");
            process.exit(1);
        }
    } else {
        console.error("Content not found even with normalization.");
        process.exit(1);
    }
}
