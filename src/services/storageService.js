import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import path from 'path';

const getEnvValue = (keys) => {
    for (const key of keys) {
        const value = process.env[key];
        if (value) return value;
    }
    return undefined;
};

export const getStorageConfig = () => {
    const bucket = getEnvValue(['STORAGE_BUCKET', 'RAILWAY_BUCKET_NAME', 'S3_BUCKET']);
    const region = getEnvValue(['STORAGE_REGION', 'RAILWAY_BUCKET_REGION', 'S3_REGION', 'AWS_REGION']);
    const endpoint = getEnvValue(['STORAGE_ENDPOINT', 'RAILWAY_BUCKET_ENDPOINT', 'S3_ENDPOINT']);
    const accessKeyId = getEnvValue([
        'STORAGE_ACCESS_KEY_ID',
        'RAILWAY_BUCKET_ACCESS_KEY_ID',
        'AWS_ACCESS_KEY_ID'
    ]);
    const secretAccessKey = getEnvValue([
        'STORAGE_SECRET_ACCESS_KEY',
        'RAILWAY_BUCKET_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY'
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
    const { region, endpoint, accessKeyId, secretAccessKey } = getStorageConfig();
    const config = {
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: Boolean(endpoint)
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
    const { bucket, publicBaseUrl, region } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }
    const client = getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType || 'application/octet-stream',
        Body: createReadStream(filePath)
    });
    await client.send(command);

    const baseUrl = publicBaseUrl || `https://${bucket}.s3.${region}.amazonaws.com`;
    return `${baseUrl}/${key}`;
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

export const getPresignedDownloadUrl = async ({ key, expiresIn = 900 }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }
    const client = getS3Client();
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key
    });
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
