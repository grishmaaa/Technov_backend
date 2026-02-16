import * as Sentry from '@sentry/node';
import { logger } from '../logger.js';

/**
 * Initialize Sentry for error tracking
 * Only initializes if SENTRY_DSN is provided
 */
export function initSentry() {
    if (!process.env.SENTRY_DSN) {
        logger.warn('SENTRY_DSN not set - error tracking disabled');
        return;
    }

    try {
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'development',

            // Performance Monitoring
            tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

            // Capture console.error messages
            integrations: [
                Sentry.captureConsoleIntegration({
                    levels: ['error']
                }),
            ],

            // Filter out sensitive information
            beforeSend(event) {
                // Remove sensitive headers
                if (event.request?.headers) {
                    delete event.request.headers.authorization;
                    delete event.request.headers.cookie;
                }
                return event;
            },
        });

        logger.info({ environment: process.env.NODE_ENV }, 'Sentry initialized');
    } catch (error) {
        logger.error({ error }, 'Failed to initialize Sentry');
    }
}

/**
 * Capture an exception in Sentry with additional context
 */
export function captureException(error, context = {}) {
    if (!process.env.SENTRY_DSN) {
        return; // Sentry not configured
    }

    Sentry.captureException(error, {
        extra: context,
    });
}

/**
 * Capture a message in Sentry
 */
export function captureMessage(message, level = 'info', context = {}) {
    if (!process.env.SENTRY_DSN) {
        return; // Sentry not configured
    }

    Sentry.captureMessage(message, {
        level,
        extra: context,
    });
}

export { Sentry };
