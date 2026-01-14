import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import tus from 'tus-js-client';
import { getContentTypeForPath, getObjectPrefix, isStorageConfigured, uploadFileToStorage } from './storageService.js';
import { logger } from '../logger.js';

const getMimeType = (filePath) => getContentTypeForPath(filePath);

const getFileSize = async (filePath) => {
    const stats = await fs.stat(filePath);
    return stats.size;
};

const getSupabaseErrorStatus = (error) => {
    if (error?.response?.status) return error.response.status;
    if (typeof error?.originalResponse?.getStatus === 'function') {
        return error.originalResponse.getStatus();
    }
    const message = String(error?.message || '');
    if (message.includes('response code: 413') || message.includes(' 413 ')) {
        return 413;
    }
    return undefined;
};

const getSupabaseErrorBody = (error) => {
    if (error?.response?.data) return error.response.data;
    if (typeof error?.originalResponse?.getBody === 'function') {
        return error.originalResponse.getBody();
    }
    return null;
};

const uploadToSupabase = async (filePath) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_BUCKET;

    if (!supabaseUrl || !supabaseKey || !bucket) {
        return null;
    }

    const prefix = (process.env.SUPABASE_OBJECT_PREFIX || 'generated').replace(/\/+$/g, '');
    const ext = path.extname(filePath);
    const objectKey = `${prefix}/${crypto.randomUUID()}${ext}`;
    const fileSize = await getFileSize(filePath);
    const maxBytes = Number(process.env.SUPABASE_MAX_BYTES || 50 * 1024 * 1024);
    if (Number.isFinite(maxBytes) && fileSize > maxBytes) {
        logger.warn({ filePath, fileSize, maxBytes }, 'Supabase upload skipped due to size limit');
        return null;
    }
    const resumableThreshold = Number(process.env.SUPABASE_RESUMABLE_THRESHOLD_BYTES || 50 * 1024 * 1024);
    const useResumable = Number.isFinite(resumableThreshold) && fileSize >= resumableThreshold;
    const fileBuffer = await fs.readFile(filePath);
    const contentType = getMimeType(filePath);

    try {
        if (useResumable) {
            await new Promise((resolve, reject) => {
                const upload = new tus.Upload(fileBuffer, {
                    endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
                    headers: {
                        Authorization: `Bearer ${supabaseKey}`,
                        apikey: supabaseKey,
                        'x-upsert': 'true'
                    },
                    metadata: {
                        bucketName: bucket,
                        objectName: objectKey,
                        contentType
                    },
                    retryDelays: [0, 1000, 3000, 5000],
                    onError: reject,
                    onSuccess: () => resolve()
                });
                upload.start();
            });
        } else {
            await axios.post(
                `${supabaseUrl}/storage/v1/object/${bucket}/${objectKey}`,
                fileBuffer,
                {
                    headers: {
                        Authorization: `Bearer ${supabaseKey}`,
                        apikey: supabaseKey,
                        'Content-Type': contentType
                    }
                }
            );
        }
    } catch (error) {
        const status = getSupabaseErrorStatus(error);
        const body = getSupabaseErrorBody(error);
        if (status === 413) {
            logger.warn('Supabase rejected upload with 413; falling back to secondary host');
            return null;
        }
        logger.error({ status, body: body || error.message }, 'Supabase upload failed');
        return null;
    }

    const ttlSeconds = Number(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || 0);
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
        const signedResponse = await axios.post(
            `${supabaseUrl}/storage/v1/object/sign/${bucket}/${objectKey}`,
            { expiresIn: ttlSeconds },
            {
                headers: {
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        const signedUrl = signedResponse?.data?.signedURL;
        if (signedUrl) {
            return `${supabaseUrl}${signedUrl}`;
        }
    }

    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectKey}`;
};

export const uploadFile = async (filePath, options = {}) => {
    if (isStorageConfigured()) {
        const prefix = getObjectPrefix();
        const ext = path.extname(filePath);
        const key = options.objectKey || `${prefix}/${crypto.randomUUID()}${ext}`;
        return uploadFileToStorage({
            filePath,
            key,
            contentType: getMimeType(filePath)
        });
    }

    const uploadToSupabaseFn = options.uploadToSupabase || uploadToSupabase;
    let supabaseUrl = null;
    try {
        supabaseUrl = await uploadToSupabaseFn(filePath);
    } catch (error) {
        logger.warn({ err: error }, 'Supabase upload errored; falling back to secondary host');
    }
    if (supabaseUrl) {
        return supabaseUrl;
    }

    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    const form = new FormData();
    const blob = new Blob([fileBuffer]);
    form.append('file', blob, fileName);

    const headers = {};
    if (process.env.FILE_IO_API_KEY) {
        headers.Authorization = `Bearer ${process.env.FILE_IO_API_KEY}`;
    }

    const response = await axios.post('https://file.io', form, { headers });
    const publicUrl = response?.data?.link || response?.data?.url;

    if (!publicUrl) {
        throw new Error('File upload failed: missing public URL');
    }

    return publicUrl;
};
