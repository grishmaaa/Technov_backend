/**
 * promptCompiler.js
 * 
 * Implements the "Master Prompt" strategy to enforce consistency,
 * visual style, and control across Veo video generations.
 */

export const compileVeoPrompt = ({ narrativeBeat, project = {}, options = {} }) => {
    // 1. DETERMINE SETTINGS

    // Fallbacks if not present in project/options
    const style = project.qualityTier || 'cinematic'; // Default style

    // Infer MODE based on project settings or options
    // Currently defaulting to MIX if not explicitly set, or could be inferred from script content
    // For now, let's look for explicit overrides or default to MIX for maximum capability
    let mode = 'MIX';
    if (options.audioMode) mode = options.audioMode;

    // Infer TEXT settings
    let textMode = 'TEXT_ONLY';
    if (options.textMode) textMode = options.textMode;

    // 2. CONSTRUCT MASTER PROMPT

    const masterPrompt = `
You are generating an **8-second video clip** that is part of a **multi-cut sequence** (sequential prompts). The priority is **consistency, clarity, and controllability** across cuts.

### 1) Continuity & Identity Lock (always)

* Treat each clip as a continuation of the same short film.
* Keep **the same character identities** (faces), **wardrobes**, **hair**, **props**, **locations**, and **time-of-day/lighting** unless the cut prompt explicitly changes them.
* Keep objects stable between frames: no flicker, no random changes.
* Prioritize: **stable faces**, **normal hands**, **no extra fingers**, **no warped bodies**, **no sudden age changes**.

### 2) Visual Style Control

* **STYLE = ${style}**
* Follow STYLE strictly.
* Use simple, readable compositions.
* Avoid chaotic camera moves unless explicitly requested.

### 3) Product / Brand Integration

If the cut prompt includes a product/brand, follow these rules:
* Show the product **naturally** and keep it **legible**.
* Never distort the brand name or label.
* No exaggerated or unsafe claims.
* Keep it tasteful: avoid forced “salesy” behavior unless requested.

### 4) Dialogue / Voice / Subtitles Control

* **MODE = ${mode}**

**If MODE = NO_DIALOGUE:**
* No spoken dialogue, no narrator voiceover.
* No subtitles.
* Use ambient audio + foley only.

**If MODE = DIALOGUE_ONLY:**
* Only character dialogue; **no narrator VO**.
* Dialogue must be **short**: max **1 line per speaking character**, max **10 words per line**.
* Must have **clear lip-sync** and clean audio.
* No subtitles unless explicitly requested.

**If MODE = MIX:**
* Use dialogue only if it improves clarity; otherwise keep silent.
* Max **one short dialogue moment per cut**.
* Narrator VO is allowed **only if the cut prompt explicitly requests it** (1 short line).
* No subtitles unless explicitly requested.

### 5) On-Screen Text Control

* **TEXT = ${textMode}**

* **NO_TEXT:** no on-screen text and no subtitles.
* **TEXT_ONLY:** allow on-screen text only when the cut prompt requests it.
* **TEXT_PLUS_VO:** allow on-screen text when requested plus optional VO when requested.

### 6) Timing & Pacing (always)

* The clip must feel complete within **8 seconds** with a clear beginning-middle-end beat.
* Keep action simple and visually readable.
* If the cut prompt requires a “hero shot,” hold it steady for at least **1–2 seconds**.

### 7) Hard Avoids (always)

* No glitchy/garbled text. No warped labels/logos.
* No sudden character morphing, random props, or unrequested scene changes.
* No explicit content, no violence/gore, no unsafe behavior.
* Do not add new characters, brands, or plot elements unless explicitly requested.

### 8) Instruction Hierarchy

1. Safety/Hard Avoids
2. MODE/TEXT settings
3. Continuity Lock
4. Cut prompt story requirements
5. Style preferences

Now generate the clip using the cut-specific prompt below.
`;

    // 3. COMBINE WITH SPECIFIC BEAT
    const finalPrompt = `
${masterPrompt}

---

**CUT PROMPT:**
${narrativeBeat}
`.trim();

    return finalPrompt;
};
