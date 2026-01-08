import express from 'express';
import {
    createProject,
    getProjects,
    getProject,
    updateProject,
    deleteProject,
    generateScenesFromStory
} from '../controllers/projectController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/', createProject);
router.post('/generate-scenes', generateScenesFromStory);
router.get('/', getProjects);
router.get('/:id', getProject);
router.put('/:id', updateProject);
router.delete('/:id', deleteProject);

export default router;
