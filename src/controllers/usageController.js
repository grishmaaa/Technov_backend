import prisma from '../config/database.js';

// Get credit usage history for current user
export const getUsageHistory = async (req, res) => {
    try {
        const history = await prisma.creditUsage.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' },
            take: 50 // Show last 50 transactions
        });

        // Map it to match frontend expectations
        const formattedHistory = history.map(item => ({
            id: item.id,
            date: item.createdAt.toISOString(),
            project: item.description || 'Unknown',
            credits: item.amount,
            type: item.type,
            createdAt: item.createdAt
        }));

        res.json(formattedHistory);
    } catch (error) {
        console.error('[UsageHistory] Error:', error);
        res.status(500).json({ error: "Failed to fetch usage history" });
    }
};

// Get credit summary for current user
export const getCreditSummary = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                credits: true,
                plan: true,
                billingCycleStart: true,
                lastCreditReset: true
            }
        });

        // Calculate usage this billing cycle
        const cycleStart = user.lastCreditReset || user.billingCycleStart || new Date(0);
        const usageThisCycle = await prisma.creditUsage.aggregate({
            where: {
                userId: req.user.id,
                createdAt: { gte: cycleStart },
                amount: { gt: 0 } // Only count debits, not refunds/adds
            },
            _sum: { amount: true }
        });

        res.json({
            currentCredits: user.credits,
            plan: user.plan,
            usedThisCycle: usageThisCycle._sum.amount || 0,
            cycleStartDate: cycleStart
        });
    } catch (error) {
        console.error('[CreditSummary] Error:', error);
        res.status(500).json({ error: "Failed to fetch credit summary" });
    }
};

// Helper function to record credit usage (used by other controllers)
export const recordCreditUsage = async ({ userId, amount, type, description, projectId = null }) => {
    return await prisma.creditUsage.create({
        data: {
            userId,
            amount,
            type,
            description,
            projectId
        }
    });
};
