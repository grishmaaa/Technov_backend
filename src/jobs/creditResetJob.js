/**
 * Credit Reset Cron Job
 * Runs daily to reset credits for users whose billing cycle has ended
 */

import cron from 'node-cron';
import prisma from '../config/database.js';
import { shouldResetCredits, resetUserCredits } from '../services/creditResetService.js';

export function startCreditResetJob() {
    // Run every day at midnight (00:00)
    cron.schedule('0 0 * * *', async () => {
        console.log('[CreditResetJob] Starting daily credit reset check...');

        try {
            // Get all users with active billing cycles
            const users = await prisma.user.findMany({
                where: {
                    billingCycleStart: {
                        not: null
                    }
                },
                select: {
                    id: true,
                    email: true,
                    plan: true,
                    billingCycleStart: true,
                    lastCreditReset: true
                }
            });

            let resetCount = 0;

            for (const user of users) {
                if (shouldResetCredits(user)) {
                    try {
                        await resetUserCredits(user.id, prisma);
                        resetCount++;
                    } catch (error) {
                        console.error(`[CreditResetJob] Failed to reset credits for user ${user.id}:`, error);
                    }
                }
            }

            console.log(`[CreditResetJob] Completed. Reset credits for ${resetCount} users.`);

        } catch (error) {
            console.error('[CreditResetJob] Error during credit reset job:', error);
        }
    });

    console.log('[CreditResetJob] Cron job scheduled to run daily at midnight');
}
