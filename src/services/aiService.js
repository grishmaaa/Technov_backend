import OpenAI from 'openai';
import dotenv from 'dotenv';
import { logger } from '../logger.js';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

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
};
