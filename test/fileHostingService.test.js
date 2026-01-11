import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { uploadFile } from '../src/services/fileHostingService.js';

const createTempFile = async () => {
    const tmpPath = path.join(os.tmpdir(), `upload-test-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    await fs.writeFile(tmpPath, 'hello');
    return tmpPath;
};

test('uploadFile falls back to secondary host when supabase upload throws', async () => {
    const previousBucket = process.env.STORAGE_BUCKET;
    const previousRegion = process.env.STORAGE_REGION;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_REGION;
    const tmpPath = await createTempFile();
    const originalPost = axios.post;
    let postCalls = 0;

    axios.post = async () => {
        postCalls += 1;
        return { data: { link: 'https://file.io/mock' } };
    };

    try {
        const url = await uploadFile(tmpPath, {
            uploadToSupabase: async () => {
                throw new Error('supabase down');
            }
        });
        assert.equal(url, 'https://file.io/mock');
        assert.equal(postCalls, 1);
    } finally {
        axios.post = originalPost;
        if (previousBucket !== undefined) process.env.STORAGE_BUCKET = previousBucket;
        if (previousRegion !== undefined) process.env.STORAGE_REGION = previousRegion;
        await fs.rm(tmpPath, { force: true });
    }
});

test('uploadFile returns supabase url when available', async () => {
    const previousBucket = process.env.STORAGE_BUCKET;
    const previousRegion = process.env.STORAGE_REGION;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_REGION;
    const tmpPath = await createTempFile();
    const originalPost = axios.post;
    let postCalls = 0;

    axios.post = async () => {
        postCalls += 1;
        return { data: { link: 'https://file.io/should-not-use' } };
    };

    try {
        const url = await uploadFile(tmpPath, {
            uploadToSupabase: async () => 'https://supabase.local/public/video.mp4'
        });
        assert.equal(url, 'https://supabase.local/public/video.mp4');
        assert.equal(postCalls, 0);
    } finally {
        axios.post = originalPost;
        if (previousBucket !== undefined) process.env.STORAGE_BUCKET = previousBucket;
        if (previousRegion !== undefined) process.env.STORAGE_REGION = previousRegion;
        await fs.rm(tmpPath, { force: true });
    }
});
