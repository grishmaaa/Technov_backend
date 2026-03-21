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

// Global lock to enforce 5s gap between completion of one call and start of next
let lastCallPromise = Promise.resolve();
const ENFORCE_GAP_MS = 5000;

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
    
    // Safety check for GCS - Kling (Kuaishou) is in China and BLOCKED from GCS
    if (!url.includes('storage.googleapis.com')) return url;
    
    const cdnUrl = process.env.GCS_CDN_URL;
    if (!cdnUrl) return url;
    
    try {
        const cdnHost = new URL(cdnUrl).hostname;
        if (url.includes(cdnHost)) return url;
        
        // Improved Regex: Extracts everything after the bucket name in a storage.googleapis.com URL
        // Format: https://storage.googleapis.com/[BUCKET]/[PATH]
        const gcsMatch = url.match(/storage\.googleapis\.com\/([^\/]+)\/(.+)$/);
        if (gcsMatch) {
            const path = gcsMatch[2];
            const base = cdnUrl.replace(/\/+$/, '');
            return `${base}/${path}`;
        }
    } catch (e) {
        // Fallback or log if cdnUrl is invalid
    }
    
    return url;
};

/**
 * Robust URL extraction: ensures we always get a CDN string whether input is
 * a raw string, an object with .url, .image_url, or .image
 */
const safeUrl = (u) => {
    if (!u) return '';
    if (typeof u === 'string') return ensureCdnUrl(u);
    if (typeof u === 'object') {
        const raw = u.url || u.image_url || u.image || '';
        return ensureCdnUrl(raw);
    }
    return '';
};

const evolinkFetch = async (endpoint, options = {}) => {
    // ENHANCED SERIAL QUEUE: Wait for previous to FINISH + 5s
    const result = await (lastCallPromise = (async () => {
        try {
            await lastCallPromise;
        } catch (e) {
            // Ignore previous errors in the chain
        }
        
        // Wait the mandatory gap
        await sleep(ENFORCE_GAP_MS);

        const url = `${EVOLINK_BASE_URL}${endpoint}`;
        const bodyString = options.body && typeof options.body === 'object' 
            ? JSON.stringify(options.body) 
            : options.body;

        console.log('--- START EVOLINK RAW REQUEST ---');
        console.log('URL:', url);
        console.log('METHOD:', options.method || 'GET');
        console.log('BODY:', bodyString);
        console.log('--- END EVOLINK RAW REQUEST ---');

        const response = await fetch(url, {
            ...options,
            body: bodyString,
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
    })());
    
    return result;
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
    return data.result_data?.elements?.[0]?.element_id
        || data.result_data?.element_id
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
        sound: 'on'
    };

    if (process.env.APP_URL) {
        videoPayload.callback_url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/evolink`;
    }

    // KLING V3 USES image_start NOT image_url
    if (imageUrl) {
        const proxiedUrl = safeUrl(imageUrl);
        if (finalModel.includes('kling-v3')) {
            videoPayload.image_start = proxiedUrl;
        } else {
            videoPayload.image_url = proxiedUrl;
        }
    }

    if (elementList && elementList.length > 0) videoPayload.element_list = elementList;
    if (referenceImages && referenceImages.length > 0) {
        videoPayload.reference_images = referenceImages.map(r => {
            // Bulletproof: handles both strings (as url) and objects with .url
            return {
                ...(typeof r === 'object' ? r : {}),
                url: safeUrl(r)
            };
        }).filter(item => item.url);
    }

    logger.info({ model: videoPayload.model, type: 'VIDEO_GENERATION' }, '📡 Submitting Video Task to EvoLink');
    
    return evolinkFetch('/videos/generations', {
        method: 'POST',
        body: videoPayload
    });
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
    const response = await submitVideoGeneration(prompt, options);
    // Safely extract the ID regardless of API response structure
    const taskId = response.task_id || response.id || response.data?.task_id || response.data?.id;
    
    const { videoUrl } = await pollVideoTask(taskId, { intervalMs: 5000, maxAttempts: 100 });
    return { video_url: videoUrl, status: 'completed' };
};

/**
 * Create custom element
 */
export const createCharacterElement = async (name, description, frontalImageUrl, referImages = []) => {
    logger.info({ name }, 'Executing STRICT Character Element Generation');

    // Advanced Sanitization: removes story words, cleans double commas/spaces
    const scrub = (text) => (text || '')
        .replace(/\b(the unseen driver of|the driver of|the sports car|pursuer|mysterious|aggressive|relentless|unseen|motorcycle|helmet|racer|bikes|riding|wearing a|in a|with a|races|suit|jacket|coat|scarf|mask|visor|action|running|pedaling|driver of a|matte black sports car|girl on a bicycle|the girl|the biker|rider|matte black|driver|driver of|sports car)\b[^,.]*/gi, '')
        .replace(/\b(the|a|an|of|in|with|and|is|was|were|on)\b/gi, ' ')
        .replace(/,\s*,/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/[\s,\.]+$/g, '')
        .trim();

    const cleanDesc = scrub(description);
    const finalDescription = (cleanDesc.length > 3)
        ? `A detailed human portrait showing ${cleanDesc}`
        : "A clear human portrait, standard facial features, centered facial structure.";

    const safeName = (name || 'Character').replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
    const safeDescription = finalDescription.substring(0, 100);

    const elementPayload = {
        model: 'kling-custom-element',
        model_params: {
            element_name: safeName,
            element_description: safeDescription,
            reference_type: 'image_refer',
            element_image_list: {
                frontal_image: safeUrl(frontalImageUrl),
            }
        },
        // standard_model_name: 'kling-custom-element'
    };

    if (referImages && referImages.length > 0) {
        elementPayload.model_params.element_image_list.refer_images = referImages.map(img => {
            const url = safeUrl(img);
            return url ? { image_url: url } : null;
        }).filter(Boolean);
    }

    // if (process.env.APP_URL) {
    //     elementPayload.callback_url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/evolink`;
    // }

    logger.info({ charName: safeName }, '🚀 Submitting Element Task to EvoLink');
    
    // As per documentation, custom elements use /videos/generations
    const data = await evolinkFetch('/videos/generations', {
        method: 'POST',
        body: elementPayload,
    });

    const taskId = data.task_id || data.id || data.data?.task_id || data.data?.id;
    if (!taskId) {
        throw new Error(`Failed to get taskId for element creation. Response: ${JSON.stringify(data)}`);
    }

    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const pollData = await evolinkFetch(`/tasks/${taskId}`, { method: 'GET' });
        if (pollData.status === 'completed' || pollData.status === 'succeed') {
            const elementId = extractElementId(pollData);
            if (!elementId) throw new Error('Element ID missing from successful poll data');
            return elementId;
        }
        if (pollData.status === 'failed' || pollData.status === 'error' || pollData.status === 'canceled') {
            const errorMsg = pollData.error?.message || pollData.result_data?.error_message || pollData.result_data?.error || 'Unknown error';
            throw new Error(`Element creation failed during polling: ${errorMsg}`);
        }
    }
    throw new Error('Kling Custom Element creation timed out after 120s');
};

