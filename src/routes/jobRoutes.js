import express from 'express';
import {
    createGenerationJob,
    getGenerationStatus
} from '../controllers/jobController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/projects/:id/generate', createGenerationJob);
router.get('/projects/:id/status', getGenerationStatus);

export default router;
