import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const getEnvValue = (keys) => {
    for (const key of keys) {
        const value = process.env[key];
        if (value) return value;
    }
    return undefined;
};

export const getStorageConfig = () => {
    // BUCKET contains the actual S3 API bucket name, check it first
    // Ignore RAILWAY_BUCKET_NAME as it is often just a UI display name
    const bucket = getEnvValue(['BUCKET', 'STORAGE_BUCKET', 'S3_BUCKET']);
    const region = getEnvValue(['STORAGE_REGION', 'RAILWAY_BUCKET_REGION', 'S3_REGION', 'AWS_REGION', 'REGION']);
    const endpoint = getEnvValue(['STORAGE_ENDPOINT', 'RAILWAY_BUCKET_ENDPOINT', 'S3_ENDPOINT', 'ENDPOINT']);
    const accessKeyId = getEnvValue([
        'STORAGE_ACCESS_KEY_ID',
        'RAILWAY_BUCKET_ACCESS_KEY_ID',
        'AWS_ACCESS_KEY_ID',
        'ACCESS_KEY_ID'
    ]);
    const secretAccessKey = getEnvValue([
        'STORAGE_SECRET_ACCESS_KEY',
        'RAILWAY_BUCKET_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'SECRET_ACCESS_KEY'
    ]);
    const publicBaseUrl = getEnvValue([
        'STORAGE_PUBLIC_BASE_URL',
        'RAILWAY_BUCKET_PUBLIC_BASE_URL',
        'S3_PUBLIC_BASE_URL'
    ]);
    const objectPrefix = (getEnvValue([
        'STORAGE_OBJECT_PREFIX',
        'RAILWAY_BUCKET_OBJECT_PREFIX',
        'S3_OBJECT_PREFIX'
    ]) || 'generated').replace(/\/+$/g, '');

    return {
        bucket,
        region,
        endpoint,
        accessKeyId,
        secretAccessKey,
        publicBaseUrl,
        objectPrefix
    };
};

const getS3Client = () => {
    let { region, endpoint, accessKeyId, secretAccessKey } = getStorageConfig();

    // Railway uses 'auto' region - default to 'us-east-1' for S3 SDK compatibility
    if (!region || region === 'auto') {
        region = 'us-east-1';
    }

    console.log('[S3Client] Using endpoint:', endpoint, 'region:', region);

    const config = {
        region,
        endpoint: endpoint || undefined,
        // Railway S3 buckets prefer path-style access
        forcePathStyle: true
    };
    if (accessKeyId && secretAccessKey) {
        config.credentials = { accessKeyId, secretAccessKey };
    }
    return new S3Client(config);
};

export const isStorageConfigured = () => {
    const { bucket, region, endpoint, accessKeyId, secretAccessKey } = getStorageConfig();
    const configured = Boolean(bucket && region);

    // Log storage config status on first check
    if (!isStorageConfigured._logged) {
        console.log('[StorageConfig] bucket:', bucket ? 'SET' : 'MISSING');
        console.log('[StorageConfig] region:', region ? 'SET' : 'MISSING');
        console.log('[StorageConfig] endpoint:', endpoint ? 'SET' : 'MISSING');
        console.log('[StorageConfig] accessKeyId:', accessKeyId ? 'SET' : 'MISSING');
        console.log('[StorageConfig] secretAccessKey:', secretAccessKey ? 'SET' : 'MISSING');
        console.log('[StorageConfig] configured:', configured);
        isStorageConfigured._logged = true;
    }

    return configured;
};

export const buildObjectKey = ({ userId, prefix = 'generated', extension = '' }) => {
    const safePrefix = prefix.replace(/\/+$/g, '');
    const ext = extension.startsWith('.') ? extension : extension ? `.${extension}` : '';
    return `${safePrefix}/${userId}/${crypto.randomUUID()}${ext}`;
};

export const getObjectPrefix = () => {
    return getStorageConfig().objectPrefix;
};

export const uploadFileToStorage = async ({ filePath, key, contentType }) => {
    const { bucket, endpoint, publicBaseUrl } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }

    // Read file as buffer to avoid streaming errors
    const fileBuffer = await fs.readFile(filePath);

    const client = getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        // FORCE video/mp4 - without this Railway defaults to octet-stream which browsers can't play
        ContentType: 'video/mp4',
        // Tell browser to play inline, not download
        ContentDisposition: 'inline',
        Body: fileBuffer
    });
    await client.send(command);

    // FIX: Build correct Railway URL structure
    // Correct format: https://bucket-id.storage.railway.app/key
    if (publicBaseUrl) {
        return `${publicBaseUrl}/${key}`;
    }

    // Railway endpoint is https://storage.railway.app
    // We need https://bucket-id.storage.railway.app/key
    if (endpoint && endpoint.includes('railway.app')) {
        const cleanEndpoint = endpoint.replace('https://', '');
        return `https://${bucket}.${cleanEndpoint}/${key}`;
    }

    // Fallback for standard S3
    return `https://${bucket}.s3.amazonaws.com/${key}`;
};

export const getPresignedUploadUrl = async ({ key, contentType, expiresIn = 900 }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }
    const client = getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType || 'application/octet-stream'
    });
    return getSignedUrl(client, command, { expiresIn });
};

export const getPresignedDownloadUrl = async ({ key, expiresIn = 3600, download = false }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }
    const client = getS3Client();

    // Build command params - force browser to see it as video/mp4
    const commandParams = {
        Bucket: bucket,
        Key: key,
        // FORCE the browser to see it as a video for the player
        ResponseContentType: 'video/mp4',
    };

    // If the user clicked "Download", force the browser to save the file
    if (download) {
        commandParams.ResponseContentDisposition = `attachment; filename="technov-film-${Date.now()}.mp4"`;
    }

    const command = new GetObjectCommand(commandParams);
    return getSignedUrl(client, command, { expiresIn });
};

export const getContentTypeForPath = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.mp4':
            return 'video/mp4';
        case '.mov':
            return 'video/quicktime';
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.webp':
            return 'image/webp';
        default:
            return 'application/octet-stream';
    }
};
