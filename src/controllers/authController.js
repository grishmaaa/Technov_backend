import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../config/database.js';
import {
    sendVerificationEmail,
    sendWelcomeEmail,
    sendPasswordResetEmail
} from '../services/emailService.js';
import { logger } from '../logger.js';

export const register = async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Generate verification token
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                name,
                password: hashedPassword,
                verificationToken,
                verificationTokenExpiresAt,
            },
            select: { id: true, email: true, name: true, role: true, plan: true, credits: true, isVerified: true, createdAt: true }
        });

        // Send verification email
        try {
            await sendVerificationEmail({
                to: user.email,
                token: verificationToken,
                name: user.name || user.email
            });
            logger.info({ userId: user.id, email: user.email }, 'Verification email sent successfully');
        } catch (emailError) {
            logger.error({ error: emailError, userId: user.id, email: user.email, details: emailError.message }, 'Failed to send verification email');
            // Still complete registration but user needs to resend verification
        }

        // Don't return tokens - require email verification before login
        res.status(201).json({
            success: true,
            message: 'Registration successful! Please check your email to verify your account before logging in.',
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                isVerified: user.isVerified
            }
        });
    } catch (error) {
        logger.error({ error }, 'Registration failed');
        res.status(500).json({ error: 'Registration failed', details: error.message });
    }
};

export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if email is verified
        if (!user.isVerified) {
            return res.status(403).json({
                error: 'Please verify your email before logging in.',
                code: 'EMAIL_NOT_VERIFIED'
            });
        }

        const accessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN
        });

        const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET, {
            expiresIn: process.env.JWT_REFRESH_EXPIRES_IN
        });

        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        });

        const { password: _, ...userWithoutPassword } = user;

        res.json({
            user: userWithoutPassword,
            accessToken,
            refreshToken
        });
    } catch (error) {
        res.status(500).json({ error: 'Login failed', details: error.message });
    }
};

export const logout = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (refreshToken) {
            await prisma.refreshToken.deleteMany({
                where: { token: refreshToken }
            });
        }

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
};

export const getMe = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { id: true, email: true, role: true, plan: true, credits: true, createdAt: true }
        });

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
};

export const refreshAccessToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const storedToken = await prisma.refreshToken.findUnique({
            where: { token: refreshToken }
        });

        if (!storedToken || storedToken.expiresAt < new Date()) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        const accessToken = jwt.sign({ userId: decoded.userId }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN
        });

        res.json({ accessToken });
    } catch (error) {
        res.status(401).json({ error: 'Invalid refresh token' });
    }
};

export const updateProfile = async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.id;

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: { name },
            select: { id: true, email: true, name: true, role: true, plan: true, credits: true }
        });

        res.json({ message: 'Profile updated', user: updatedUser });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update profile', details: error.message });
    }
};

export const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) return res.status(401).json({ error: 'Incorrect current password' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword }
        });

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to change password', details: error.message });
    }
};

export const deleteAccount = async (req, res) => {
    try {
        const userId = req.user.id;

        // Detailed logging before deletion
        console.log(`[DELETE_ACCOUNT] Starting deletion for user: ${userId}`);

        // Prisma cascade delete will handle related records (Projects, Credits, etc.)
        await prisma.user.delete({
            where: { id: userId }
        });

        console.log(`[DELETE_ACCOUNT] Successfully deleted user: ${userId}`);
        res.json({ message: 'Account deleted successfully' });
    } catch (error) {
        console.error(`[DELETE_ACCOUNT] Failed to delete user ${req.user.id}:`, error);
        res.status(500).json({ error: 'Failed to delete account', details: error.message });
    }
};

/**
 * Verify user's email address with token
 */
export const verifyEmail = async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Verification token is required' });
        }

        // Find user with this verification token
        const user = await prisma.user.findUnique({
            where: { verificationToken: token }
        });

        if (!user) {
            return res.status(400).json({ error: 'Invalid verification token' });
        }

        // Check if token has expired
        if (user.verificationTokenExpiresAt < new Date()) {
            return res.status(400).json({ error: 'Verification token has expired. Please request a new one.' });
        }

        // Check if already verified
        if (user.isVerified) {
            return res.status(200).json({ message: 'Email already verified' });
        }

        // Update user as verified and clear token
        await prisma.user.update({
            where: { id: user.id },
            data: {
                isVerified: true,
                verifiedAt: new Date(),
                verificationToken: null,
                verificationTokenExpiresAt: null,
            }
        });

        // Send welcome email (don't block if it fails)
        try {
            await sendWelcomeEmail({
                to: user.email,
                name: user.name || user.email
            });
            logger.info({ userId: user.id }, 'Welcome email sent');
        } catch (emailError) {
            logger.error({ error: emailError, userId: user.id }, 'Failed to send welcome email');
        }

        logger.info({ userId: user.id }, 'Email verified successfully');
        res.json({ message: 'Email verified successfully!' });
    } catch (error) {
        logger.error({ error }, 'Email verification failed');
        res.status(500).json({ error: 'Email verification failed', details: error.message });
    }
};

/**
 * Resend verification email
 */
export const resendVerificationEmail = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const user = await prisma.user.findUnique({
            where: { email }
        });

        // Don't reveal if user exists for security
        if (!user) {
            return res.json({ message: 'If that email is registered, a verification email has been sent.' });
        }

        // Check if already verified
        if (user.isVerified) {
            return res.status(400).json({ error: 'Email is already verified' });
        }

        // Generate new verification token
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        await prisma.user.update({
            where: { id: user.id },
            data: {
                verificationToken,
                verificationTokenExpiresAt,
            }
        });

        // Send verification email
        try {
            await sendVerificationEmail({
                to: user.email,
                token: verificationToken,
                name: user.name || user.email
            });
            logger.info({ userId: user.id }, 'Verification email resent');
        } catch (emailError) {
            logger.error({ error: emailError, userId: user.id }, 'Failed to resend verification email');
            return res.status(500).json({ error: 'Failed to send verification email' });
        }

        res.json({ message: 'Verification email has been sent. Please check your inbox.' });
    } catch (error) {
        logger.error({ error }, 'Resend verification failed');
        res.status(500).json({ error: 'Failed to resend verification email', details: error.message });
    }
};

/**
 * Request password reset
 */
export const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const user = await prisma.user.findUnique({
            where: { email }
        });

        // Don't reveal if user exists for security
        if (!user) {
            return res.json({ message: 'If that email exists, a password reset link has been sent.' });
        }

        // Generate password reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await prisma.user.update({
            where: { id: user.id },
            data: {
                passwordResetToken: resetToken,
                passwordResetTokenExpiresAt: resetTokenExpiresAt,
            }
        });

        // Send password reset email
        try {
            await sendPasswordResetEmail({
                to: user.email,
                token: resetToken,
                name: user.name || user.email
            });
            logger.info({ userId: user.id }, 'Password reset email sent');
        } catch (emailError) {
            logger.error({ error: emailError, userId: user.id }, 'Failed to send password reset email');
            return res.status(500).json({ error: 'Failed to send password reset email' });
        }

        res.json({ message: 'Password reset link has been sent to your email.' });
    } catch (error) {
        logger.error({ error }, 'Forgot password failed');
        res.status(500).json({ error: 'Failed to process password reset request', details: error.message });
    }
};

/**
 * Reset password with token
 */
export const resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        // Find user with this reset token
        const user = await prisma.user.findUnique({
            where: { passwordResetToken: token }
        });

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        // Check if token has expired
        if (user.passwordResetTokenExpiresAt < new Date()) {
            return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
        }

        // Hash new password and update user
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                passwordResetToken: null,
                passwordResetTokenExpiresAt: null,
            }
        });

        // Invalidate all existing refresh tokens for security
        await prisma.refreshToken.deleteMany({
            where: { userId: user.id }
        });

        logger.info({ userId: user.id }, 'Password reset successfully');
        res.json({ message: 'Password has been reset successfully. Please login with your new password.' });
    } catch (error) {
        logger.error({ error }, 'Password reset failed');
        res.status(500).json({ error: 'Failed to reset password', details: error.message });
    }
};
