import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import prisma from './config/database.js';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

// Load environment variables first (needed for Sentry)
dotenv.config();

// Initialize Sentry (must be before other imports that might throw errors)
import { initSentry, Sentry } from './config/sentry.js';
initSentry();

// Import routes
import authRoutes from './routes/authRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import sceneRoutes from './routes/sceneRoutes.js';
import jobRoutes from './routes/jobRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import clipScoreRoutes from './routes/clipScoreRoutes.js';
import storageRoutes from './routes/storageRoutes.js';
import usageRoutes from './routes/usageRoutes.js';
import pipelineRoutes from './routes/pipelineRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';

// Import jobs
import { startCreditResetJob } from './jobs/creditResetJob.js';
import { startJanitorJob } from './jobs/janitorJob.js';

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';
import { httpLogger, logger } from './logger.js';
import { connection as redis } from './queue/connection.js';

const app = express();
const PORT = process.env.PORT || 8000;

// Trust Railway's proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'https://technov.ai',
            'https://www.technov.ai',
            'http://localhost:8080',
            'http://localhost:5173',
        ];

        if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
            allowedOrigins.push(process.env.FRONTEND_URL);
        }

        if (allowedOrigins.includes(origin) || origin.endsWith('.technov.ai') || origin.endsWith('.railway.app')) {
            callback(null, true);
        } else if (process.env.NODE_ENV !== 'production') {
            // Only allow unknown origins in development
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'Content-Type', 'Accept-Ranges']
}));

// Handle OPTIONS preflight requests
app.options('*', cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // increased for better UX during testing
    message: 'Too many requests from this IP, please try again later'
});
app.use('/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100 // increased for better UX during testing
}));
app.use(limiter);

// Logging middleware
app.use(httpLogger);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', async (req, res) => {
    const timestamp = new Date().toISOString();
    try {
        await prisma.$queryRaw`SELECT 1`;
        if (process.env.REDIS_URL) {
            await redis.ping();
        }
        res.json({
            status: 'ok',
            timestamp,
            environment: process.env.NODE_ENV
        });
    } catch (error) {
        logger.error({ err: error }, 'Health check failed');
        res.status(503).json({
            status: 'degraded',
            timestamp,
            environment: process.env.NODE_ENV,
            error: error.message
        });
    }
});

// TEMPORARY admin endpoint to add credits (NO AUTH - FOR TESTING ONLY)
app.post('/admin/add-credits', async (req, res) => {
    try {
        const { email, credits } = req.body;
        const user = await prisma.user.update({
            where: { email },
            data: { credits: { increment: credits } }
        });
        res.json({ success: true, newBalance: user.credits, email: user.email });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API routes
// API routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', sceneRoutes); // /api/projects/:id/scenes
app.use('/api', jobRoutes);   // /api/projects/:id/generate
app.use('/api/pipeline', pipelineRoutes); // /api/pipeline/projects/:id/*
app.use('/api/payments', paymentRoutes); // /api/payments/*
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api', clipScoreRoutes);
app.use('/api', storageRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/webhooks', webhookRoutes);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Sentry error handler (must be before other error handlers)
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server started');
    logger.info({ environment: process.env.NODE_ENV || 'development' }, 'Environment');
    logger.info({ corsOrigin: process.env.CORS_ORIGIN || '*' }, 'CORS origin');

    // Start cron jobs
    startCreditResetJob();
    startJanitorJob();
});

// --- SOCKET.IO SETUP ---
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: ['https://technov.ai', 'http://localhost:8080', 'http://localhost:5173', '*'],
        methods: ["GET", "POST"]
    }
});

// Store io instance globally or export if needed (for simple modules)
// For worker communication, we'll use Redis Pub/Sub if worker is separate
import { createClient } from 'redis';

if (process.env.REDIS_URL) {
    (async () => {
        try {
            const subscriber = createClient({ url: process.env.REDIS_URL });
            await subscriber.connect();

            // Subscribe to worker updates
            await subscriber.subscribe('job-updates', (message) => {
                try {
                    const data = JSON.parse(message);
                    const { userId, type, payload } = data;
                    if (userId && type) {
                        // Emit to specific user room
                        // io.to(userId).emit(type, payload);

                        // For simplicity during dev/test, just emit to all or check implementation of rooms
                        // Ideally: socket.join(userId) on connection
                        io.emit(`${type}:${userId}`, payload); // simpler fallback: client listens to their own event name
                        io.to(userId).emit(type, payload);

                        // Also notify client to refresh their credits/plan info globally
                        io.to(userId).emit('credits-updated', {});
                    }
                } catch (e) {
                    logger.warn({ err: e }, 'Failed to process socket update');
                }
            });
            logger.info('Subscribed to job-updates via Redis');
        } catch (e) {
            logger.error({ err: e }, 'Failed to setup Redis subscriber');
        }
    })();
}

io.on('connection', (socket) => {
    // console.log('Client connected:', socket.id);

    // Simple auth: client sends { userId } on join
    socket.on('join', (userId) => {
        if (userId) {
            socket.join(userId);
            // console.log(`Socket ${socket.id} joined room ${userId}`);
        }
    });
});

export default app;
