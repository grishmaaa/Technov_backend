import express from 'express';
import {
    register,
    login,
    logout,
    getMe,
    refreshAccessToken
} from '../controllers/authController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.post('/refresh', refreshAccessToken);
router.get('/me', authMiddleware, getMe);

export default router;
