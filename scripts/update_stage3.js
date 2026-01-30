
import fs from 'fs';
import path from 'path';

const filePath = '/home/navin/Desktop/grishma/Technov_AI/Technov_backend/src/services/geminiService.js';
let content = fs.readFileSync(filePath, 'utf8');

// The new Stage 3 implementation
const newStage3 = `// ==========================================
// STAGE 3 UPDATE: Add repetition check to validation
// ==========================================

const _stage3_validation = async (assetSheet, scenesData) => {
    logger.info("✅ Stage 3: Validating Quality...");

    const prompt = \`
You are a quality assurance specialist for film production. Validate against repetition and consistency issues.

ASSET SHEET:
\${JSON.stringify(assetSheet, null, 2)}

GENERATED SCENES:
\${JSON.stringify(scenesData, null, 2)}

VALIDATION CHECKLIST:

1. ANTI-REPETITION CHECK (CRITICAL FOR MULTI-SCENE VIDEOS)
   - [ ] Each scene shows a DIFFERENT action/moment
   - [ ] No two consecutive scenes have the same camera angle
   - [ ] No phrases like "continues to" or "still doing"
   - [ ] Each scene advances the narrative forward
   - [ ] Character performs different actions in each scene

2. TIMESTAMP STRUCTURE
   - [ ] Each scene has 4 timestamps: [00:00-00:02], [00:02-00:04], [00:04-00:06], [00:06-00:08]
   - [ ] Total prompt length 240-360 words per scene

3. CHARACTER CONSISTENCY
   - [ ] Distinctive features in CAPS in EVERY timestamp in EVERY scene
   - [ ] Same character descriptions across all scenes
   - [ ] Clothing consistent throughout

4. NARRATIVE PROGRESSION
   - [ ] Scenes follow a logical story arc
   - [ ] Each scene has unique narrative purpose
   - [ ] No redundant or repetitive scenes

5. CINEMATOGRAPHY
   - [ ] Shot variety within each scene
   - [ ] Different camera angles between scenes
   - [ ] No static or repetitive compositions

CRITICAL ISSUE EXAMPLES:

REPETITION ISSUES (HIGHEST PRIORITY):
- Scene 1 and Scene 2 both show "character walking" → CRITICAL
- Two consecutive scenes with same camera angle → CRITICAL  
- Scene describes "continues from previous" → CRITICAL
- Identical actions across scenes → CRITICAL

CONSISTENCY ISSUES:
- Distinctive feature missing in a timestamp → MODERATE
- Character description changes between scenes → CRITICAL
- Wrong word count → MODERATE

OUTPUT FORMAT:
{
  "validation_status": "PASS|FAIL|NEEDS_REVISION",
  "overall_score": 8.5,
  "issues_found": [
    {
      "severity": "CRITICAL|MODERATE|MINOR",
      "category": "repetition|consistency|word_count|cinematography",
      "scene_number": number,
      "issue": "Description",
      "current_text": "text",
      "required_fix": "fix"
    }
  ],
  "strengths": ["array"],
  "revision_needed": boolean,
  "revised_scenes": []
}

If scenes are repetitive, YOU MUST revise them to be unique and include in revised_scenes array.
\`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: VALIDATION_SCHEMA,
        temperature: 0.3
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    
    // Log repetition issues specifically
    const repetitionIssues = parsed.issues_found.filter(i => i.category === 'repetition');
    if (repetitionIssues.length > 0) {
        logger.warn({
            count: repetitionIssues.length,
            issues: repetitionIssues.map(i => i.issue)
        }, "⚠️ Scene repetition detected!");
    }
    
    logger.info({ 
        score: parsed.overall_score, 
        status: parsed.validation_status,
        repetition_issues: repetitionIssues.length
    }, "✅ Stage 3 Complete");
    
    return { validationReport: parsed, usage: completion.usage };
};`;

// Use regex to replace the old function
// We look for "const _stage3_validation = async ... " and end before "const deriveMotionComplexity"
// This assumes the order in file.
const startMarker = "const _stage3_validation = async (assetSheet, scenesData) => {";
// The end marker is tricky because of nested braces. 
// But we know the next function starts with "const deriveMotionComplexity" or "// HELPER:"
const nextFunctionMarker = "// HELPER: Motion Complexity Derivation";

const startIndex = content.indexOf(startMarker);
if (startIndex === -1) {
    console.error("Could not find start of _stage3_validation");
    process.exit(1);
}

const endIndex = content.indexOf(nextFunctionMarker, startIndex);
if (endIndex === -1) {
    console.error("Could not find start of next function");
    process.exit(1);
}

// Find the last closing brace before the next function
const chunk = content.substring(startIndex, endIndex);
const lastBraceIndex = chunk.lastIndexOf('};');

if (lastBraceIndex === -1) {
    console.error("Could not find closing brace of _stage3_validation");
    process.exit(1);
}

// Perform replacement
const before = content.substring(0, startIndex);
// Note: we might have some newlines before the next function we want to preserve or just overwrite
const after = content.substring(endIndex); // Keep the helper comment and everything after

// We trim the newStage3 slightly to ensure clean spacing
const newContent = before + newStage3 + "\n\n" + after;

fs.writeFileSync(filePath, newContent, 'utf8');
console.log("Successfully replaced _stage3_validation!");
