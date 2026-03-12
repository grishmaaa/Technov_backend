/**
 * googleImageService.js
 * 
 * Uses Google Vertex AI Imagen 3 (imagen-3.0-generate-002) for generating
 * character portraits and storyboard frames. Drops in natively where
 * falService was previously used.
 */

import { GoogleAuth } from 'google-auth-library';
import { logger } from '../logger.js';
import { isStorageConfigured, uploadBufferToStorage, buildObjectKey } from './storageService.js';
import fs from 'fs';
import path from 'path';

let authClient = null;

const getProjectId = () => {
    let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;

    // Fallback 1: parse it directly from the Service Account Key JSON
    if (!projectId && process.env.GCP_SA_KEY) {
        try {
            const saKey = JSON.parse(process.env.GCP_SA_KEY);
            projectId = saKey.project_id;
        } catch (e) {
            logger.warn('Could not parse GCP_SA_KEY for project_id');
        }
    }

    // Fallback 2: parse it from local vertex-key.json (used in local dev sometimes)
    if (!projectId) {
        try {
            const keyPath = path.resolve('./vertex-key.json');
            if (fs.existsSync(keyPath)) {
                const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
                projectId = keyData.project_id;
            }
        } catch (e) {
            // Ignore if missing or malformed
        }
    }
    return projectId ? projectId.trim() : null;
};

const getGoogleAuth = async () => {
    if (authClient) return authClient;

    const projectId = getProjectId();
    if (!projectId) {
        throw new Error('Could not determine Google Cloud Project ID from env or GCP_SA_KEY');
    }

    // Ensure the GoogleAuth library knows where to find the key if it's passed as a raw string
    const authOptions = {
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    };

    if (process.env.GCP_SA_KEY) {
        authOptions.credentials = JSON.parse(process.env.GCP_SA_KEY);
    } else {
        const keyPath = path.resolve('./vertex-key.json');
        if (fs.existsSync(keyPath)) {
            authOptions.keyFilename = keyPath;
        }
    }

    const auth = new GoogleAuth(authOptions);

    authClient = await auth.getClient();
    return authClient;
};

/**
 * Generate an image using Google Vertex AI Imagen 3
 */
export const generateImage = async (prompt, options = {}) => {
    const {
        aspectRatio = '16:9',
        outputFormat = 'image/png',
    } = options;

    logger.info({ aspectRatio, promptLength: prompt.length }, 'Generating image via Google Imagen 3');

    try {
        const client = await getGoogleAuth();
        const projectId = getProjectId();
        const location = process.env.GCP_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

        // Use standard Imagen 3 model
        const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-002:predict`;

        const requestBody = {
            instances: [
                {
                    prompt: prompt
                }
            ],
            parameters: {
                sampleCount: 1,
                aspectRatio: aspectRatio,
                outputOptions: {
                    mimeType: outputFormat
                }
            }
        };

        const res = await client.request({
            url: endpoint,
            method: 'POST',
            data: requestBody
        });

        const data = res.data;
        if (!data.predictions || data.predictions.length === 0) {
            throw new Error('Imagen returned no predictions');
        }

        // Imagen returns base64 encoded images byte strings
        const base64Image = data.predictions[0].bytesBase64Encoded;
        const mimeType = data.predictions[0].mimeType || outputFormat;

        logger.info({ mimeType }, 'Google Imagen 3 image generated successfully');

        // Always upload Vertex base64 blocks directly to S3 because our DB models
        // are expecting standard HTTPS URLs, not giant base64 strings in the database cells.
        if (isStorageConfigured()) {
            try {
                const buffer = Buffer.from(base64Image, 'base64');
                const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
                const key = buildObjectKey({ userId: 'imagen-images', extension: ext });
                const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType: mimeType });

                logger.info({ persistedUrl }, 'Imagen image persisted to storage');
                return { url: persistedUrl, contentType: mimeType };
            } catch (persistErr) {
                logger.error({ err: persistErr }, 'Failed to persist Imagen image');
                // We MUST upload to S3, returning data URI will break the Prisma character/scene db limits
                throw new Error('Failed to upload generated image to storage backend');
            }
        } else {
            logger.warn('Storage is NOT configured. Dropping back to returning raw base64 data URIs. This may exceed DB storage sizes.');
            return { url: `data:${mimeType};base64,${base64Image}`, contentType: mimeType };
        }

    } catch (error) {
        logger.error({ err: error.response?.data || error.message, promptLength: prompt.length }, 'Google Imagen 3 generation failed');
        throw new Error(`Imagen generation failed: ${error.message}`);
    }
};

/**
 * Generate a character portrait (1:1 forced aspect ratio).
 */
export const generateCharacterPortrait = async (description, style, options = {}, userPrompt = null) => {
    let prompt;
    if (userPrompt) {
        prompt = `Character Design Update: ${userPrompt}. Base Description: ${description}. Style: ${style}. Front facing, consistent character portrait sheet, neutral expression, 8k resolution, cinematic lighting, simple clean background.`;
    } else {
        prompt = `Character Reference Portrait: ${description}. Visual Style: ${style}. Front facing, detailed facial features, neutral expression, simple clean background, 8k resolution, cinematic lighting.`;
    }

    return generateImage(prompt, {
        aspectRatio: '1:1',
        outputFormat: 'image/png',
    });
};

/**
 * Generate a storyboard frame for a scene.
 */
export const generateStoryboardFrame = async (sceneDescription, style, options = {}, aspectRatio = '16:9') => {
    const prompt = `A single cinematic movie still: ${sceneDescription}. Visual Style: ${style}. Single unified scene, no grid, no panels, detailed composition, cinematic lighting and color grading, high detail, photorealistic.`;

    return generateImage(prompt, {
        aspectRatio,
        outputFormat: 'image/png',
    });
};
