import jwt from 'jsonwebtoken';
import prisma from '../config/database.js';
import { shouldResetCredits, resetUserCredits } from '../services/creditResetService.js';
import { logger } from '../logger.js';

export const authMiddleware = async (req, res, next) => {
    try {
        // Accept token from Authorization header OR query string (?token=...)
        // Query string is needed for video streaming since browsers can't send headers with <video> tags
        const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

        console.log("[Auth] Token source:", req.headers.authorization ? "Header" : (req.query.token ? "Query" : "None"));
        console.log("[Auth] Token present:", !!token);

        if (!token) {
            console.warn("[Auth] No token provided in headers or query");
            return res.status(401).json({ error: 'No token provided' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (jwtErr) {
            console.warn("[Auth] Token verification failed:", jwtErr.message);
            return res.status(401).json({ error: 'Invalid or expired token', details: jwtErr.message });
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                email: true,
                role: true,
                plan: true,
                credits: true,
                billingCycleStart: true,
                lastCreditReset: true
            }
        });

        if (!user) {
            console.warn("[Auth] User not found for ID:", decoded.userId);
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Check if credits need reset (30-day cycle check)
        if (shouldResetCredits(user)) {
            logger.info({ userId: user.id }, 'Credits need reset');
            await resetUserCredits(user.id, prisma);

            // Refresh user data after reset
            const updatedUser = await prisma.user.findUnique({
                where: { id: user.id },
                select: { id: true, email: true, role: true, plan: true, credits: true }
            });
            req.user = updatedUser;
        } else {
            req.user = user;
        }

        next();
    } catch (error) {
        console.error("[Auth] Unexpected middleware error:", error);
        return res.status(500).json({ error: 'Internal server error during auth' });
    }
};

export const requireRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
};

export const requirePlan = (plans) => {
    return (req, res, next) => {
        if (!plans.includes(req.user.plan)) {
            return res.status(403).json({ error: 'Upgrade plan required' });
        }
        next();
    };
};

export const requireCredits = (amount) => {
    return (req, res, next) => {
        if (req.user.credits < amount) {
            return res.status(402).json({ error: 'Insufficient credits' });
        }
        next();
    };
};
