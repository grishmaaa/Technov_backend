import { logger } from '../logger.js';

export const validateStoryInput = (req, res, next) => {
    const { story } = req.body;

    // 1. Check for missing input
    if (!story || typeof story !== 'string') {
        return res.status(400).json({ error: 'Story content is required and must be text.' });
    }

    // 2. Token Budgeting: Character Cap
    const MAX_CHARS = 2000;
    if (story.length > MAX_CHARS) {
        return res.status(400).json({
            error: `Story is too long. Please limit to ${MAX_CHARS} characters to prevent excessive generation costs. Current length: ${story.length}`
        });
    }

    if (story.length < 10) {
        return res.status(400).json({ error: 'Story is too short. Please provide at least 10 characters.' });
    }

    // 3. Simple Content Filtering (The "Shield")
    const forbiddenPatterns = [
        /ignore all previous instructions/i,
        /system override/i,
        /jailbreak/i
    ];

    for (const pattern of forbiddenPatterns) {
        if (pattern.test(story)) {
            logger.warn({ pattern: String(pattern) }, 'Blocked malicious input');
            return res.status(400).json({ error: 'Input blocked by safety filters.' });
        }
    }

    next();
};
