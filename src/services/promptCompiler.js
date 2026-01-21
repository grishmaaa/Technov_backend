// Technov_backend/src/services/promptCompiler.js

// --- Helper Functions ---
const normalizeWhitespace = (text) => text.replace(/\s+/g, ' ').trim();

// These maps are consistent with geminiService.js to ensure stylistic continuity
const PRODUCTION_STYLES = {
    'social-vlog': "handheld vlog style, natural lighting, first-person POV",
    'standard-clean': "stable tripod shot, professional lighting, clean corporate look",
    'cinematic-epic': "cinematic, sweeping gimbal movement, dramatic lighting, epic scale, shallow depth of field, anamorphic bokeh",
    'performance-pro': "macro lens on face, tight close-up, focus on lip-sync and micro-expressions, high frame rate"
};

const ARTISTIC_ATMOSPHERES = {
    photorealistic: "hyper-realistic 8K textures, shot on ARRI Alexa",
    'film-noir': "high-contrast black and white, deep shadows, Venetian blinds effect",
    'vintage-35mm': "35mm film grain, slightly faded colors, warm tones",
    cyberpunk: "neon-drenched, rainy, high-tech grit, anamorphic lens flares",
    'modern-anime': "modern Japanese animation style, vibrant cel-shading"
};

const VISUAL_MOODS = {
    'neutral-auto': "balanced color grading",
    'raw-gritty': "desaturated, gritty, crushed blacks",
    'golden-ethereal': "golden hour warmth, soft lens flares, ethereal glow",
    'high-contrast-noir': "deep blacks, dramatic rim lighting, chiaroscuro",
    'hyper-saturated': "punchy vibrant colors, high saturation"
};

// --- The New 20x Prompt Compiler ---

export const compileShotPrompt = ({ project, scene, shot }) => {

    // === BASE TIER PROMPT ===
    // Simple, direct, and literal.
    if (project.qualityTier !== 'cinematic' && project.plan !== 'pro' && project.plan !== 'elite') {
        const basePrompt = [
            shot.prompt, // This contains the core action
            "clear video, standard lighting, 4K"
        ].join(', ');
        return normalizeWhitespace(basePrompt);
    }

    // === PRO TIER PROMPT ===
    // A structured set of "Director's Orders"

    // 1. Master Persona Injection
    let promptParts = [
        "Masterpiece, ultra-detailed, 8K cinematic photography.",
        `Shot on ${ARTISTIC_ATMOSPHERES[project.artisticAtmosphere] || 'ARRI Alexa'}.`
    ];

    // 2. Pro-Tier Cinematic DNA
    promptParts.push(PRODUCTION_STYLES[project.productionStyle] || PRODUCTION_STYLES['standard-clean']);
    promptParts.push(VISUAL_MOODS[project.visualMood] || VISUAL_MOODS['neutral-auto']);

    // 3. The Core Action (from the script)
    promptParts.push(shot.prompt);

    // 4. LIP-SYNC PROTOCOL (CRITICAL)
    // We detect if the script contains dialogue by looking for quotation marks.
    if (shot.prompt.includes('"')) {
        promptParts.push(
            "LIP-SYNC PROTOCOL: This is a dialogue scene. Prioritize perfect, synchronized lip movement for the spoken words. Render facial muscles, mouth shapes, and expressions with extreme precision to match the dialogue."
        );
    }

    // 5. Final Technical Specs
    promptParts.push(`Aspect Ratio: ${project.aspectRatio || '16:9'}.`);
    promptParts.push('No artifacts, no morphing, stable video.');

    return normalizeWhitespace(promptParts.join(' '));
};

// This function remains the same, ensuring we have shots to work with.
export const splitSceneIntoShots = ({ scene, maxShotDuration }) => {
    const duration = Math.max(1, scene.duration || maxShotDuration || 5);
    return { shotCount: 1, shotDurations: [duration] };
};
