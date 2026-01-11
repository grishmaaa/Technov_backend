import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../config/database.js';
import { getDefaultCreditsForPlan } from '../services/creditResetService.js';
import { logger } from '../logger.js';

const router = express.Router();

// Mock Payment Provider (Simulating Stripe/Razorpay)
// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
    try {
        const { planId } = req.body;
        const userId = req.user.id;

        // In a real app, this would call Stripe.checkout.sessions.create()
        // Here, we just return a fake session ID and a success URL

        logger.info({ userId, planId }, 'Creating mock payment session');

        // Return a mock session
        res.json({
            id: `sess_mock_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            url: `/dashboard/subscription?success=true&plan=${planId}`
            // The frontend will redirect here, triggering the "Success" toast
        });

    } catch (error) {
        logger.error({ err: error }, 'Mock payment session failed');
        res.status(500).json({ error: "Failed to create checkout session" });
    }
});

// Mock Webhook / Verification (Called by Frontend on success for this demo)
// POST /api/payments/verify
router.post('/verify', authMiddleware, async (req, res) => {
    try {
        const { planId } = req.body;
        const userId = req.user.id;

        // Get default credits for the plan
        const defaultCredits = getDefaultCreditsForPlan(planId);
        const now = new Date();

        logger.info({ userId, planId, defaultCredits }, 'Mock payment verification');

        // Update User: Set plan, reset credits to default, and initialize billing cycle
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                credits: defaultCredits,
                plan: planId,
                billingCycleStart: now,
                lastCreditReset: now
            }
        });

        res.json({
            success: true,
            newCredits: updatedUser.credits,
            plan: updatedUser.plan
        });

    } catch (error) {
        logger.error({ err: error }, 'Mock payment verification failed');
        res.status(500).json({ error: "Failed to verify payment" });
    }
});

export default router;
