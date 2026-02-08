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
    // Strip timestamp markers like [00:01-00:05] or [00:01 - 00:05] which can trigger RAI filter sensitivities.
    // Enhanced regex to handle various dash types (en-dash, em-dash) and spaces.
    let cleanNarrative = (narrativeBeat || '').replace(/\[\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}\]/g, '').trim();

    // Proto-Sanitation: Clean common triggers before the first attempt to avoid repetitive blocks
    cleanNarrative = cleanNarrative
        .replace(/gun|pistol|weapon|knife|blade|blood|kill|dead|corpse|violence|attack|fight|punch|slap|hit/gi, 'action')
        .replace(/wound|wounded|hurt|bleeding|blood|gore/gi, 'injured')
        .replace(/hunt|hunting|tracking|stalking/gi, 'following')
        .replace(/scream|screaming|shout|shouting|terrified|scared|fear|horror/gi, 'intense expression')
        .replace(/growl|growls|roar|roaring|fierce|angry|rage/gi, 'intense presence')
        .replace(/smoke|cigarette|cigar|tobacco|wine|whiskey|alcohol|drunk|murder|crime|stolen|thief/gi, 'atmosphere')
        .replace(/noir|gritty|dark alley|sinister|gloomy|darkness|scary/gi, 'cinematic ambient')
        .replace(/detective|policeman|guard|soldier/gi, 'mysterious figure');

    let enhancedPrompt = cleanNarrative;
    const assetSheet = project.metadata || {}; // Handle potential null metadata

    // 1. CHARACTER CONSISTENCY
    // Logic updated: We now use Image-to-Video via heroAssetUrls for character consistency.
    // Injecting the entire Bible into every text prompt was causing "Veo could not generate vid" 
    // errors due to excessive prompt length (2300+ characters).
    // The visual reference is much more powerful and stable than text descriptions alone.

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
