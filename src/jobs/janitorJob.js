/**
 * Janitor Job - Finds and releases stuck jobs
 * 
 * Jobs can get stuck in PROCESSING state if the worker crashes.
 * This janitor runs every 5 minutes to find jobs that have been
 * processing for too long and resets them to QUEUED for retry.
 */

import prisma from '../config/database.js';
import { logger } from '../logger.js';
import cron from 'node-cron';
import { renderQueue } from '../queue/renderQueue.js';

const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes - if job runs longer, it's stuck

async function releaseStaleJobs() {
    const staleThreshold = new Date(Date.now() - LOCK_TTL_MS);

    try {
        // Find jobs stuck in PROCESSING for too long
        const staleJobs = await prisma.generationJob.findMany({
            where: {
                status: 'PROCESSING',
                updatedAt: { lt: staleThreshold }
            },
            include: {
                project: { select: { id: true, title: true } }
            }
        });

        if (staleJobs.length === 0) {
            logger.info('[Janitor] No stale jobs found.');
            return 0;
        }

        logger.warn(`[Janitor] Found ${staleJobs.length} stale jobs, re-queuing...`);

        for (const job of staleJobs) {
            try {
                // Reset job status to QUEUED
                await prisma.generationJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'QUEUED',
                        errorMessage: `Auto-recovered by Janitor at ${new Date().toISOString()}`
                    }
                });

                // Re-add to BullMQ queue
                await renderQueue.add('render', { jobId: job.id }, {
                    jobId: `retry-${job.id}-${Date.now()}`
                });

                logger.info({ jobId: job.id, projectTitle: job.project?.title }, '[Janitor] Job re-queued for retry');
            } catch (jobError) {
                logger.error({ jobId: job.id, err: jobError }, '[Janitor] Failed to re-queue job');
            }
        }

        return staleJobs.length;
    } catch (error) {
        logger.error({ err: error }, '[Janitor] Error finding stale jobs');
        return 0;
    }
}

export function startJanitorJob() {
    // Run every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        logger.info('[Janitor] Running stale job check...');
        const count = await releaseStaleJobs();
        if (count > 0) {
            logger.warn(`[Janitor] Released ${count} stale jobs.`);
        }
    });

    logger.info('[Janitor] Stale job janitor scheduled to run every 5 minutes.');
}
