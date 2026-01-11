import { Worker } from 'bullmq';
import { connection } from './queue/connection.js';
import { renderDlq } from './queue/renderQueue.js';
import { processGenerationJob } from './workers/renderWorker.js';
import { logger } from './logger.js';

const MAX_CONCURRENT_JOBS = Number(process.env.WORKER_MAX_CONCURRENT_JOBS || 5);
const LOCK_DURATION_MS = Number(process.env.WORKER_LOCK_DURATION_MS || 15 * 60 * 1000);
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;

const worker = new Worker(
    'render',
    async (job) => {
        logger.info({ jobId: job.data.jobId }, 'Render job started');
        await processGenerationJob(job.data.jobId, {
            workerId: WORKER_ID,
            attempt: job.attemptsMade + 1
        });
    },
    {
        connection,
        concurrency: MAX_CONCURRENT_JOBS,
        lockDuration: LOCK_DURATION_MS
    }
);

worker.on('completed', (job) => {
    logger.info({ jobId: job.data.jobId }, 'Render job completed');
});

worker.on('failed', async (job, error) => {
    logger.error({ jobId: job?.data?.jobId, err: error }, 'Render job failed');
    if (job) {
        await renderDlq.add('render-failed', {
            jobId: job.data.jobId,
            reason: error?.message || 'unknown'
        });
    }
});

const shutdown = async () => {
    logger.info('Worker shutting down');
    await worker.close();
    await renderDlq.close();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info({ concurrency: MAX_CONCURRENT_JOBS }, 'Render worker online');
