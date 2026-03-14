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
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            ],
        });
    } else {
        generativeModel = client.getGenerativeModel({
            model: apiModel,
            generationConfig,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            safetySettings: [
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
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
                const candidate = response?.candidates?.[0];
                const finishReason = candidate?.finishReason || 'UNKNOWN';

                if (finishReason === 'MAX_TOKENS') {
                    throw new Error(`AI response was too long for the current limit (MAX_TOKENS). Try a shorter prompt or simpler request.`);
                }

                throw new Error(`Gemini returned no content. Finish reason: ${finishReason}`);
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
 * Stage 0: Conversational script development.
 * @param {Array<{role: string, text: string}>} chatHistory - Previous messages
 * @param {object} options - Model config
 */
export const developScript = async (chatHistory, options = {}) => {
    const apiModel = options.model || 'gemini-2.5-flash';
    const { client, type } = getGenerativeClient();

    const systemPrompt = `You are an expert Hollywood screenwriter and mentor. Your goal is to help the user turn their idea into a production-ready script.

STAGE 0 BEAT COUNTING:
1. One beat = one 8-10s clip. Maximum 8 clips.
2. If the user wants a short, impactful "one scene" project, respect that. Do not expand it unnecessarily.

THE PROCESS:
1. If the user says "approved", "generate it", or "go ahead", you MUST stop chatting and trigger production.
2. If they are ready, output your final polished version of the script and end your message with: "PRODUCTION_TRIGGER"
3. Otherwise, maintain a mentoring tone and ask probing questions about characters and conflict.

If the user gives a punchy script and wants it as-is, do not add "fat". Directness is key.`;

    const generationConfig = {
        maxOutputTokens: 8192,
        temperature: 0.7,
        topP: 0.95,
    };

    let generativeModel;
    if (type === 'aistudio') {
        generativeModel = client.getGenerativeModel({
            model: apiModel,
            generationConfig,
            systemInstruction: systemPrompt,
        });
    } else {
        generativeModel = client.getGenerativeModel({
            model: apiModel,
            generationConfig,
            systemInstruction: { parts: [{ text: systemPrompt }] },
        });
    }

    // Map history to Gemini format (user/model)
    const contents = chatHistory.map(msg => ({
        role: msg.role === 'ai' ? 'model' : 'user',
        parts: [{ text: msg.text }]
    }));

    return await callWithRetry(async () => {
        try {
            const result = await generativeModel.generateContent({ contents });
            const response = result.response;

            if (!response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('Gemini returned no content during ideation.');
            }

            return {
                text: response.candidates[0].content.parts[0].text,
                usage: {
                    promptTokens: response.usageMetadata?.promptTokenCount || 0,
                    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
                    totalTokens: response.usageMetadata?.totalTokenCount || 0,
                }
            };
        } catch (err) {
            logger.error({ err, apiModel }, 'Gemini LLM call failed in developScript');
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

═══ THE CINEMATIC RULE ═══
Fictional conflict is NOT real-world harm. 
- ALWAYS ALLOW: Tragic backstories, revenge plots, mentions of characters "dying", "being killed", "burning kingdoms", or "destroying worlds". These are standard cinematic tropes.
- DO NOT BLOCK based on dramatic violence, horror elements, or dark themes.
- MARK AS SAFE: Any story element that would be found in a PG-13 or R-rated movie (Action, Thriller, Drama).

═══ THE ONLY BLOCKS ═══
1. Real-world instructions for illegal acts (e.g., "how to build a bomb").
2. Non-consensual sexual content or child exploitation.
3. Real-world hate speech targeting protected groups.

If it is a movie idea, it is SAFE. Severity must be 'SAFE' for all fictional drama.
Return a structured safety assessment.`;

    const { parsed } = await generateStructuredOutput(
        systemPrompt,
        `Review this story for safety:\n\n"${storyText}"`,
        schema,
        { model: options.model || 'gemini-2.5-flash', temperature: 0.1, maxTokens: 2048 },
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

    const systemPrompt = `You are a cinematic script editor in the tradition of Roger Deakins. You receive a scene from a larger script and a user edit instruction.

SACRED TEXT RULE: The user's original script details are sacred. Do NOT change, substitute, or "improve" any specific words, names, dialogue, or details that the user has NOT asked you to change. If the script says "THRESHOLD" — keep THRESHOLD. If it says "exact change for coffee he never ordered" — that detail stays.
You are editing the scene, not rewriting it. Preserve every unmentioned detail EXACTLY.

FOUR QUESTIONS (answer internally before editing):
1. What is the emotional truth of this scene that must be preserved?
2. What does the user's edit instruction actually want to FEEL different?
3. Which specific details carry emotional weight and must NOT be touched?
4. How does this edit affect the audience's experience, not just the visual?

Modify ONLY what the user asks. Keep duration, overall story arc, visual style, and all unmentioned details intact.
The edited prompt should describe what the audience FEELS, not just what the camera sees.`;

    const userPrompt = `Full Script Context:\n${fullScript}\n\nScene to Edit:\n${currentScenePrompt}\n\nUser's Edit Request:\n${editInstruction}\n\nReturn the edited scene. Preserve all details not mentioned in the edit request.`;

    const { parsed } = await generateStructuredOutput(
        systemPrompt,
        userPrompt,
        schema,
        { model: options.model || 'gemini-2.5-flash', temperature: 0.6, maxTokens: 4096 },
    );

    return {
        editedPrompt: parsed.edited_prompt,
        editedDescription: parsed.edited_description,
        changesMade: parsed.changes_made,
    };
};
