import express from 'express';
import {
    createScene,
    getScenes,
    updateScene,
    deleteScene
} from '../controllers/sceneController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/projects/:projectId/scenes', createScene);
router.get('/projects/:projectId/scenes', getScenes);
router.put('/scenes/:sceneId', updateScene);
router.delete('/scenes/:sceneId', deleteScene);

export default router;
