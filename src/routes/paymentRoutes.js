import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { createOrder, verifyPayment, handleWebhook } from '../controllers/paymentController.js';

const router = express.Router();

// --- PROTECTED ROUTES (Require Auth) ---
// POST /api/payments/create-order - Create a Razorpay Order (Popup)
router.post('/create-order', authMiddleware, createOrder);

// POST /api/payments/verify - Verify payment after frontend completion
router.post('/verify', authMiddleware, verifyPayment);

// --- WEBHOOK ROUTE (No Auth - Razorpay calls this directly) ---
// Raw body parser already configured in index.js for webhooks
router.post('/webhook', handleWebhook);

export default router;
