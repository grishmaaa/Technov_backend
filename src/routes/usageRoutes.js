import express from 'express';
import { getUsageHistory, getCreditSummary } from '../controllers/usageController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);

// GET /api/usage/history - Get credit usage history
router.get('/history', getUsageHistory);

// GET /api/usage/summary - Get credit summary for current user
router.get('/summary', getCreditSummary);

export default router;
