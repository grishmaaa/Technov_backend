/**
 * evolinkService.js
 * 
 * OVERHAULED: Nuclear Minimalist Fix for Kling Elements
 * Enforces Flat Schema and Pure Biometric Descriptions.
 */

import { logger } from '../logger.js';
import { isStorageConfigured, uploadBufferToStorage, buildObjectKey } from './storageService.js';
import prisma from '../config/database.js';

const EVOLINK_BASE_URL = 'https://api.evolink.ai/v1';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getApiKey = () => {
    const key = process.env.EVOLINK_API_KEY;
    if (!key) throw new Error('EVOLINK_API_KEY not configured');
    return key;
};

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
        if (response.status >= 400 && response.status < 500) err.isPermanent = true;
        throw err;
    }
    return response.json();
};

export const extractVideoUrl = (data) => {
    return data.result_data?.video_url || data.result_data?.output?.video_url || data.result_data?.url || data.task_result?.videos?.[0]?.url || data.task_result?.output?.videos?.[0]?.url || data.works?.[0]?.resource?.resource || data.works?.[0]?.video?.url || data.output?.url || data.results?.[0] || data.task_info?.results?.[0] || data.video_url || data.url;
};

const extractElementId = (data) => {
    return data.result_data?.element_id || data.task_result?.element_id || data.result_data?.id;
};

/**
 * Submit Video Task - FLAT ROOT
 */
export const submitVideoGeneration = async (prompt, options = {}) => {
    const { model = 'kling-v3.0', imageUrl, elementList = [], referenceImages = [], duration = 5, aspectRatio = '16:9', quality = 'standard' } = options;
    let finalModel = model;
    if (finalModel.startsWith('kling-v3')) finalModel = imageUrl ? 'kling-v3-image-to-video' : 'kling-v3-text-to-video';

    let finalQuality = quality;
    if (finalModel.startsWith('kling-v3')) {
        if (finalQuality === 'standard') finalQuality = '720p';
        if (finalQuality === 'professional') finalQuality = '1080p';
    }

    const payload = {
        model: finalModel,
        prompt: prompt,
        duration: Math.min(Math.max(duration, 5), 10),
        aspect_ratio: aspectRatio,
        quality: finalQuality.toUpperCase(),
        sound: 'on'
    };

    if (process.env.APP_URL) payload.callback_url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/evolink`;
    if (imageUrl) payload.image_url = imageUrl;
    if (elementList.length > 0) payload.element_list = elementList;
    if (referenceImages.length > 0) payload.reference_images = referenceImages;

    logger.info('🚀 SUBMITTING VIDEO:', JSON.stringify(payload, null, 2));
    const data = await evolinkFetch('/videos/generations', { method: 'POST', body: JSON.stringify(payload) });
    return { taskId: data.id, status: data.status, estimatedTime: data.task_info?.estimated_time || 300 };
};

export const pollVideoTask = async (taskId, options = {}) => {
    const { maxAttempts = 120, intervalMs = 5000, onProgress } = options;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(intervalMs);
        const data = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });
        const status = data.status;
        if (onProgress) onProgress(data.progress || 0, status);
        if (['completed', 'succeed', 'success'].includes(status?.toLowerCase())) return { videoUrl: extractVideoUrl(data), status: 'completed' };
        if (['failed', 'error', 'canceled'].includes(status?.toLowerCase())) throw new Error(`Video failed: ${data.error?.message || 'Unknown'}`);
    }
    throw new Error('Timed out');
};

export const generateVideo = async (prompt, options = {}) => {
    const { taskId } = await submitVideoGeneration(prompt, options);
    return pollVideoTask(taskId, options);
};

/**
 * Create Custom Element - NUCLEAR FLAT FIX
 */
export const createCharacterElement = async (name, description, frontalImageUrl, referImages = []) => {
    logger.info({ charName: name }, 'Executing NUCLEAR MINIMALIST Element Fix');

    // 1. Extreme Physical Cleanup: Remove story, remove dangling punctuation, remove negative traits (unseen face)
    const cleanDesc = (description || '')
        .replace(/\b(the unseen driver of|the driver of|the sports car|the girl|the biker|bicycle|danger|unaware|pursuer|mysterious|aggressive|relentless|unseen|motorcycle|helmet|racer|bikes|riding|wearing a|in a|with a|races|suit|jacket|coat|scarf|mask|visor|action|running|pedaling|driver of a|matte black sports car|never clearly seen|face never|unaware of|whose face|is never)\b[^,.]*/gi, '')
        .replace(/[,;.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const finalDescription = (cleanDesc.length > 5)
        ? `A sharp human face with ${cleanDesc}`
        : "A detailed human face, standard facial features, centered, looking at camera.";

    // 2. FLAT ROOT PAYLOAD - Minimalist to match Dashboard receipt
    const payload = {
        model: 'kling-custom-element',
        element_name: (name || 'Character').substring(0, 20),
        element_description: finalDescription.substring(0, 100),
        reference_type: 'image_refer',
        element_image_list: {
            frontal_image: frontalImageUrl,
        },
        prompt: "", // Send empty prompt to satisfy video-endpoint validation
        standard_model_name: 'kling-custom-element'
    };

    if (referImages.length > 0) {
        payload.element_image_list.refer_images = referImages.map(url => ({ image_url: url }));
    }

    logger.info('🚀 NUCLEAR_ELEMENT_PAYLOAD:', JSON.stringify(payload, null, 2));

    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    const taskId = data.id;
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const pollData = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });
        if (['completed', 'succeed', 'success'].includes(pollData.status)) {
            const elementId = extractElementId(pollData);
            if (!elementId) throw new Error('Element ID missing from response');
            return { elementId };
        }
        if (['failed', 'error', 'canceled'].includes(pollData.status)) {
            const err = pollData.error?.message || pollData.result_data?.error_message || 'Invalid Training Data';
            throw new Error(`Kling Element Failed: ${err}`);
        }
    }
    throw new Error('Element creation timed out');
};
