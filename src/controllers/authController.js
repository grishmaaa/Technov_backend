import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/database.js';

// TODO: Add email verification functionality
// - Implement resendVerificationEmail(req, res) function
// - Implement verifyEmail(req, res) function  
// - Add verificationToken field to User model in schema.prisma
// - Set up email service (e.g., nodemailer with SMTP or SendGrid)
// - Create email templates for verification emails

export const register = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
            },
            select: { id: true, email: true, role: true, plan: true, credits: true, createdAt: true }
        });

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
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
            }
        });

        res.status(201).json({
            user,
            accessToken,
            refreshToken
        });
    } catch (error) {
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
