import express from 'express';
import {
    createProject,
    getProjects,
    getProject,
    getProjectFactory,
    updateProject,
    deleteProject,
    generateScenesFromStory,
    startSceneReview,
    approveScenes,
    decideVisualIdentity,
    generateProjectAssets,
    getPublicProject
} from '../controllers/projectController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// --- PUBLIC ROUTES (No Auth Required) ---
// These must be BEFORE router.use(authMiddleware)
router.get('/:id/public', getPublicProject);

// --- PROTECTED ROUTES (Auth Required) ---
router.use(authMiddleware);

router.post('/', createProject);
router.post('/generate-scenes', generateScenesFromStory);
router.post('/:id/review/start', startSceneReview);
router.post('/:id/review/approve', approveScenes);
router.post('/:id/visual-identity/decide', decideVisualIdentity);
router.post('/:id/hero-assets/generate', generateProjectAssets);
router.get('/', getProjects);
router.get('/:id/factory', getProjectFactory);

router.get('/:id', getProject);
router.put('/:id', updateProject);
router.delete('/:id', deleteProject);

export default router;

