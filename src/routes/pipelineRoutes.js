/**
 * pipelineRoutes.js
 * 
 * Routes for the new 7-stage pipeline.
 * All routes require authentication.
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validateStoryInput as storyShield } from '../middleware/shield.js';
import {
    generateScript,
    editSceneEndpoint,
    approveScene,
    approveAllScenes,
    generateCharacters,
    regenerateCharacter,
    uploadCharacterPhoto,
    approveCharacter,
    approveAllCharacters,
    generateStoryboard,
    regenerateStoryboardFrame,
    approveStoryboard,
} from '../controllers/pipelineController.js';

const router = Router();

// All pipeline routes require authentication
router.use(authMiddleware);

// --- Stage 1: Script Generation ---
router.post('/projects/:id/generate-script', storyShield, generateScript);

// --- Stage 2: Scene Review & Editing ---
router.post('/projects/:id/scenes/:sceneId/edit', editSceneEndpoint);
router.post('/projects/:id/scenes/:sceneId/approve', approveScene);
router.post('/projects/:id/scenes/approve-all', approveAllScenes);

// --- Stage 3: Character Acceptance ---
router.post('/projects/:id/characters/generate', generateCharacters);
router.post('/projects/:id/characters/:charId/regenerate', regenerateCharacter);
router.post('/projects/:id/characters/:charId/upload', uploadCharacterPhoto);
router.post('/projects/:id/characters/:charId/approve', approveCharacter);
router.post('/projects/:id/characters/approve-all', approveAllCharacters);

// --- Stage 4: Storyboard ---
router.post('/projects/:id/storyboard/generate', generateStoryboard);
router.post('/projects/:id/storyboard/:sceneId/regenerate', regenerateStoryboardFrame);
router.post('/projects/:id/storyboard/approve-all', approveStoryboard);

export default router;
