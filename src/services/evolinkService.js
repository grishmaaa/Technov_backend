/**
 * evolinkService.js
 * 
 * EvoLink unified API gateway for video generation.
 * Supports: Kling 2.6, Kling 3.0, Seedance 2.0 (and future models)
 * Replaces all Veo 3.1 / Vertex AI video generation code.
 * 
 * API: POST https://api.evolink.ai/v1/videos/generations
 * Auth: Bearer EVOLINK_API_KEY
 * Async: submit → poll task_id → get result
 */

import { logger } from '../logger.js';
import { isStorageConfigured, uploadBufferToStorage, buildObjectKey } from './storageService.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const EVOLINK_BASE_URL = 'https://api.evolink.ai/v1';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get EvoLink API key from environment.
 */
const getApiKey = () => {
    const key = process.env.EVOLINK_API_KEY;
    if (!key) throw new Error('EVOLINK_API_KEY not configured');
    return key;
};

/**
 * Make an authenticated request to EvoLink.
 */
const evolinkFetch = async (endpoint, options = {}) => {
    const url = `${EVOLINK_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${getApiKey()}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });

    if (!response.ok) {
        const errorBody = await response.text();
        logger.error({ status: response.status, body: errorBody, endpoint }, 'EvoLink API error');
        throw new Error(`EvoLink API error (${response.status}): ${errorBody}`);
    }

    return response.json();
};

/**
 * Submit a video generation task to EvoLink.
 * @param {string} prompt - Text prompt for video generation
 * @param {object} options
 * @param {string} options.model - Model ID (kling-v2.6, kling-v3.0, seedance-2.0)
 * @param {string} [options.imageUrl] - Start frame image URL (storyboard → image-to-video)
 * @param {string[]} [options.elementList] - Kling Custom Element IDs for character consistency
 * @param {number} [options.duration] - Duration in seconds (5-10 for Kling 2.6/3.0)
 * @param {string} [options.aspectRatio] - Aspect ratio ('16:9', '9:16', '1:1')
 * @param {string} [options.quality] - Quality level ('standard', 'professional')
 * @returns {Promise<{taskId: string, status: string, estimatedTime: number}>}
 */
export const submitVideoGeneration = async (prompt, options = {}) => {
    const {
        model = 'kling-v3.0',
        imageUrl,
        elementList = [],
        duration = 5,
        aspectRatio = '16:9',
        quality = 'standard',
    } = options;

    logger.info({
        model,
        hasImage: !!imageUrl,
        elementCount: elementList.length,
        duration,
        aspectRatio,
        quality,
        promptLength: prompt.length,
    }, 'Submitting video generation to EvoLink');

    // Intelligent model selection for Kling v3
    let finalModel = model;
    if (finalModel.startsWith('kling-v3')) {
        finalModel = imageUrl ? 'kling-v3-image-to-video' : 'kling-v3-text-to-video';
    }

    // Quality mapping for Kling v3
    let finalQuality = quality;
    if (finalModel.startsWith('kling-v3')) {
        if (finalQuality === 'standard') finalQuality = '720p';
        if (finalQuality === 'professional') finalQuality = '1080p';
    }

    const payload = {
        model: finalModel,
        prompt,
        duration: Math.min(Math.max(duration, 5), 10), // Kling supports 5-10s
        aspect_ratio: aspectRatio,
        quality: finalQuality,
    };

    // Image-to-video: storyboard frame as start frame
    if (imageUrl) {
        payload.image_url = imageUrl;
    }

    // Kling Custom Elements for character consistency
    if (elementList.length > 0) {
        payload.element_list = elementList;
    }

    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    logger.info({ taskId: data.id, status: data.status }, 'EvoLink video task submitted');

    return {
        taskId: data.id,
        status: data.status,
        estimatedTime: data.task_info?.estimated_time || 300,
    };
};

/**
 * Poll an EvoLink task until completion.
 * @param {string} taskId - Task ID from submitVideoGeneration
 * @param {object} [options]
 * @param {number} [options.maxAttempts] - Max polling attempts (default: 120)
 * @param {number} [options.intervalMs] - Polling interval in ms (default: 5000)
 * @param {function} [options.onProgress] - Progress callback (percent, status)
 * @returns {Promise<{videoUrl: string, status: string}>}
 */
export const pollVideoTask = async (taskId, options = {}) => {
    const { maxAttempts = 120, intervalMs = 5000, onProgress } = options;

    logger.info({ taskId, maxAttempts, intervalMs }, 'Polling EvoLink video task');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(intervalMs);

        try {
            const data = await evolinkFetch(`/videos/generations/${taskId}`, {
                method: 'GET',
            });

            const progress = data.progress || 0;
            const status = data.status;

            if (onProgress) {
                onProgress(progress, status);
            }

            if (status === 'completed' || status === 'succeed') {
                // Extract video URL from result
                const videoUrl = data.result_data?.video_url
                    || data.result_data?.output?.video_url
                    || data.result_data?.url;

                if (!videoUrl) {
                    logger.error({ taskId, resultData: data.result_data }, 'EvoLink completed but no video URL found');
                    throw new Error('EvoLink task completed but no video URL in response');
                }

                logger.info({ taskId, videoUrl }, 'EvoLink video generation completed');
                return { videoUrl, status: 'completed' };
            }

            if (status === 'failed' || status === 'error') {
                const errorMsg = data.result_data?.error_message || data.error?.message || 'Unknown error';
                logger.error({ taskId, error: errorMsg }, 'EvoLink video generation failed');
                throw new Error(`EvoLink video generation failed: ${errorMsg}`);
            }

            // Still processing
            logger.debug({ taskId, attempt, progress, status }, 'EvoLink task still processing');
        } catch (error) {
            if (error.message.includes('EvoLink video generation failed')) {
                throw error; // Don't retry on actual failures
            }
            logger.warn({ taskId, attempt, err: error }, 'Polling error, retrying');
        }
    }

    throw new Error(`EvoLink video generation timed out after ${maxAttempts * intervalMs / 1000}s`);
};

/**
 * Generate a video — submit and poll until complete.
 * Downloads the result and persists to our S3 storage.
 * @param {string} prompt - Text prompt
 * @param {object} options - Same as submitVideoGeneration + polling options
 * @returns {Promise<{video_url: string, status: string}>}
 */
export const generateVideo = async (prompt, options = {}) => {
    const { onProgress, ...submitOptions } = options;

    // 1. Submit generation task
    const { taskId, estimatedTime } = await submitVideoGeneration(prompt, submitOptions);

    // 2. Poll for completion
    const { videoUrl } = await pollVideoTask(taskId, {
        intervalMs: 5000,
        maxAttempts: Math.max(60, Math.ceil(estimatedTime / 5)),
        onProgress,
    });

    // 3. Download and persist to our storage
    if (isStorageConfigured()) {
        try {
            logger.info({ videoUrl }, 'Downloading EvoLink video for persistence');
            const videoRes = await fetch(videoUrl);
            if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);

            const buffer = Buffer.from(await videoRes.arrayBuffer());
            const key = buildObjectKey({ userId: 'evolink-videos', extension: 'mp4' });
            const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType: 'video/mp4' });

            logger.info({ persistedUrl }, 'EvoLink video persisted to storage');
            return { video_url: persistedUrl, status: 'completed' };
        } catch (persistErr) {
            logger.warn({ err: persistErr }, 'Failed to persist EvoLink video, using original URL');
        }
    }

    return { video_url: videoUrl, status: 'completed' };
};

/**
 * Create a Kling Custom Element for character consistency.
 * The returned element_id can be passed to subsequent video generations.
 * @param {string} name - Character name
 * @param {string} description - Character description
 * @param {string} frontalImageUrl - Front-facing character portrait URL
 * @param {string[]} [referImages] - Additional reference image URLs
 * @returns {Promise<{elementId: string}>}
 */
export const createCharacterElement = async (name, description, frontalImageUrl, referImages = []) => {
    logger.info({ name, description, hasImages: !!frontalImageUrl }, 'Creating Kling Custom Element');

    const payload = {
        model: 'kling-custom-element',
        model_params: {
            element_name: name,
            element_description: description,
            reference_type: 'image_refer',
            element_image_list: {
                frontal_image: frontalImageUrl,
                refer_images: referImages.map(url => ({ image_url: url })),
            },
        },
    };

    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    // Element creation is async — poll for the element_id
    const result = await pollVideoTask(data.id, { intervalMs: 3000, maxAttempts: 40 });

    // The result should contain the element_id
    const elementId = result.videoUrl; // In this context, the "result" is the element_id
    logger.info({ name, elementId }, 'Kling Custom Element created');

    return { elementId };
};
