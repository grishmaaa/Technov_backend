import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseStaleJobs } from '../src/workers/jobLockService.js';

test('releaseStaleJobs skips when ttl is disabled', async () => {
    const prisma = {
        generationJob: {
            updateMany: async () => {
                throw new Error('should not be called');
            }
        }
    };

    const released = await releaseStaleJobs({ prisma, lockTtlMs: 0 });
    assert.equal(released, 0);
});

test('releaseStaleJobs unlocks stale jobs and decrements attempts', async () => {
    const calls = [];
    const prisma = {
        generationJob: {
            updateMany: async (args) => {
                calls.push(args);
                return { count: 1 };
            }
        }
    };

    const now = new Date('2024-01-01T00:00:00.000Z');
    const released = await releaseStaleJobs({ prisma, lockTtlMs: 60000, now });

    assert.equal(released, 2);
    assert.equal(calls.length, 2);

    const expectedThreshold = new Date(now.getTime() - 60000);
    const firstCall = calls[0];
    const secondCall = calls[1];

    assert.equal(firstCall.where.status, 'PROCESSING');
    assert.equal(firstCall.where.lockedAt.lt.getTime(), expectedThreshold.getTime());
    assert.equal(firstCall.data.status, 'QUEUED');
    assert.equal(firstCall.data.attemptCount.decrement, 1);

    assert.equal(secondCall.where.status, 'PROCESSING');
    assert.equal(secondCall.where.lockedAt.lt.getTime(), expectedThreshold.getTime());
    assert.equal(secondCall.data.status, 'QUEUED');
    assert.equal(secondCall.data.attemptCount, undefined);
});
