import jwt from 'jsonwebtoken';
import prisma from '../config/database.js';
import { shouldResetCredits, resetUserCredits } from '../services/creditResetService.js';
import { logger } from '../logger.js';

export const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
        return res.status(401).json({ error: 'Invalid or expired token' });
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
