/**
 * evolinkService.js
 * 
 * EvoLink unified API gateway for video generation.
 * Supports: Kling 2.6, Kling 3.0, Seedance 2.0 (and future models)
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

/**
 * Smart URL Rewrite: Automatically swaps blocked GCS links for the Cloudflare Worker URL.
 */
const ensureCdnUrl = (url) => {
    if (!url || typeof url !== 'string') return url;
    const cdnUrl = process.env.GCS_CDN_URL;
    if (!cdnUrl) return url;
    
    // If it's already a CDN URL, leave it
    if (url.includes(new URL(cdnUrl).hostname)) return url;
    
    // If it's a GCS URL, rewrite it to use the new proxy
    if (url.includes('storage.googleapis.com')) {
        const bucket = process.env.GCP_BUCKET_NAME || 'technov-assets-bucket';
        const parts = url.split(`${bucket}/`);
        if (parts.length > 1) {
            const base = cdnUrl.replace(/\/+$/, '');
            const key = parts[1].replace(/^\/+/, '');
            return `${base}/${key}`;
        }
    }
    return url;
};

const evolinkFetch = async (endpoint, options = {}) => {
    // 5 Second Debug Delay (requested by user to test errors one-by-one)
    await sleep(5000);

    const url = `${EVOLINK_BASE_URL}${endpoint}`;
    
    // THE TRUTH LOG: EXACTLY WHAT IS SENT TO THE WIRE
    console.log('--- START EVOLINK RAW REQUEST ---');
    console.log('URL:', url);
    console.log('METHOD:', options.method || 'GET');
    console.log('BODY:', options.body);
    console.log('--- END EVOLINK RAW REQUEST ---');

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

export const extractVideoUrl = (data) => {
    return data.result_data?.video_url
        || data.result_data?.output?.video_url
        || data.result_data?.url
        || data.task_result?.videos?.[0]?.url
        || data.task_result?.output?.videos?.[0]?.url
        || data.works?.[0]?.resource?.resource
        || data.works?.[0]?.video?.url
        || data.output?.url
        || data.results?.[0]
        || data.task_info?.results?.[0]
        || data.video_url
        || data.url;
};

const extractElementId = (data) => {
    return data.result_data?.element_id
        || data.task_result?.element_id
        || data.result_data?.id;
};

/**
 * Submit a video — ROOT level params
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

    let finalModel = model;
    if (finalModel.startsWith('kling-v3')) {
        finalModel = imageUrl ? 'kling-v3-image-to-video' : 'kling-v3-text-to-video';
    }

    let finalQuality = quality;
    if (finalModel.startsWith('kling-v3')) {
        if (finalQuality === 'standard') finalQuality = '720p';
        if (finalQuality === 'professional') finalQuality = '1080p';
    }

    // 100% CLEAN ISOLATED OBJECT CONSTRUCTION
    const videoPayload = {
        model: finalModel,
        prompt: prompt,
        duration: Math.min(Math.max(duration, 5), 10),
        aspect_ratio: aspectRatio,
        quality: finalQuality.toUpperCase(),
        sound: 'on',
        trace_id: "2026-03-17-v6-VIDEO"
    };

    if (process.env.APP_URL) {
        videoPayload.callback_url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/evolink`;
    }

    if (imageUrl) videoPayload.image_url = ensureCdnUrl(imageUrl);
    if (elementList && elementList.length > 0) videoPayload.element_list = elementList;
    if (referenceImages && referenceImages.length > 0) {
        videoPayload.reference_images = referenceImages.map(r => ({
            ...r,
            url: ensureCdnUrl(r.url)
        }));
    }

    logger.info({ model: videoPayload.model, type: 'VIDEO_GENERATION' }, '📡 Submitting JSON to EvoLink');
    
    // Explicit console.log to be 1000% sure what we see in Railway logs
    console.log('--- START RAW VIDEO PAYLOAD ---');
    console.log(JSON.stringify(videoPayload, null, 2));
    console.log('--- END RAW VIDEO PAYLOAD ---');

    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: JSON.stringify(videoPayload),
    });

    return { taskId: data.id, status: data.status, estimatedTime: data.task_info?.estimated_time || 300 };
};

export const pollVideoTask = async (taskId, options = {}) => {
    const { maxAttempts = 120, intervalMs = 5000, onProgress } = options;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(intervalMs);
        try {
            const data = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });
            const progress = data.progress || 0;
            const status = data.status;
            if (onProgress) onProgress(progress, status);

            if (options.sceneId) {
                const dbScene = await prisma.scene.findUnique({ where: { id: options.sceneId }, select: { videoUrl: true } });
                if (dbScene?.videoUrl) return { videoUrl: dbScene.videoUrl, status: 'completed' };
            }

            if (['completed', 'succeed', 'success'].includes(status?.toLowerCase())) {
                const videoUrl = extractVideoUrl(data);
                if (!videoUrl) throw new Error('No video URL found');
                return { videoUrl, status: 'completed' };
            }

            if (['failed', 'error', 'canceled'].includes(status?.toLowerCase())) {
                const errorMsg = data.result_data?.error_message || data.error?.message || data.result_data?.error || 'Unknown error';
                logger.error({ taskId, error: errorMsg }, 'EvoLink task failed');

                // Proactive connectivity diagnostic
                if (errorMsg.toLowerCase().includes('image') || errorMsg.toLowerCase().includes('process')) {
                    // We check if the job was using a GCS URL
                    const isGcs = JSON.stringify(data).includes('storage.googleapis.com');
                    if (isGcs) {
                        logger.warn('⚠️ CONNECTIVITY WARNING: Your video task failed at "Image Processing". Kling models are hosted in China and are strictly BLOCKED from accessing Google Cloud Storage (storage.googleapis.com). You must use a CDN proxy or a different storage provider like R2 or Cloudflare to host your reference images.');
                    }
                }

                const err = new Error(`EvoLink failed: ${errorMsg}`);
                err.isPermanent = true;
                throw err;
            }
        } catch (error) {
            if (error.message.includes('failed')) throw error;
        }
    }
    throw new Error('Timed out');
};

export const generateVideo = async (prompt, options = {}) => {
    const { taskId, estimatedTime } = await submitVideoGeneration(prompt, options);
    const { videoUrl } = await pollVideoTask(taskId, { intervalMs: 5000, maxAttempts: 100 });
    return { video_url: videoUrl, status: 'completed' };
};

/**
 * Create custom element — NESTED model_params
 */
export const createCharacterElement = async (name, description, frontalImageUrl, referImages = []) => {
    logger.info({ name }, 'Executing STRICT Character Element Generation');

    // Enhanced Sanitization (Final Boss Edition)
    const scrub = (text) => (text || '')
        .replace(/\b(the unseen driver of|the driver of|the sports car|the girl|the biker|bicycle|danger|unaware|pursuer|mysterious|aggressive|relentless|unseen|motorcycle|helmet|racer|bikes|riding|wearing a|in a|with a|races|suit|jacket|coat|scarf|mask|visor|action|running|pedaling|driver of a|matte black sports car)\b[^,.]*/gi, '')
        .replace(/\b(the|a|an|of|in|with|and|is|was|were|on)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const cleanDesc = scrub(description);
    const finalDescription = (cleanDesc.length > 3)
        ? `A detailed human portrait showing ${cleanDesc}`
        : "A clear human portrait, standard facial features, centered facial structure.";

    const safeName = (name || 'Character').substring(0, 20);
    const safeDescription = finalDescription.substring(0, 100);

    // 100% CLEAN ISOLATED OBJECT CONSTRUCTION - NO INHERITANCE, NO PROMPT
    const elementPayload = {
        model: 'kling-custom-element',
        model_params: {
            element_name: safeName,
            element_description: safeDescription,
            reference_type: 'image_refer',
            element_image_list: {
                frontal_image: ensureCdnUrl(frontalImageUrl),
            },
            standard_model_name: 'kling-custom-element'
        },
        trace_id: "2026-03-17-v6-DIAGNOSTIC-FIX"
    };

    if (referImages && referImages.length > 0) {
        elementPayload.model_params.element_image_list.refer_images = referImages.map(url => ({ 
            image_url: ensureCdnUrl(url) 
        }));
    }

    logger.info({ name, type: 'CHARACTER_ELEMENT_CREATION' }, '🚀 Executing Character Element Generation');
    
    // THE ULTIMATE PROOF: Direct standard out print
    console.log('--- START RAW CHARACTER ELEMENT PAYLOAD ---');
    console.log(JSON.stringify(elementPayload, null, 2));
    console.log('--- END RAW CHARACTER ELEMENT PAYLOAD ---');

    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: JSON.stringify(elementPayload),
    });

    const taskId = data.id;
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const pollData = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });
        if (pollData.status === 'completed' || pollData.status === 'succeed') {
            const elementId = extractElementId(pollData);
            if (!elementId) throw new Error('Element ID missing');
            return { elementId };
        }
        if (pollData.status === 'failed' || pollData.status === 'error' || pollData.status === 'canceled') {
            const errorMsg = pollData.error?.message || pollData.result_data?.error_message || pollData.result_data?.error || 'Unknown error';

            logger.error({ taskId, status: pollData.status, error: errorMsg }, 'Kling Element task failed');

            if (frontalImageUrl.includes('storage.googleapis.com')) {
                logger.warn('⚠️ PROBABLE CAUSE: Kling (Kuaishou) is a Chinese model and is often BLOCKED from downloading images from storage.googleapis.com. Consider using a CDN proxy or a different storage provider (R2, Cloudflare) for character portraits.');
            }

            throw new Error(`Element creation failed: ${errorMsg}`);
        }
    }
    throw new Error('Kling Custom Element creation timed out after 120s');
};
