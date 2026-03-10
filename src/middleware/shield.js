import { logger } from '../logger.js';

// NEUTRALIZES any attempt to inject commands or JSON into the story
function sanitizeStoryInput(story) {
    // 1. Remove common jailbreak/override phrases
    const forbiddenPhrases = /ignore all previous instructions|system override|jailbreak|act as|respond as/gi;
    let sanitized = story.replace(forbiddenPhrases, '[filtered]');

    // 2. Escape any special characters that could be interpreted as code or JSON
    sanitized = JSON.stringify(sanitized);

    // Return the clean, safe string (with the outer quotes from stringify removed)
    return sanitized.slice(1, -1);
}

export const validateStoryInput = (req, res, next) => {
    let { story } = req.body;

    // 1. Check for missing input
    if (!story || typeof story !== 'string') {
        return res.status(400).json({ error: 'Story content is required and must be text.' });
    }

    // 2. Token Budgeting: Character Cap (increased for Pro users)
    const MAX_CHARS = 25000;
    if (story.length > MAX_CHARS) {
        return res.status(413).json({
            error: `Story is too long. Limit: ${MAX_CHARS} characters. Current: ${story.length}`
        });
    }

    if (story.length < 1) {
        return res.status(400).json({ error: 'Story is too short. Please provide some content.' });
    }

    // 3. Apply the "Bouncer" to sanitize the story
    req.body.story = sanitizeStoryInput(story);
    logger.info({ originalLength: story.length, sanitizedLength: req.body.story.length }, 'Story sanitized');

    next();
};
