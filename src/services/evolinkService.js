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
import prisma from '../config/database.js';
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
        const err = new Error(`EvoLink API error (${response.status}): ${errorBody}`);
        if (response.status >= 400 && response.status < 500) {
            err.isPermanent = true;
        }
        throw err;
    }

    return response.json();
};

/**
 * Helper to extract video URL from various possible EvoLink response shapes.
 */
export const extractVideoUrl = (data) => {
    return data.result_data?.video_url
        || data.result_data?.output?.video_url
        || data.result_data?.url
        || data.task_result?.videos?.[0]?.url
        || data.task_result?.output?.videos?.[0]?.url
        || data.works?.[0]?.resource?.resource
        || data.works?.[0]?.video?.url
        || data.output?.url
        || data.results?.[0];
};

/**
 * Helper to extract element ID from element creation tasks.
 */
const extractElementId = (data) => {
    return data.result_data?.element_id
        || data.task_result?.element_id
        || data.result_data?.id;
};

/**
 * Submit a video generation task to EvoLink.
 */
export const submitVideoGeneration = async (prompt, options = {}) => {
    const {
        model = 'kling-v3.0',
        imageUrl,
        elementList = [],
        referenceImages = [],
        duration = 5,
        aspectRatio = '16:9',
        quality = 'standard',
    } = options;

    logger.info({
        model,
        hasImage: !!imageUrl,
        elementCount: elementList.length,
        referenceCount: referenceImages.length,
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
        duration: Math.min(Math.max(duration, 5), 10),
        aspect_ratio: aspectRatio,
        quality: finalQuality.toUpperCase(),
        sound: 'on', // New explicit flag for Kling v3 / Seedance
    };

    // Use Webhooks if APP_URL is configured (Enterprise Mode)
    if (process.env.APP_URL) {
        payload.callback_url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/evolink`;
        logger.info({ callbackUrl: payload.callback_url }, 'Attaching webhook callback to EvoLink task');
    }

    if (imageUrl) payload.image_url = imageUrl;
    if (elementList.length > 0) payload.element_list = elementList;
    if (referenceImages.length > 0) payload.reference_images = referenceImages;

    // Use model_params for advanced control if needed, 
    // but Kling v3 text-to-video usually prefers root level params in EvoLink wrapper.
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
 */
export const pollVideoTask = async (taskId, options = {}) => {
    const { maxAttempts = 120, intervalMs = 5000, onProgress } = options;

    logger.info({ taskId, maxAttempts, intervalMs }, 'Polling EvoLink video task');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(intervalMs);

        try {
            const data = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });

            const progress = data.progress || 0;
            const status = data.status;

            if (onProgress) onProgress(progress, status);

            // OPTIMIZATION: Check if the Webhook has already updated the record in our DB
            if (options.sceneId) {
                const dbScene = await prisma.scene.findUnique({
                    where: { id: options.sceneId },
                    select: { videoUrl: true, state: true }
                });

                if (dbScene?.videoUrl) {
                    logger.info({ taskId, sceneId: options.sceneId }, '✅ Task finished via Webhook (DB check)');
                    return { videoUrl: dbScene.videoUrl, status: 'completed' };
                }
            }

            const isFinished = ['completed', 'succeed', 'success'].includes(status?.toLowerCase());
            const isFailed = ['failed', 'error', 'canceled'].includes(status?.toLowerCase());

            if (isFinished) {
                const videoUrl = extractVideoUrl(data);

                if (!videoUrl) {
                    logger.error({ taskId, fullResponse: data }, 'EvoLink completed but no video URL found — FULL RESPONSE LOGGED');
                    throw new Error('EvoLink task completed but no video URL found in any known field');
                }

                logger.info({ taskId, videoUrl }, 'EvoLink video generation completed');
                return { videoUrl, status: 'completed' };
            }

            if (status === 'failed' || status === 'error') {
                const errorMsg = data.result_data?.error_message || data.error?.message || 'Unknown error';
                logger.error({ taskId, error: errorMsg }, 'EvoLink video generation failed');
                throw new Error(`EvoLink video generation failed: ${errorMsg}`);
            }

            logger.debug({ taskId, attempt, progress, status }, 'EvoLink task still processing');
        } catch (error) {
            // CRITICAL: If the error is an actual generation failure or result-parsing error, 
            // STOP polling to save credits. Only retry on network/fetch errors.
            if (error.message.includes('failed') || error.message.includes('no video URL found')) {
                throw error;
            }
            logger.warn({ taskId, attempt, err: error.message }, 'Polling network error, retrying');
        }
    }

    throw new Error(`EvoLink video generation timed out after ${maxAttempts * intervalMs / 1000}s`);
};

/**
 * Generate a video — submit and poll until complete.
 */
export const generateVideo = async (prompt, options = {}) => {
    const { onProgress, ...submitOptions } = options;

    // 1. Submit generation task
    const { taskId, estimatedTime } = await submitVideoGeneration(prompt, submitOptions);

    // 2. Attach taskId to scene in DB immediately so the Webhook can find it
    if (options.sceneId) {
        try {
            await prisma.scene.update({
                where: { id: options.sceneId },
                data: { taskId: taskId }
            });
        } catch (dbErr) {
            logger.warn({ taskId, sceneId: options.sceneId }, 'Failed to save taskId to scene DB, webhooks might be orphaned');
        }
    }

    // 3. Poll for completion (Hybrid mode: checks DB + API)
    const { videoUrl } = await pollVideoTask(taskId, {
        sceneId: options.sceneId, // Pass to allow DB checking
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
            logger.warn({ err: persistErr.message }, 'Failed to persist EvoLink video, using original URL');
        }
    }

    return { video_url: videoUrl, status: 'completed' };
};

/**
 * Create a Kling Custom Element for character consistency.
 */
export const createCharacterElement = async (name, description, frontalImageUrl, referImages = []) => {
    logger.info({ name, description, hasImages: !!frontalImageUrl }, 'Creating Kling Custom Element');

    const safeName = (name || 'Character').substring(0, 20);
    const safeDescription = (description || 'Character reference').substring(0, 100);

    const payload = {
        model: 'kling-custom-element',
        model_params: {
            element_name: safeName,
            element_description: safeDescription,
            reference_type: 'image_refer',
            element_image_list: {
                frontal_image: frontalImageUrl,
                refer_images: (referImages || []).map(url => ({ image_url: url })),
            },
        }
    };

    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    // Dedicated polling loop for elements to avoid burning credits on generic video polling
    const taskId = data.id;
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const pollData = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });

        if (pollData.status === 'completed' || pollData.status === 'succeed') {
            const elementId = extractElementId(pollData);
            if (!elementId) {
                logger.error({ taskId, fullResponse: pollData }, 'Element created but no elementId found');
                throw new Error('Element creation succeeded but element_id is missing from response');
            }
            logger.info({ name, elementId }, 'Kling Custom Element created');
            return { elementId };
        }

        if (pollData.status === 'failed' || pollData.status === 'error') {
            throw new Error(`Element creation failed: ${pollData.error?.message || 'Unknown error'}`);
        }
    }

    throw new Error('Kling Custom Element creation timed out');
};
