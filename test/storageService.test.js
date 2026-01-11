import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectKey, getPresignedUploadUrl, isStorageConfigured } from '../src/services/storageService.js';

const withEnv = (vars, fn) => {
    const previous = {};
    for (const [key, value] of Object.entries(vars)) {
        previous[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
};

test('buildObjectKey uses user prefix and extension', () => {
    const key = buildObjectKey({ userId: 'user-123', prefix: 'uploads', extension: 'mp4' });
    assert.ok(key.startsWith('uploads/user-123/'));
    assert.ok(key.endsWith('.mp4'));
});

test('getPresignedUploadUrl returns a signed URL when configured', async () => {
    await withEnv({
        STORAGE_BUCKET: 'test-bucket',
        STORAGE_REGION: 'us-east-1',
        STORAGE_ACCESS_KEY_ID: 'test',
        STORAGE_SECRET_ACCESS_KEY: 'test'
    }, async () => {
        assert.equal(isStorageConfigured(), true);
        const url = await getPresignedUploadUrl({ key: 'uploads/user-1/test.mp4' });
        assert.ok(typeof url === 'string');
        assert.ok(url.includes('X-Amz-Signature='));
    });
});
