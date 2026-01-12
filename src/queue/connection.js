import IORedis from 'ioredis';
import { logger } from '../logger.js';

export const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

connection.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
});

connection.on('connect', () => {
    logger.info('Redis connected');
});
