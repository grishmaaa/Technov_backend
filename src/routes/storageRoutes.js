import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { buildObjectKey, getPresignedUploadUrl, isStorageConfigured } from '../services/storageService.js';
import { logger } from '../logger.js';

const router = express.Router();

router.post('/storage/presign', authMiddleware, async (req, res) => {
    try {
        if (!isStorageConfigured()) {
            return res.status(400).json({ error: 'Object storage not configured' });
        }

        const { extension = 'mp4', contentType = 'video/mp4', prefix } = req.body || {};
        const objectKey = buildObjectKey({
            userId: req.user.id,
            prefix: prefix || 'uploads',
            extension
        });

        const uploadUrl = await getPresignedUploadUrl({
            key: objectKey,
            contentType
        });

        res.json({
            uploadUrl,
            objectKey
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to create presigned upload URL');
        res.status(500).json({ error: 'Failed to create presigned upload URL' });
    }
});

export default router;
