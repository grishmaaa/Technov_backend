import prisma from '../config/database.js';
import { logger } from '../logger.js';

export const getAllUsers = async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                email: true,
                role: true,
                plan: true,
                credits: true,
                createdAt: true
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
};

export const updateUserCredits = async (req, res) => {
    try {
        const { userId } = req.params;
        const { credits } = req.body;

        if (typeof credits !== 'number') {
            return res.status(400).json({ error: 'Credits must be a number' });
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: { credits },
            select: {
                id: true,
                email: true,
                role: true,
                plan: true,
                credits: true
            }
        });

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update credits' });
    }
};

export const updateUserPlan = async (req, res) => {
    try {
        const { userId } = req.params;
        const { plan } = req.body;

        if (!['basic', 'elite'].includes(plan)) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: { plan },
            select: {
                id: true,
                email: true,
                role: true,
                plan: true,
                credits: true
            }
        });

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update plan' });
    }
};

// Unified endpoint to update both plan and credits
export const updateUser = async (req, res) => {
    try {
        const { userId } = req.params;
        const { plan, credits } = req.body;

        // Validate inputs
        const updateData = {};

        if (plan !== undefined) {
            if (!['basic', 'elite'].includes(plan)) {
                return res.status(400).json({ error: 'Invalid plan. Must be "basic" or "elite"' });
            }
            updateData.plan = plan;
        }

        if (credits !== undefined) {
            if (typeof credits !== 'number' || credits < 0) {
                return res.status(400).json({ error: 'Credits must be a non-negative number' });
            }
            updateData.credits = credits;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        // Get current user to calculate credit difference
        const currentUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { credits: true, email: true }
        });

        if (!currentUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                email: true,
                role: true,
                plan: true,
                credits: true,
                createdAt: true
            }
        });

        // Record credit change in audit trail if credits were updated
        if (credits !== undefined && credits !== currentUser.credits) {
            const creditDiff = credits - currentUser.credits;
            await prisma.creditUsage.create({
                data: {
                    userId,
                    amount: Math.abs(creditDiff),
                    type: creditDiff > 0 ? 'ADMIN_ADD' : 'ADMIN_DEDUCT',
                    description: `Admin ${req.user.email} ${creditDiff > 0 ? 'added' : 'deducted'} ${Math.abs(creditDiff)} credits`
                }
            });
            logger.info({ adminId: req.user.id, targetUserId: userId, creditDiff }, 'Admin credit adjustment');
        }

        res.json(user);
    } catch (error) {
        logger.error({ err: error }, 'Failed to update user');
        if (error.code === 'P2025') {
            return res.status(404).json({ error: 'User not found' });
        }
        res.status(500).json({ error: 'Failed to update user' });
    }
};
