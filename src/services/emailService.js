import { Resend } from 'resend';
import { logger } from '../logger.js';
import { verificationEmailTemplate } from '../templates/verificationEmail.js';
import { welcomeEmailTemplate } from '../templates/welcomeEmail.js';
import { passwordResetEmailTemplate } from '../templates/passwordResetEmail.js';
import { videoReadyEmailTemplate } from '../templates/videoReadyEmail.js';

// Initialize Resend client
const resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;

// Your verified domain's from address (update once domain is verified in Resend)
const FROM_EMAIL = process.env.EMAIL_FROM || 'Technov AI <noreply@technov.ai>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/**
 * Send an email via Resend
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML email body
 * @returns {Promise<Object>} Resend API response
 */
const sendEmail = async ({ to, subject, html }) => {
    if (!resend) {
        logger.warn({ to, subject }, 'RESEND_API_KEY not set — email skipped');
        return { id: 'skipped', message: 'Email service not configured' };
    }

    try {
        const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to,
            subject,
            html,
        });

        if (error) {
            logger.error({ error, to, subject }, 'Resend API returned error');
            throw new Error(error.message || 'Failed to send email');
        }

        logger.info({ emailId: data?.id, to, subject }, 'Email sent successfully');
        return data;
    } catch (err) {
        logger.error({ err, to, subject }, 'Failed to send email');
        throw err;
    }
};

/**
 * Send verification email to a new user
 */
export const sendVerificationEmail = async ({ to, token, name }) => {
    const verifyUrl = `${FRONTEND_URL}/verify-email/${token}`;
    const html = verificationEmailTemplate({ verifyUrl, name: name || to });

    return sendEmail({
        to,
        subject: 'Verify your email — Technov AI',
        html,
    });
};

/**
 * Send welcome email after successful verification
 */
export const sendWelcomeEmail = async ({ to, name }) => {
    const dashboardUrl = `${FRONTEND_URL}/dashboard`;
    const html = welcomeEmailTemplate({ dashboardUrl, name: name || to });

    return sendEmail({
        to,
        subject: 'Welcome to Technov AI 🎬',
        html,
    });
};

/**
 * Send password reset email
 */
export const sendPasswordResetEmail = async ({ to, token, name }) => {
    const resetUrl = `${FRONTEND_URL}/reset-password/${token}`;
    const html = passwordResetEmailTemplate({ resetUrl, name: name || to });

    return sendEmail({
        to,
        subject: 'Reset your password — Technov AI',
        html,
    });
};

/**
 * Send video ready notification email
 */
export const sendVideoReadyEmail = async ({ to, projectTitle, projectId, name }) => {
    const viewUrl = `${FRONTEND_URL}/projects/${projectId}`;
    const html = videoReadyEmailTemplate({ viewUrl, projectTitle, name: name || to });

    return sendEmail({
        to,
        subject: `Your video "${projectTitle}" is ready! 🎬`,
        html,
    });
};
