import express from 'express';
import { handleEvolinkWebhook } from '../controllers/webhookController.js';

const router = express.Router();

/**
 * POST /api/webhooks/evolink
 * Public endpoint for EvoLink callback_url
 */
router.post('/evolink', handleEvolinkWebhook);

export default router;
