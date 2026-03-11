//storageservice.js
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
    // Railway storage uses various env var names - check all possibilities
    const bucket = getEnvValue([
        'BUCKET',
        'STORAGE_BUCKET',
        'S3_BUCKET',
        'RAILWAY_BUCKET_NAME',
        'BUCKET_NAME'
    ]);
    const region = getEnvValue(['STORAGE_REGION', 'RAILWAY_BUCKET_REGION', 'S3_REGION', 'AWS_REGION', 'REGION']);
    const endpoint = getEnvValue([
        'STORAGE_ENDPOINT',
        'RAILWAY_BUCKET_ENDPOINT',
        'S3_ENDPOINT',
        'ENDPOINT',
        'RAILWAY_STORAGE_ENDPOINT'
    ]);
    const accessKeyId = getEnvValue([
        'STORAGE_ACCESS_KEY_ID',
        'RAILWAY_BUCKET_ACCESS_KEY_ID',
        'AWS_ACCESS_KEY_ID',
        'ACCESS_KEY_ID',
        'RAILWAY_STORAGE_ACCESS_KEY_ID'
    ]);
    const secretAccessKey = getEnvValue([
        'STORAGE_SECRET_ACCESS_KEY',
        'RAILWAY_BUCKET_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'SECRET_ACCESS_KEY',
        'RAILWAY_STORAGE_SECRET_ACCESS_KEY'
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

    // Debug log on first call to help diagnose issues
    console.log('[StorageConfig] bucket:', bucket, 'endpoint:', endpoint, 'hasAccessKey:', !!accessKeyId);

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

export const getS3Client = () => {
    let { region, endpoint, accessKeyId, secretAccessKey } = getStorageConfig();

    // Railway uses 'auto' region - default to 'us-east-1' for S3 SDK compatibility
    if (!region || region === 'auto') {
        region = 'us-east-1';
    }

    console.log('[S3Client] Using endpoint:', endpoint, 'region:', region);

    const config = {
        region,
        endpoint: endpoint || undefined,
        // Railway dashboard explicitly states: "Use virtual-hosted-style URLs."
        forcePathStyle: false
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

export const getPublicUrl = (key) => {
    const { bucket, endpoint, publicBaseUrl } = getStorageConfig();
    if (publicBaseUrl) {
        return `${publicBaseUrl.replace(/\/+$/, '')}/${key}`;
    }
    if (endpoint) {
        const cleanEndpoint = endpoint.replace(/\/+$/, '');

        // Extract protocol
        let protocol = 'https://';
        let host = cleanEndpoint;
        if (cleanEndpoint.startsWith('http://')) {
            protocol = 'http://';
            host = cleanEndpoint.replace('http://', '');
        } else if (cleanEndpoint.startsWith('https://')) {
            protocol = 'https://';
            host = cleanEndpoint.replace('https://', '');
        }

        // Railway dashboard explicitly states: "Use virtual-hosted-style URLs."
        // Format: https://bucket-name.endpoint-domain.dev/key
        return `${protocol}${bucket}.${host}/${key}`;
    }
    return `https://${bucket}.storage.railway.app/${key}`;
};

export const uploadFileToStorage = async ({ filePath, key, contentType }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }

    // Read file fully into memory to avoid S3 stream reset errors
    const fileBuffer = await fs.readFile(filePath);

    const client = getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: 'video/mp4', // FORCE BROWSER TO SEE VIDEO
        ContentDisposition: 'inline', // TELL BROWSER TO PLAY IT
        ACL: 'public-read', // Ensure public access for worker download
    });

    await client.send(command);

    return getPublicUrl(key);
};

export const uploadDirectoryToStorage = async ({ dirPath, prefix }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) throw new Error('Storage bucket is not configured');

    const client = getS3Client();
    const files = await fs.readdir(dirPath);
    let masterUrl = '';

    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileContent = await fs.readFile(filePath);
        const key = `${prefix}/${file}`;

        let contentType = 'application/octet-stream';
        if (file.endsWith('.m3u8')) contentType = 'application/vnd.apple.mpegurl';
        else if (file.endsWith('.ts')) contentType = 'video/mp2t';

        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileContent,
            ContentType: contentType,
            ACL: 'public-read'
        }));

        if (file.endsWith('.m3u8')) {
            masterUrl = getPublicUrl(key);
        }
    }

    return masterUrl;
};

export const uploadBufferToStorage = async ({ buffer, key, contentType }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }

    const client = getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        ContentDisposition: 'inline',
        // ACL: 'public-read', // Removed to prevent failures on buckets with ACLs disabled
    });

    await client.send(command);

    return getPublicUrl(key);
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

export const extractKeyFromUrl = (url) => {
    if (!url) return null;
    try {
        const urlObj = new URL(url);
        // Extracts path after first slash, e.g. /generated/file.png -> generated/file.png
        let path = urlObj.pathname;
        if (path.startsWith('/')) path = path.substring(1);
        return path;
    } catch (e) {
        // If it's already a key, return it
        return url;
    }
};

export const getPresignedDownloadUrl = async ({ key, expiresIn = 3600, download = false, contentType = null }) => {
    const { bucket } = getStorageConfig();
    if (!bucket) {
        throw new Error('Storage bucket is not configured');
    }
    const client = getS3Client();

    // Guess content type if not provided
    let responseContentType = contentType;
    if (!responseContentType) {
        const ext = path.extname(key).toLowerCase();
        if (ext === '.m3u8') responseContentType = 'application/vnd.apple.mpegurl';
        else if (ext === '.ts') responseContentType = 'video/mp2t';
        else if (ext === '.mp4') responseContentType = 'video/mp4';
        else if (ext === '.png') responseContentType = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') responseContentType = 'image/jpeg';
        else if (ext === '.webp') responseContentType = 'image/webp';
    }

    const commandParams = {
        Bucket: bucket,
        Key: key,
        ResponseCacheControl: 'max-age=3600',
    };

    if (responseContentType) {
        commandParams.ResponseContentType = responseContentType;
    }

    if (download) {
        const ext = path.extname(key) || '.mp4';
        commandParams.ResponseContentDisposition = `attachment; filename="technov-asset-${Date.now()}${ext}"`;
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
