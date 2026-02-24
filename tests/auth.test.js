import { test } from 'node:test';
import assert from 'node:assert';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../src/config/database.js';
import * as emailService from '../src/services/emailService.js';
import { register, login, googleRedirect, googleCallback } from '../src/controllers/authController.js';

// Setup Mock Environment
process.env.JWT_SECRET = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.GOOGLE_CLIENT_ID = 'google-id';
process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.GOOGLE_CALLBACK_URL = 'http://localhost/callback';
process.env.FRONTEND_URL = 'http://localhost:8080';

// Mock dependencies
bcrypt.hash = async (val, salts) => `hashed_${val}`;
bcrypt.compare = async (val, hash) => hash === `hashed_${val}`;
jwt.sign = (payload, secret, options) => `mock_token_${options.expiresIn}`;

const mockPrisma = {
    user: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async (data) => ({
            id: 'mock-user-id',
            ...data.data,
            isVerified: data.data.isVerified || false
        }),
        update: async (data) => ({ id: data.where.id, ...data.data })
    },
    refreshToken: {
        create: async () => ({})
    }
};

Object.assign(prisma, mockPrisma);

// Mock OAuth2Client
OAuth2Client.prototype.generateAuthUrl = function (options) {
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${this._clientId}`;
};

OAuth2Client.prototype.getToken = async function (code) {
    if (code === 'invalid_code') throw new Error('Invalid code');
    return { tokens: { id_token: 'mock_id_token' } };
};

OAuth2Client.prototype.verifyIdToken = async function (options) {
    return {
        getPayload: () => {
            if (options.idToken === 'mock_id_token') {
                return { sub: 'google-sub-123', email: 'google@test.com', name: 'Google User' };
            }
            if (options.idToken === 'mock_no_email') {
                return { sub: 'google-no-email' };
            }
        }
    };
};



// Helper to create mock req/res
const createRes = () => {
    const res = {
        statusCode: 200,
        body: null,
        redirectUrl: null,
        status: function (code) { this.statusCode = code; return this; },
        json: function (data) { this.body = data; return this; },
        redirect: function (url) { this.redirectUrl = url; return this; }
    };
    return res;
};

test('Registration Edge Cases', async (t) => {
    await t.test('Successful registration creates user and tokens', async () => {
        const req = { body: { email: 'test@example.com', password: 'password123', name: 'Test User' } };
        const res = createRes();

        // Ensure user does not exist
        prisma.user.findUnique = async () => null;

        await register(req, res);

        assert.strictEqual(res.statusCode, 201);
        assert.ok(res.body.accessToken);
        assert.ok(res.body.refreshToken);
        assert.strictEqual(res.body.user.email, 'test@example.com');
    });

    await t.test('Fails on existing email', async () => {
        const req = { body: { email: 'test@example.com', password: 'password123' } };
        const res = createRes();

        prisma.user.findUnique = async () => ({ id: 'existing-id', email: 'test@example.com' });

        await register(req, res);

        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'Email already registered');
    });

    await t.test('Fails on missing fields', async () => {
        const req = { body: { email: 'test@example.com' } };
        const res = createRes();
        await register(req, res);
        assert.strictEqual(res.statusCode, 400);
    });
});

test('Login Edge Cases', async (t) => {
    await t.test('Successful login returns tokens', async () => {
        const req = { body: { email: 'test@example.com', password: 'password123' } };
        const res = createRes();

        prisma.user.findUnique = async () => ({
            id: 'existing-id',
            email: 'test@example.com',
            password: 'hashed_password123'
        });

        await login(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.accessToken);
        assert.ok(res.body.refreshToken);
    });

    await t.test('Google-only users cannot login with password', async () => {
        const req = { body: { email: 'google@test.com', password: 'password123' } };
        const res = createRes();

        prisma.user.findUnique = async () => ({
            id: 'existing-id',
            email: 'google@test.com',
            password: null, // Google only
            googleId: '123'
        });

        await login(req, res);

        assert.strictEqual(res.statusCode, 401);
        assert.ok(res.body.error.includes('uses Google sign-in'));
    });

    await t.test('Invalid credentials', async () => {
        const req = { body: { email: 'test@example.com', password: 'wrong' } };
        const res = createRes();

        prisma.user.findUnique = async () => ({
            id: 'existing-id',
            email: 'test@example.com',
            password: 'hashed_password123'
        });

        await login(req, res);
        assert.strictEqual(res.statusCode, 401);
    });
});

test('Google OAuth Edge Cases', async (t) => {
    await t.test('googleRedirect redirects to authUrl', async () => {
        const req = {};
        const res = createRes();

        await googleRedirect(req, res);

        assert.ok(res.redirectUrl.includes('https://accounts.google.com/o/oauth2'));
    });

    await t.test('googleCallback registers new user and redirects', async () => {
        const req = { query: { code: 'valid_code' } };
        const res = createRes();

        prisma.user.findFirst = async () => null; // new user

        await googleCallback(req, res);

        assert.ok(res.redirectUrl.startsWith('http://localhost:8080/dashboard?accessToken='));
    });

    await t.test('googleCallback links existing email account', async () => {
        const req = { query: { code: 'valid_code' } };
        const res = createRes();

        let updated = false;
        prisma.user.findFirst = async () => ({ id: 'existing', email: 'google@test.com', googleId: null });
        prisma.user.update = async (data) => {
            updated = true;
            return { id: data.where.id, ...data.data };
        };

        await googleCallback(req, res);

        assert.strictEqual(updated, true);
        assert.ok(res.redirectUrl.startsWith('http://localhost:8080/dashboard?accessToken='));
    });

    await t.test('googleCallback fails gracefully if no email in payload', async () => {
        const req = { query: { code: 'valid_code' } };
        const res = createRes();

        OAuth2Client.prototype.verifyIdToken = async function () {
            return { getPayload: () => ({ sub: 'google-no-email' }) };
        };

        await googleCallback(req, res);

        assert.ok(res.redirectUrl.includes('error=Google account has no email'));
    });

    await t.test('googleCallback redirects to login on error', async () => {
        const req = { query: { code: 'invalid_code' } };
        const res = createRes();

        await googleCallback(req, res);

        assert.ok(res.redirectUrl.includes('error=Google login failed'));
    });
});
