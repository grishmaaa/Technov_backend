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

// TODO: Add email verification endpoints
// - POST /auth/resend-verification - Resend verification email to user
// - POST /auth/verify-email - Verify user's email with token from email link
// Required for frontend VerifyEmailPending.tsx page to work properly

export default router;
