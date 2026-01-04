import express from 'express';
import {
    getAllUsers,
    updateUserCredits,
    updateUserPlan,
    updateUser
} from '../controllers/adminController.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole(['admin']));

router.get('/users', getAllUsers);
router.put('/users/:userId', updateUser); // Unified endpoint for plan and credits
router.put('/users/:userId/credits', updateUserCredits);
router.put('/users/:userId/plan', updateUserPlan);

export default router;
