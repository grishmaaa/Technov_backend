/**
 * modelConfig.js
 * 
 * Single source of truth for all AI model selections.
 * Pipeline reads user tier → gets all models. Upgrading a user = changing one DB field.
 * No model names are hardcoded anywhere else in the pipeline.
 */

export const MODEL_TIERS = {
    starter: {
        video: { provider: 'evolink', model: 'kling-v3-text-to-video', quality: '720p' },
        image: { provider: 'fal', model: 'fal-ai/flux/schnell', steps: 4 },
        llm: { provider: 'google', model: 'gemini-2.5-flash' },
        llmEdit: { provider: 'google', model: 'gemini-2.5-flash' },
        safety: { provider: 'google', model: 'gemini-2.5-flash' },
        maxResolution: '1080p',
        maxDuration: 30,
        maxScenes: 4,
        creditsPerClip: 80,
        creditsPerImage: 5,
    },
    pro: {
        video: { provider: 'evolink', model: 'kling-v3-text-to-video', quality: '1080p' },
        image: { provider: 'fal', model: 'fal-ai/flux/dev', steps: 25 },
        llm: { provider: 'google', model: 'gemini-2.5-pro' },
        llmEdit: { provider: 'google', model: 'gemini-2.5-flash' },
        safety: { provider: 'google', model: 'gemini-2.5-flash' },
        maxResolution: '4K',
        maxDuration: 60,
        maxScenes: 8,
        creditsPerClip: 150,
        creditsPerImage: 8,
    },
    studio: {
        video: { provider: 'evolink', model: 'kling-v3-text-to-video', quality: '1080p' },
        image: { provider: 'fal', model: 'fal-ai/flux-pro/v1.1', steps: 30 },
        llm: { provider: 'google', model: 'gemini-2.5-pro' },
        llmEdit: { provider: 'google', model: 'gemini-2.5-pro' },
        safety: { provider: 'google', model: 'gemini-2.5-flash' },
        maxResolution: '4K',
        maxDuration: 120,
        maxScenes: 15,
        creditsPerClip: 200,
        creditsPerImage: 12,
    },
};

/**
 * Map user plan names → internal tier names.
 * Adding a new plan = adding one entry here. No code changes elsewhere.
 */
const PLAN_TO_TIER = {
    free: 'starter',
    base: 'starter',
    starter: 'starter',
    basic: 'starter',
    pro: 'pro',
    elite: 'studio',
    studio: 'studio',
    custom: 'studio',
};

/**
 * Get the full model config for a user's plan.
 * @param {string} userPlan - The user's plan name from DB (e.g., 'free', 'pro', 'elite')
 * @returns {object} - The full tier config with video, image, llm models and limits
 */
export const getTierConfig = (userPlan) => {
    const tier = PLAN_TO_TIER[(userPlan || 'free').toLowerCase()] || 'starter';
    return { ...MODEL_TIERS[tier], tierName: tier };
};

/**
 * Get the tier name for a user's plan.
 * @param {string} userPlan 
 * @returns {'starter' | 'pro' | 'studio'}
 */
export const getTierName = (userPlan) => {
    return PLAN_TO_TIER[(userPlan || 'free').toLowerCase()] || 'starter';
};

/**
 * Calculate credit cost for a video generation job.
 * @param {object} params
 * @param {string} params.userPlan - User's plan
 * @param {number} params.sceneCount - Number of scenes
 * @param {number} params.characterCount - Number of characters
 * @returns {object} - Breakdown of costs
 */
export const calculateCreditCost = ({ userPlan, sceneCount, characterCount = 0 }) => {
    const config = getTierConfig(userPlan);
    const videoCost = sceneCount * config.creditsPerClip;
    const ingredientCost = sceneCount * config.creditsPerImage;
    const characterCost = characterCount * config.creditsPerImage;
    const scriptCost = 10; // Flat cost for script generation

    return {
        total: videoCost + ingredientCost + characterCost + scriptCost,
        breakdown: {
            script: scriptCost,
            ingredients: ingredientCost,
            characters: characterCost,
            video: videoCost,
        },
        tierName: config.tierName,
    };
};
