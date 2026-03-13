import prisma from '../config/database.js';
import { logger } from '../logger.js';
import { extractVideoUrl } from '../services/evolinkService.js';
import { isStorageConfigured, uploadBufferToStorage, buildObjectKey } from '../services/storageService.js';

/**
 * POST /api/webhooks/evolink
 * Handles async task completion notifications from EvoLink.
 */
export const handleEvolinkWebhook = async (req, res) => {
    const data = req.body;
    const taskId = data.task_id || data.id;
    const status = data.status;

    logger.info({ taskId, status }, 'Received EvoLink webhook notification');

    try {
        if (!taskId) {
            return res.status(400).json({ error: 'Missing task_id' });
        }

        // 1. Check if it's a scene generation task
        const scene = await prisma.scene.findFirst({
            where: { taskId: taskId }
        });

        if (scene) {
            const isFinished = ['completed', 'succeed', 'success'].includes(status?.toLowerCase());

            if (isFinished) {
                let videoUrl = extractVideoUrl(data);
                if (videoUrl) {
                    // CRITICAL: EvoLink links expire in 24h. Persist to permanent storage immediately.
                    if (isStorageConfigured()) {
                        try {
                            logger.info({ taskId, sceneId: scene.id }, 'Mirroring EvoLink video to permanent storage (Webhook)');
                            const videoRes = await fetch(videoUrl);
                            if (videoRes.ok) {
                                const buffer = Buffer.from(await videoRes.arrayBuffer());
                                const key = buildObjectKey({ userId: 'evolink-backups', extension: 'mp4' });
                                const persistedUrl = await uploadBufferToStorage({ buffer, key, contentType: 'video/mp4' });
                                videoUrl = persistedUrl;
                                logger.info({ taskId, persistedUrl }, 'Video mirrored successfully');
                            }
                        } catch (backupErr) {
                            logger.warn({ err: backupErr.message, taskId }, 'Failed to mirror video in webhook, falling back to temporary link');
                        }
                    }

                    await prisma.scene.update({
                        where: { id: scene.id },
                        data: {
                            videoUrl,
                            state: 'COMPLETED',
                            updatedAt: new Date()
                        }
                    });
                    logger.info({ sceneId: scene.id, taskId }, 'Scene video updated via webhook');
                } else {
                    logger.warn({ taskId, data }, 'EvoLink webhook reported completion but no video URL found');
                }
            } else if (status === 'failed' || status === 'error') {
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { state: 'FAILED' }
                });
                logger.error({ sceneId: scene.id, taskId, err: data.error }, 'Scene generation failed (webhook)');
            }

            return res.json({ success: true, type: 'scene' });
        }

        // 2. Check if it's a character element task
        const character = await prisma.character.findFirst({
            where: { elementId: taskId } // Some element creators might return the taskId as the future elementId
        });

        if (character) {
            // Logic for character element completion can go here if EvoLink uses webhooks for them too
            // However, our current logic for elements is synchronous-polling. 
            // We can add it later if we want to make elements async too.
            return res.json({ success: true, type: 'character_check' });
        }

        logger.warn({ taskId }, 'Webhook received for unknown taskId — likely already processed or tracking missing');
        res.json({ success: false, message: 'TaskId not matched to active resource' });

    } catch (error) {
        logger.error({ err: error.message, taskId }, 'Error processing EvoLink webhook');
        res.status(500).json({ error: 'Internal processing error' });
    }
};
