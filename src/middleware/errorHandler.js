import { logger } from '../logger.js';
import { captureException } from '../config/sentry.js';

export const errorHandler = (err, req, res, next) => {
    logger.error({ err }, 'Request error');

    // Capture error in Sentry
    captureException(err, {
        url: req.url,
        method: req.method,
        user: req.user?.id,
    });

    if (err.name === 'PrismaClientKnownRequestError') {
        return res.status(400).json({
            error: 'Database error',
            details: process.env.NODE_ENV === 'development' ? err.message : 'A database error occurred'
        });
    }

    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
    }

    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
