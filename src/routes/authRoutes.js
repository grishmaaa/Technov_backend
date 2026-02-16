import express from 'express';
import {
    register,
    login,
    logout,
    getMe,
    refreshAccessToken,
    updateProfile,
    changePassword,
    deleteAccount,
    verifyEmail,
    resendVerificationEmail,
    forgotPassword,
    resetPassword
} from '../controllers/authController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Public authentication routes
router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.post('/refresh', refreshAccessToken);

// Email verification routes (public)
router.post('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerificationEmail);

// Password reset routes (public)
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Protected routes
router.get('/me', authMiddleware, getMe);
router.put('/me', authMiddleware, updateProfile);
router.post('/change-password', authMiddleware, changePassword);
router.delete('/me', authMiddleware, deleteAccount);

export default router;
