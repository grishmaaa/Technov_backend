import pino from 'pino';
import pinoHttp from 'pino-http';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: null
});

export const httpLogger = pinoHttp({
    logger
});
