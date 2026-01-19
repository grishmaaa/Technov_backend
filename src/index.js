import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import prisma from './config/database.js';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

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

// Import jobs
import { startCreditResetJob } from './jobs/creditResetJob.js';
import { startJanitorJob } from './jobs/janitorJob.js';

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';
import { httpLogger, logger } from './logger.js';
import { connection as redis } from './queue/connection.js';

// Load environment variables
dotenv.config();

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

        // Allow all origins during launch - can restrict later
        // Allowed: technov.ai, localhost, railway.app
        const allowedOrigins = ['https://technov.ai', 'http://localhost:8080', 'http://localhost:5173'];
        if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.technov.ai') || origin.endsWith('.railway.app')) {
            callback(null, true);
        } else {
            // During launch, allow everything
            callback(null, true);
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
app.use('/api/payments', paymentRoutes); // /api/payments/*
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api', clipScoreRoutes);
app.use('/api', storageRoutes);
app.use('/api/usage', usageRoutes);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});


// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server started');
    logger.info({ environment: process.env.NODE_ENV || 'development' }, 'Environment');
    logger.info({ corsOrigin: process.env.CORS_ORIGIN || '*' }, 'CORS origin');

    // Start cron jobs
    startCreditResetJob();
    startJanitorJob();
});

export default app;
