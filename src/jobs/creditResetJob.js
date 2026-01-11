/**
 * Credit Reset Cron Job
 * Runs daily to reset credits for users whose billing cycle has ended
 */

import cron from 'node-cron';
import prisma from '../config/database.js';
import { shouldResetCredits, resetUserCredits } from '../services/creditResetService.js';
import { logger } from '../logger.js';

export function startCreditResetJob() {
    // Run every day at midnight (00:00)
    cron.schedule('0 0 * * *', async () => {
        logger.info('Credit reset job started');

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
                        logger.error({ userId: user.id, err: error }, 'Credit reset failed for user');
                    }
                }
            }

            logger.info({ resetCount }, 'Credit reset job completed');

        } catch (error) {
            logger.error({ err: error }, 'Credit reset job error');
        }
    });

    logger.info('Credit reset cron scheduled');
}
