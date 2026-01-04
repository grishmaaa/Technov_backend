import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../config/database.js';

const router = express.Router();

// Mock Charge Endpoint (for Dev Mode)
router.post('/mock-charge', authMiddleware, async (req, res) => {
    try {
        const { amount, credits } = req.body;
        const userId = req.user.id;

        // In a real app, verify Stripe/Razorpay signature here.
        // For Mission 5 "The Hollywood Polish", we simulate the transaction.

        // Update User Credits
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                credits: { increment: credits }
            }
        });

        // Log the transaction (Optional, for tracking)
        console.log(`[Payment] User ${userId} bought ${credits} credits for $${amount}`);

        res.json({
            success: true,
            message: 'Payment simulated successfully',
            user: {
                id: updatedUser.id,
                credits: updatedUser.credits,
                plan: updatedUser.plan
            }
        });

    } catch (error) {
        console.error("Payment Error:", error);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

export default router;
