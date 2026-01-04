import express from 'express';
import { generateScriptController, createGenerationJob, getGenerationStatus } from '../controllers/jobController.js';
import { authMiddleware, requireCredits } from '../middleware/auth.js';
import { validateStoryInput } from '../middleware/shield.js';

const router = express.Router();

router.post('/generate-script',
    authMiddleware,
    validateStoryInput,  // <-- The Shield
    generateScriptController
);

// Protected routes
router.post('/projects/:id/generate', authMiddleware, createGenerationJob);
router.get('/projects/:id/status', authMiddleware, getGenerationStatus);

export default router;

