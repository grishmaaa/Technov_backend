import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getContentTypeForPath, getObjectPrefix, isStorageConfigured, uploadFileToStorage } from './storageService.js';
import { logger } from '../logger.js';

const getMimeType = (filePath) => getContentTypeForPath(filePath);

const getFileSize = async (filePath) => {
    const stats = await fs.stat(filePath);
    return stats.size;
};

export const uploadFile = async (filePath, options = {}) => {
    // 1. Primary Storage (Railway S3 / AWS S3)
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

    // 2. Fallback Storage (file.io) when running locally without S3 configured
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

    // Extract URL and validate it's a string, not a function
    let publicUrl = response?.data?.link || response?.data?.url;

    // Log the response for debugging
    logger.info({
        responseData: response?.data,
        linkType: typeof publicUrl,
        linkValue: String(publicUrl).substring(0, 100)
    }, 'File.io upload response');

    // Convert to string if it's a function (defensive)
    if (typeof publicUrl === 'function') {
        logger.warn('file.io returned a function instead of URL, attempting to call it');
        publicUrl = publicUrl();
    }

    publicUrl = String(publicUrl || '');

    if (!publicUrl || publicUrl === 'undefined' || publicUrl.includes('function')) {
        throw new Error(`File upload failed: invalid public URL: ${publicUrl}`);
    }

    return publicUrl;
};
