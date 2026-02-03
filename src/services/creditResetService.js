/**
 * Credit Reset Service
 * Handles automatic credit resets based on 30-day billing cycles
 */
import { logger } from '../logger.js';

const BILLING_CYCLE_DAYS = 30;

// Default credits per plan
const PLAN_CREDITS = {
    basic: 100,
    pro: 150,
    elite: 500
};

/**
 * Check if user's credits need to be reset
 */
export function shouldResetCredits(user) {
    if (!user.billingCycleStart) {
        return false; // No billing cycle started yet
    }

    const now = new Date();
    const cycleStart = new Date(user.billingCycleStart);
    const daysSinceCycleStart = Math.floor((now - cycleStart) / (1000 * 60 * 60 * 24));

    return daysSinceCycleStart >= BILLING_CYCLE_DAYS;
}


/**
 * Reset user credits to plan defaults
 */
export async function resetUserCredits(userId, prisma) {
    const user = await prisma.user.findUnique({
        where: { id: userId }
    });

    if (!user) {
        throw new Error('User not found');
    }

    const defaultCredits = getDefaultCreditsForPlan(user.plan);
    const now = new Date();

    await prisma.user.update({
        where: { id: userId },
        data: {
            credits: defaultCredits,
            billingCycleStart: now,
            lastCreditReset: now
        }
    });

    logger.info({ userId, email: user.email, credits: defaultCredits }, 'Credits reset');

    return {
        userId,
        newCredits: defaultCredits,
        resetDate: now
    };
}

/**
 * Get default credit amount for a plan
 */
export function getDefaultCreditsForPlan(plan) {
    return PLAN_CREDITS[plan] || PLAN_CREDITS.basic;
}

/**
 * Initialize billing cycle for new subscription
 */
export async function initializeBillingCycle(userId, prisma) {
    const now = new Date();

    await prisma.user.update({
        where: { id: userId },
        data: {
            billingCycleStart: now,
            lastCreditReset: now
        }
    });

    logger.info({ userId }, 'Billing cycle initialized');
}
