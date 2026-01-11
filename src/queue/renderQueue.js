import { Queue } from 'bullmq';
import { connection } from './connection.js';

export const renderQueue = new Queue('render', {
    connection,
    defaultJobOptions: {
        attempts: Number(process.env.WORKER_MAX_ATTEMPTS || 3),
        backoff: {
            type: 'exponential',
            delay: Number(process.env.WORKER_BACKOFF_DELAY_MS || 30000)
        },
        removeOnComplete: 1000,
        removeOnFail: 1000
    }
});

export const renderDlq = new Queue('render-dlq', { connection });
