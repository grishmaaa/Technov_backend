import express from 'express';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Get notifications
router.get('/', authMiddleware, (req, res) => {
    res.json([]); // Return empty array for now
});

// Mark all as read
router.post('/mark-read', authMiddleware, (req, res) => {
    res.json({ success: true });
});

export default router;
