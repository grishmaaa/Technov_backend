/**
 * llmService.js
 * 
 * Unified LLM interface — Gemini only.
 * All script generation, safety checks, and scene edits go through this service.
 * Models: gemini-3.1-flash-lite (Starter/edits), gemini-3.1-pro (Pro/Studio)
 * 
 * Uses Google Cloud Vertex AI — reuses existing GCP_SA_KEY authentication.
 * No OpenAI or Anthropic dependencies.
 */

import { VertexAI } from '@google-cloud/vertexai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../logger.js';
import path from 'path';
import fs from 'fs';

// --- Authentication ---

let vertexClient = null;
let googleGenAIClient = null;
let useAIStudio = false;

const getGenerativeClient = () => {
    // 1. Check for Vertex AI (GCP) credentials FIRST — this uses $300 free trial credits
    if (!vertexClient) {
        let projectId = null;

        // 1. Try to get project ID from the Service Account Key first (most reliable)
        if (process.env.GCP_SA_KEY) {
            try {
                const saKey = JSON.parse(process.env.GCP_SA_KEY);
                projectId = saKey.project_id;
            } catch (e) {
                logger.warn('Could not parse GCP_SA_KEY for project_id');
            }
        }

        // 2. Fallback to direct environment variables
        if (!projectId) {
            projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
        }

        // 3. Fallback to local key file
        if (!projectId) {
            try {
                const keyPath = path.resolve('./vertex-key.json');
                if (fs.existsSync(keyPath)) {
                    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
                    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
                    projectId = keyData.project_id;
                }
            } catch (e) {
                logger.warn('Could not load vertex-key.json');
            }
        }

        if (projectId) {
            const location = process.env.GCP_LOCATION || 'us-central1';
            vertexClient = new VertexAI({ project: projectId, location });
            logger.info({ projectId, location }, 'Vertex AI client initialized for LLM');
        }
    }

    // Return Vertex AI if available
    if (vertexClient) return { client: vertexClient, type: 'vertex' };

    // 2. Fallback to Google AI Studio (GEMINI_API_KEY)
    if (process.env.GEMINI_API_KEY) {
        if (!googleGenAIClient) {
            googleGenAIClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const maskedKey = process.env.GEMINI_API_KEY.substring(0, 6) + '...';
            logger.info({ maskedKey }, 'Initialized Google Generative AI with GEMINI_API_KEY (AI Studio fallback)');
        }
        return { client: googleGenAIClient, type: 'aistudio' };
    }

    throw new Error('Neither GCP_SA_KEY/GCP_PROJECT_ID nor GEMINI_API_KEY provided — needed for Gemini LLM');
};

// --- Retry Logic ---

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const callWithRetry = async (fn, maxRetries = 3, baseDelay = 1000) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isRetryable = error.message?.includes('429')
                || error.message?.includes('503')
                || error.message?.includes('RESOURCE_EXHAUSTED')
                || error.message?.includes('Internal error');

            if (attempt === maxRetries || !isRetryable) {
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            logger.warn({ attempt, delay, error: error.message }, 'LLM call failed, retrying');
            await sleep(delay);
        }
    }
};

// --- Core LLM Functions ---

/**
 * Generate structured output using Gemini.
 * @param {string} systemPrompt - System instruction
 * @param {string} userPrompt - User message
 * @param {object} [schema] - JSON schema for structured output (optional)
 * @param {object} options - Model config from tier
 * @param {string} options.model - Gemini model name
 * @param {number} [options.temperature] - Temperature (0-2)
 * @param {number} [options.maxTokens] - Max output tokens
 * @returns {Promise<{text: string, parsed?: object, usage: object}>}
 */
export const generateStructuredOutput = async (systemPrompt, userPrompt, schema = null, options = {}) => {
    const {
        temperature = 0.7,
        maxTokens = 8192,
    } = options;

    // Use the model name directly from tier config
    const apiModel = options.model || 'gemini-2.5-flash';

    const { client, type } = getGenerativeClient();

    const generationConfig = {
        maxOutputTokens: maxTokens,
        temperature,
        topP: 0.95,
    };

    if (schema) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = schema;
    }

    let generativeModel;
    if (type === 'aistudio') {
        generativeModel = client.getGenerativeModel({
            model: apiModel,
            generationConfig,
            systemInstruction: systemPrompt,
            safetySettings: [
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            ],
        });
    } else {
        generativeModel = client.getGenerativeModel({
            model: apiModel,
            generationConfig,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            safetySettings: [
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            ],
        });
    }

    return await callWithRetry(async () => {
        try {
            const result = await generativeModel.generateContent({
                contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            });

            const response = result.response;

            if (!response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const blockReason = response?.candidates?.[0]?.finishReason;
                throw new Error(`Gemini returned no content. Finish reason: ${blockReason || 'unknown'}`);
            }

            const text = response.candidates[0].content.parts[0].text;
            const usage = {
                promptTokens: response.usageMetadata?.promptTokenCount || 0,
                completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
                totalTokens: response.usageMetadata?.totalTokenCount || 0,
            };

            let parsed = null;
            if (schema) {
                try {
                    parsed = JSON.parse(text);
                } catch (parseErr) {
                    logger.warn({ apiModel, textLength: text.length }, 'Failed to parse structured output as JSON');
                    // Try to extract JSON from markdown code blocks
                    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                    if (jsonMatch) {
                        try {
                            parsed = JSON.parse(jsonMatch[1]);
                        } catch (e) {
                            throw new Error(`Failed to parse Gemini structured output: ${parseErr.message}`);
                        }
                    }
                }
            }

            logger.info({ apiModel, usage, hasSchema: !!schema }, 'Gemini LLM call completed');

            return { text, parsed, usage };
        } catch (err) {
            logger.error({ err, apiModel, promptSnippet: userPrompt.substring(0, 100) }, 'Gemini LLM call failed in llmService');
            throw err;
        }
    });
};

/**
 * Run a safety check on story text.
 * @param {string} storyText - User's story input
 * @param {object} options - Model config from tier
 * @returns {Promise<{safe: boolean, severity: string, violations: string[], suggestedAlternative: string|null}>}
 */
export const safetyCheck = async (storyText, options = {}) => {
    const schema = {
        type: 'OBJECT',
        properties: {
            safe: { type: 'BOOLEAN' },
            violations: { type: 'ARRAY', items: { type: 'STRING' } },
            severity: { type: 'STRING', enum: ['SAFE', 'WARNING', 'BLOCK'] },
            suggested_alternative: { type: 'STRING', nullable: true },
        },
        required: ['safe', 'violations', 'severity', 'suggested_alternative'],
    };

    const systemPrompt = `You are a content safety reviewer for a cinematic video generation platform. 
Analyze the following story for policy violations. 
Flag: explicit sexual content, graphic violence, hate speech, illegal activities, child exploitation.
Allow: dramatic tension, cinematic conflict, action sequences, dark themes handled tastefully.
Return a structured safety assessment.`;

    const { parsed } = await generateStructuredOutput(
        systemPrompt,
        `Review this story for safety:\n\n"${storyText}"`,
        schema,
        { model: options.model || 'gemini-2.5-flash', temperature: 0.1, maxTokens: 512 },
    );

    return parsed || { safe: true, severity: 'SAFE', violations: [], suggested_alternative: null };
};

/**
 * Edit a single scene via AI.
 * @param {string} currentScenePrompt - The current scene text
 * @param {string} editInstruction - User's edit request (e.g., "@scene 3 make it more dramatic")
 * @param {string} fullScript - Full script context for coherence
 * @param {object} options - Model config from tier
 * @returns {Promise<{editedPrompt: string, editedDescription: string}>}
 */
export const editScene = async (currentScenePrompt, editInstruction, fullScript, options = {}) => {
    const schema = {
        type: 'OBJECT',
        properties: {
            edited_prompt: { type: 'STRING' },
            edited_description: { type: 'STRING' },
            changes_made: { type: 'STRING' },
        },
        required: ['edited_prompt', 'edited_description', 'changes_made'],
    };

    const systemPrompt = `You are a cinematic script editor. You receive a scene from a larger script and a user edit instruction. 
Modify ONLY the specified scene, keeping it consistent with the rest of the script.
Maintain the same duration, overall story arc, and visual style.
The edited prompt should be optimized for AI video generation (clear, visual, action-oriented).`;

    const userPrompt = `Full Script Context:\n${fullScript}\n\nScene to Edit:\n${currentScenePrompt}\n\nUser's Edit Request:\n${editInstruction}\n\nReturn the edited scene.`;

    const { parsed } = await generateStructuredOutput(
        systemPrompt,
        userPrompt,
        schema,
        { model: options.model || 'gemini-2.5-flash', temperature: 0.6, maxTokens: 2048 },
    );

    return {
        editedPrompt: parsed.edited_prompt,
        editedDescription: parsed.edited_description,
        changesMade: parsed.changes_made,
    };
};
