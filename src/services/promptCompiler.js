/**
 * promptCompiler.js
 * 
 * Simplified compiler for Veo 3.1.
 * Since Stage 2 (Gemini) already generates high-fidelity, policy-compliant prompts,
 * this function functions as a pass-through to avoid confusing the Veo video model
 * with meta-instructions.
 */

// Enhanced compileVeoPrompt with Character & Style Injection
export const compileVeoPrompt = ({ narrativeBeat, project = {}, options = {} }) => {
    let enhancedPrompt = narrativeBeat.trim();
    const assetSheet = project.metadata || {}; // Handle potential null metadata

    // 1. INJECT CHARACTER CONSISTENCY from Asset Sheet
    if (assetSheet.character_bible && Array.isArray(assetSheet.character_bible) && assetSheet.character_bible.length > 0) {
        const characterRefs = assetSheet.character_bible
            .map(char => {
                // Safely access nested properties
                const features = char.physical_description?.distinctive_features || [];
                const featureString = Array.isArray(features) ? features.join(', ') : features;
                return `${char.id}: ${featureString}`;
            })
            .join(' | ');

        if (characterRefs) {
            // Append to prompt (Veo sees this as visual instruction)
            enhancedPrompt += `\n\nCharacter Information: ${characterRefs}`;
        }
    }

    // 2. INJECT STYLE TEMPLATE from Asset Sheet
    if (assetSheet.tone_and_style) {
        const style = assetSheet.tone_and_style;
        const styleParts = [];

        if (style.film_reference) styleParts.push(`Visual Style: ${style.film_reference}`);
        if (style.camera_philosophy) styleParts.push(style.camera_philosophy);

        if (styleParts.length > 0) {
            enhancedPrompt += `\n\n${styleParts.join(', ')}`;
        }

        if (style.color_palette && Array.isArray(style.color_palette)) {
            enhancedPrompt += `\nColor Palette: ${style.color_palette.join(', ')}`;
        }
    }

    // 3. INJECT TIER-SPECIFIC ENHANCEMENTS (Elite gets more cinematic language)
    const userPlan = (project.user?.plan || 'basic').toLowerCase();
    if (userPlan === 'elite' || userPlan === 'pro') {
        enhancedPrompt += `\n\nCinematography: Ultra high detail, 8K quality textures, professional studio lighting, anamorphic lens characteristics`;
    }

    return enhancedPrompt;
};
