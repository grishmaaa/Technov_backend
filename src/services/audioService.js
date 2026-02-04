
import axios from 'axios';
import { uploadFile } from './fileHostingService.js';
import { logger } from '../logger.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

// Configure Audio Providers
const SUNO_API_URL = process.env.SUNO_API_URL || 'https://api.suno.ai/v1'; // Placeholder URL
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

/**
 * Generate Background Music using Suno API
 * @param {string} prompt - Description of the music (e.g., "Cyberpunk synthwave, fast tempo")
 * @param {number} duration - Duration in seconds (optional, though Suno usually generates fixed lengths)
 * @returns {Promise<string>} - URL of the generated MP3
 */
export const generateMusic = async (prompt, duration = 30) => {
    try {
        const apiKey = process.env.SUNO_API_KEY;
        if (!apiKey) {
            logger.warn('SUNO_API_KEY missing - skipping music generation');
            return null;
        }

        logger.info({ prompt, duration }, 'Generating music via Suno...');

        // NOTE: This is a generic implementation. Actual Suno API endpoints may vary.
        // Adjust endpoint and payload based on specific Suno provider documentation.
        const response = await axios.post(`${SUNO_API_URL}/generate`, {
            prompt,
            model: 'chirp-v3-0',
            wait_audio: true
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        const audioUrl = response.data?.audio_url || response.data?.url;
        if (!audioUrl) {
            throw new Error('Suno response missing audio URL');
        }

        // Persistence: Download and re-upload to our storage
        const tempPath = path.join(os.tmpdir(), `suno-${Date.now()}.mp3`);
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        await fs.writeFile(tempPath, audioRes.data);

        const publicUrl = await uploadFile(tempPath, { objectKey: `audio/music-${Date.now()}.mp3` });
        await fs.rm(tempPath, { force: true }).catch(() => { });

        logger.info({ publicUrl }, 'Music generated and uploaded successfully');
        return publicUrl;

    } catch (error) {
        logger.error({ err: error.message }, 'Failed to generate music');
        return null; // Fail gracefully (video can exist without music)
    }
};

/**
 * Generate Voiceover using ElevenLabs API
 * @param {string} text - The dialogue to speak
 * @param {string} voiceId - ElevenLabs Voice ID
 * @returns {Promise<string>} - URL of the generated MP3
 */
export const generateVoiceover = async (text, voiceId = '21m00Tcm4TlvDq8ikWAM') => { // Default: Rachel
    try {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            logger.warn('ELEVENLABS_API_KEY missing - skipping voiceover');
            return null;
        }

        if (!text || text.trim().length === 0) return null;

        logger.info({ textLength: text.length, voiceId }, 'Generating voiceover via ElevenLabs...');

        const response = await axios.post(
            `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`,
            {
                text,
                model_id: "eleven_monolingual_v1",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            },
            {
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer'
            }
        );

        const tempPath = path.join(os.tmpdir(), `vo-${Date.now()}.mp3`);
        await fs.writeFile(tempPath, response.data);

        const publicUrl = await uploadFile(tempPath, { objectKey: `audio/vo-${Date.now()}.mp3` });
        await fs.rm(tempPath, { force: true }).catch(() => { });

        logger.info({ publicUrl }, 'Voiceover generated and uploaded successfully');
        return publicUrl;

    } catch (error) {
        logger.error({ err: error.message }, 'Failed to generate voiceover');
        return null;
    }
};
