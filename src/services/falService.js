/**
 * falService.js
 * 
 * fal.ai Flux image generation service.
 * Replaces all DALL-E 3 calls for character portraits and world ingredients.
 * Models: flux/schnell (Starter), flux-2/dev (Pro), flux-2/pro-v1.1 (Studio)
 */

import { fal } from '@fal-ai/client';
import { logger } from '../logger.js';
import { isStorageConfigured, uploadBufferToStorage, buildObjectKey } from './storageService.js';

// Configure fal.ai client (reads FAL_KEY from env)
fal.config({
    credentials: process.env.FAL_KEY,
});

/**
 * Map aspect ratio strings to fal.ai image_size values.
 */
const ASPECT_RATIO_MAP = {
    '16:9': 'landscape_16_9',
    '9:16': 'portrait_16_9',
    '4:3': 'landscape_4_3',
    '1:1': 'square',
};

/**
 * Generate an image using fal.ai Flux.
 * @param {string} prompt - Image generation prompt
 * @param {object} options
 * @param {string} options.model - fal.ai model ID (e.g., 'fal-ai/flux/schnell')
 * @param {number} [options.steps] - Number of inference steps
 * @param {string} [options.aspectRatio] - Aspect ratio ('16:9', '9:16', '1:1', '4:3')
 * @param {number} [options.seed] - Seed for reproducibility
 * @param {string} [options.outputFormat] - 'jpeg' or 'png'
 * @returns {Promise<{url: string, contentType: string}>}
 */
export const generateImage = async (prompt, options = {}) => {
    const {
        model = 'fal-ai/flux/schnell',
        steps = 4,
        aspectRatio = '16:9',
        seed,
        outputFormat = 'jpeg',
    } = options;

    const imageSize = ASPECT_RATIO_MAP[aspectRatio] || 'landscape_16_9';

    logger.info({ model, imageSize, steps, promptLength: prompt.length }, 'Generating image via fal.ai');

    try {
        const result = await fal.subscribe(model, {
            input: {
                prompt,
                image_size: imageSize,
                num_inference_steps: steps,
                num_images: 1,
                output_format: outputFormat,
                enable_safety_checker: true,
                ...(seed !== undefined && { seed }),
            },
        });

        if (!result.data?.images?.[0]?.url) {
            throw new Error('fal.ai returned no image');
        }

        const imageUrl = result.data.images[0].url;
        const contentType = result.data.images[0].content_type || `image/${outputFormat}`;

        logger.info({ imageUrl, model }, 'fal.ai image generated successfully');

        // Persist to S3 storage (fal.ai URLs are temporary)
        if (isStorageConfigured()) {
            try {
                const imgRes = await fetch(imageUrl);
                if (!imgRes.ok) throw new Error(`Failed to download fal.ai image: ${imgRes.status}`);

                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const ext = outputFormat === 'png' ? 'png' : 'jpg';
                const key = buildObjectKey({ userId: 'fal-images', extension: ext });
                const contentType = `image/${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`;
                const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType });

                logger.info({ persistedUrl }, 'fal.ai image persisted to storage');
                return { url: persistedUrl, contentType };
            } catch (persistErr) {
                logger.warn({ err: persistErr }, 'Failed to persist fal.ai image, using temp URL');
            }
        }

        return { url: imageUrl, contentType };
    } catch (error) {
        logger.error({ err: error, model, promptLength: prompt.length }, 'fal.ai image generation failed');
        throw new Error(`Image generation failed: ${error.message}`);
    }
};

/**
 * Generate a character portrait.
 * @param {string} description - Character physical description from bible
 * @param {string} style - Visual style of the project
 * @param {object} options - Model config from tier
 * @param {string} [userPrompt] - Optional user override for regeneration
 * @returns {Promise<{url: string, contentType: string}>}
 */
export const generateCharacterPortrait = async (optimizedPrompt, options = {}) => {
    return generateImage(optimizedPrompt, {
        model: options.model || 'fal-ai/flux/dev',
        steps: options.steps || 28,
        aspectRatio: '1:1',
        outputFormat: 'jpeg',
    });
};

/**
 * Generate a world ingredient image.
 * @param {string} description - Ingredient description
 * @param {string} style - Visual style
 * @param {object} options - Model config from tier
 * @param {string} [aspectRatio] - Target aspect ratio
 * @param {string[]} [characterPortraitUrls] - Optional list of character portrait URLs for IP-Adapter consistency
 * @returns {Promise<{url: string, contentType: string}>}
 */
export const generateIngredientImage = async (
    optimizedPrompt,
    options = {},
    aspectRatio = '16:9',
    characterPortraitUrls = []
) => {
    const prompt = optimizedPrompt;

    if (characterPortraitUrls && characterPortraitUrls.length > 0) {
        logger.info({ characterCount: characterPortraitUrls.length, promptLength: prompt.length }, 'Generating world ingredient image via Flux General Image-to-Image');

        try {
            // 1. Map the aspect ratio for Fal
            const imageSize = ASPECT_RATIO_MAP[aspectRatio] || 'landscape_16_9';

            // 2. Use the CORRECT image-to-image endpoint and schema
            const result = await fal.subscribe('fal-ai/flux-general/image-to-image', {
                input: {
                    prompt,
                    // The I2I API only takes a single image_url string, so we pass the first character
                    image_url: characterPortraitUrls[0], 
                    strength: 0.85, // 0.0 to 1.0 (Higher = more imagination/prompt, Lower = closer to original image)
                    image_size: imageSize,
                    num_inference_steps: options.steps || 28,
                    num_images: 1,
                    output_format: 'jpeg',
                    enable_safety_checker: true,
                }
            });

            if (!result.data?.images?.[0]?.url) {
                throw new Error('fal.ai returned no image data');
            }

            const imageUrl = result.data.images[0].url;
            const contentType = 'image/jpeg';

            // Persist to storage
            if (isStorageConfigured()) {
                try {
                    const imgRes = await fetch(imageUrl);
                    if (!imgRes.ok) throw new Error(`Failed to download: ${imgRes.status}`);
                    const buffer = Buffer.from(await imgRes.arrayBuffer());
                    const key = buildObjectKey({ userId: 'fal-images', extension: 'jpg' });
                    const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType });
                    return { url: persistedUrl, contentType };
                } catch (persistErr) {
                    logger.warn({ err: persistErr }, 'Failed to persist Image-to-Image result, using temp URL');
                    return { url: imageUrl, contentType };
                }
            }
            return { url: imageUrl, contentType };
        } catch (adapterErr) {
            logger.error({
                err: adapterErr,
                description,
                falError: adapterErr.data || adapterErr.message
            }, 'Image-to-Image generation failed for ingredient');
        }
    }

    // Default fallback: Standard Text-to-Image (Fast)
    return generateImage(prompt, {
        model: options.model || 'fal-ai/flux/schnell',
        steps: options.steps || 4,
        aspectRatio,
        outputFormat: 'jpeg',
    });
};
/**
 * Generate a character portrait series (Frontal, Left Profile, Right Profile).
 * Returns an array of shots: [{ url, view: 'front'|'left'|'right' }]
 */
export const generateCharacterPortraitSeries = async (description, style, options = {}, userPrompt = null) => {
    logger.info({ charDescription: description }, '🎬 Executing Character Portrait Series Generation (Fal.ai Flux 3-shot sheet)');

    // 1. Generate Frontal (Primary Reference)
    const frontal = await generateCharacterPortrait(description, options);
    
    // Safety check
    if (frontal.url.includes('fal.media') || frontal.url.includes('fal.run')) {
        logger.warn({ frontalUrl: frontal.url }, '⚠️ Frontal portrait is using a temporary Fal URL.');
    }

    const results = [{ url: frontal.url, view: 'front' }];

    // 2. Setup the profile generation function
    const getProfileShot = async (view) => {
        const side = view === 'left' ? 'Left' : 'Right';
        const direction = view === 'left' ? 'left' : 'right';
        
        // This is STILL manual, because we are using PuLID which needs a specific prompt.
        // However, we should probably pass the optimized description here too.
        // For now, let's keep it simple or update the series signature.
        const prompt = `Passport-style 90 degree ${side} profile side view photograph of the same person. ${description}. Style: ${style}.`;

        // Using flux-pulid specifically for face-consistent generation
        const result = await fal.subscribe('fal-ai/flux-pulid', {
            input: {
                prompt,
                reference_image_url: frontal.url,
                image_size: 'square_hd',
                num_inference_steps: options.steps || 20,
                num_images: 1,
                output_format: 'jpeg',
            }
        });

        if (!result.data?.images?.[0]?.url) {
            throw new Error(`fal.ai returned no image for ${view} profile`);
        }

        const imageUrl = result.data.images[0].url;
        
        // Persist to storage (crucial for Kling to access it later)
        if (isStorageConfigured()) {
            try {
                const imgRes = await fetch(imageUrl);
                if (!imgRes.ok) throw new Error(`Failed to download ${view} profile: ${imgRes.status}`);
                
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const key = buildObjectKey({ userId: 'fal-images', extension: 'jpg' });
                const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType: 'image/jpeg' });
                
                logger.info({ persistedUrl, view }, `Fal profile ${view} persisted to storage`);
                return persistedUrl;
            } catch (persistErr) {
                logger.warn({ err: persistErr, view }, `Failed to persist ${view} profile, using temp URL`);
            }
        }
        return imageUrl;
    };

    // 3. Generate Left Profile
    try {
        logger.info('Generating Left Profile shot via Fal Flux PuLID...');
        const leftUrl = await getProfileShot('left');
        results.push({ url: leftUrl, view: 'left' });
    } catch (err) {
        logger.error({ err: err.message }, 'Failed to generate left profile shot');
    }

    // 4. Generate Right Profile
    try {
        logger.info('Generating Right Profile shot via Fal Flux PuLID...');
        const rightUrl = await getProfileShot('right');
        results.push({ url: rightUrl, view: 'right' });
    } catch (err) {
        logger.error({ err: err.message }, 'Failed to generate right profile shot');
    }

    // 5. Check for incomplete sets
    if (results.length < 3) {
        logger.warn({ resultCount: results.length, views: results.map(r => r.view) }, '⚠️ Character portrait series is incomplete — some shots failed to generate');
    }

    return results;
};
