/**
 * falService.js
 * 
 * fal.ai Flux image generation service.
 * Replaces all DALL-E 3 calls for character portraits and storyboard frames.
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
    '1:1': 'square_hd',
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
        outputFormat = 'png',
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
export const generateCharacterPortrait = async (description, style, options = {}, userPrompt = null) => {
    let prompt;
    if (userPrompt) {
        prompt = `Character Design Update: ${userPrompt}. Base Description: ${description}. Style: ${style}. Front facing, consistent character portrait sheet, neutral expression, 8k resolution, cinematic lighting, simple clean background.`;
    } else {
        prompt = `Character Reference Portrait: ${description}. Visual Style: ${style}. Front facing, detailed facial features, neutral expression, simple clean background, 8k resolution, cinematic lighting.`;
    }

    return generateImage(prompt, {
        model: options.model || 'fal-ai/flux/schnell',
        steps: options.steps || 4,
        aspectRatio: '1:1',
        outputFormat: 'png',
    });
};

/**
 * Generate a storyboard frame for a scene.
 * @param {string} sceneDescription - Scene prompt/description
 * @param {string} style - Visual style
 * @param {object} options - Model config from tier
 * @param {string} [aspectRatio] - Target aspect ratio
 * @param {string} [referenceImageUrl] - Optional reference image URL for img2img continuity
 * @returns {Promise<{url: string, contentType: string}>}
 */
export const generateStoryboardFrame = async (
    sceneDescription,
    style,
    options = {},
    aspectRatio = '16:9',
    referenceImageUrl = null
) => {
    const prompt = `A single cinematic movie still: ${sceneDescription}. Visual Style: ${style}. Single unified scene, no grid, no panels, detailed composition, cinematic lighting and color grading, high detail, photorealistic.`;

    if (referenceImageUrl) {
        logger.info({ referenceImageUrl, promptLength: prompt.length }, 'Generating storyboard frame via img2img (continuity chain)');

        const result = await fal.subscribe('fal-ai/flux/dev/image-to-image', {
            input: {
                prompt,
                image_url: referenceImageUrl,
                strength: 0.19,
                num_inference_steps: options.steps || 28,
                num_images: 1,
                output_format: 'png',
                enable_safety_checker: true,
            }
        });

        if (!result.data?.images?.[0]?.url) {
            throw new Error('fal.ai returned no image');
        }

        const imageUrl = result.data.images[0].url;
        const contentType = result.data.images[0].content_type || 'image/png';

        // Persist to S3 storage
        if (isStorageConfigured()) {
            try {
                const imgRes = await fetch(imageUrl);
                if (!imgRes.ok) throw new Error(`Failed to download: ${imgRes.status}`);
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const key = buildObjectKey({ userId: 'fal-images', extension: 'png' });
                const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType });
                return { url: persistedUrl, contentType };
            } catch (persistErr) {
                logger.warn({ err: persistErr }, 'Failed to persist, using temp URL');
            }
        }
        return { url: imageUrl, contentType };
    }

    return generateImage(prompt, {
        model: options.model || 'fal-ai/flux/schnell',
        steps: options.steps || 4,
        aspectRatio,
        outputFormat: 'png',
    });
};
