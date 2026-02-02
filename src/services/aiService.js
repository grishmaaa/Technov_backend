import OpenAI from 'openai';
import dotenv from 'dotenv';
import { logger } from '../logger.js';

dotenv.config();

// Lazy-load OpenAI client - only initialize when actually needed
let _openaiInstance = null;
const getOpenAI = () => {
    if (!_openaiInstance) {
        if (!process.env.OPENAI_API_KEY) {
            logger.warn('OPENAI_API_KEY not set - AI features will be disabled');
            throw new Error('OpenAI API key not configured');
        }
        _openaiInstance = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }
    return _openaiInstance;
};

const cleanMarkdown = (text) => text.replace(/```json/g, '').replace(/```/g, '').trim();

export const generateScriptAndImagePrompt = async (story, visualStyle) => {
    if (!story) {
        throw new Error('Story is required');
    }

    const systemPrompt = `
You are a Multi-Modal Production Orchestrator.

Goal:
Generate two outputs for a short video concept based on the user's story and visual style.

Output requirements (STRICT):
- Return ONLY valid JSON (no markdown, no comments, no extra text).
- Top-level JSON object must include:
  - "imagePrompt": a highly detailed DALL-E 3 prompt for a hero image.
  - "scenes": an array of scene objects.
- Each scene object must include:
  - "description": a clear, concrete visual description.
  - "shotType": a cinematic shot type.
  - "duration": an integer in seconds.

Guidance:
- Make the imagePrompt cinematic and specific (lighting, mood, composition, lens, style).
- Make scenes sequential and visually distinct.
- Keep descriptions focused on what is visible on screen.
`.trim();

    const userPrompt = `
Story:
"${story}"

Visual Style:
"${visualStyle || 'cinematic realism'}"
`.trim();

    const openai = getOpenAI();

    // Retry logic for rate limiting (429)
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7
            });

            const rawText = completion.choices?.[0]?.message?.content || '';
            const cleanedText = cleanMarkdown(rawText);
            let parsed;

            try {
                parsed = JSON.parse(cleanedText);
            } catch (error) {
                logger.error({ err: error }, 'Failed to parse AI JSON response');
                throw new Error('Failed to parse AI response');
            }

            const { imagePrompt, scenes } = parsed || {};

            if (!imagePrompt || !Array.isArray(scenes)) {
                throw new Error('Invalid AI response format');
            }

            return { imagePrompt, scenes };
        } catch (error) {
            lastError = error;
            const status = error?.status || error?.response?.status;

            if (status === 429 && attempt < maxRetries) {
                const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                logger.warn({ attempt, waitTime }, 'OpenAI rate limited, retrying...');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            throw error;
        }
    }

    throw lastError;
};

export const generateTitle = async (story) => {
    if (!story) return null;

    const prompt = `
    Generate a short, creative, and catchy title (3-6 words) for a video based on this story:
    "${story}"
    
    Return ONLY the title. No quotes, no "Title:", just the text.
    `;

    const openai = getOpenAI();

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Cheaper, faster
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
            max_tokens: 20
        });

        const title = completion.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
        return title || null;
    } catch (error) {
        logger.warn({ err: error }, 'Failed to generate AI title');
        return null; // Non-blocking failure
    }
};
