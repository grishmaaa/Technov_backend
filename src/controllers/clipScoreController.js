import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const runFfprobe = (args) => new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    ffprobe.stdout.on('data', (data) => { output += data.toString(); });
    ffprobe.stderr.on('data', (data) => { errorOutput += data.toString(); });
    ffprobe.on('error', reject);
    ffprobe.on('close', (code) => {
        if (code === 0) {
            resolve(output);
        } else {
            reject(new Error(`ffprobe exited with code ${code}: ${errorOutput}`));
        }
    });
});

const getDurationSeconds = async (filePath) => {
    try {
        const output = await runFfprobe([
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'json',
            filePath
        ]);
        const parsed = JSON.parse(output);
        const duration = Number(parsed?.format?.duration);
        return Number.isFinite(duration) ? duration : null;
    } catch {
        return null;
    }
};

export const clipScoreController = async (req, res) => {
    try {
        const apiKey = process.env.CLIP_SCORE_API_KEY;
        const providedKey = req.header('x-clip-key');
        if (apiKey && apiKey !== providedKey) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const mode = (process.env.CLIP_SCORE_MODE || 'basic').toLowerCase();
        if (mode !== 'basic') {
            return res.status(501).json({ error: 'CLIP scoring not configured' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Missing file' });
        }

        const tmpPath = path.join(os.tmpdir(), `clip-score-${Date.now()}.mp4`);
        await fs.writeFile(tmpPath, req.file.buffer);

        const duration = await getDurationSeconds(tmpPath);
        const stats = await fs.stat(tmpPath);
        await fs.rm(tmpPath, { force: true });

        const sizeScore = Math.min(1, Math.log10(Math.max(stats.size, 1)) / 8);
        const durationScore = duration
            ? Math.max(0, 1 - Math.min(1, Math.abs(duration - 4) / 4))
            : 0.5;
        const clipScore = 0.5;
        const motionScore = durationScore;
        const artifactScore = sizeScore;
        const totalScore = Number((clipScore * 0.6 + motionScore * 0.2 + artifactScore * 0.2).toFixed(4));

        res.json({ clipScore, motionScore, artifactScore, totalScore });
    } catch (error) {
        res.status(500).json({ error: 'Failed to score clip', details: error.message });
    }
};
