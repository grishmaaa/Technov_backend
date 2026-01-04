import Razorpay from 'razorpay';
import crypto from 'crypto';
import prisma from '../config/database.js';

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_PLACEHOLDER',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'PLACEHOLDER_SECRET',
});

// Plan pricing (in paise - ₹1 = 100 paise)
const PLANS = {
    basic: {
        name: 'Basic Plan',
        amount: 2499900, // ₹24,999
        currency: 'INR',
        credits: 30,
    },
    pro: {
        name: 'Pro Plan',
        amount: 6399900, // ₹63,999
        currency: 'INR',
        credits: 30,
    }
};

export const createOrder = async (req, res) => {
    try {
        const { plan } = req.body;

        console.log('Creating order for plan:', plan);
        console.log('User ID:', req.user?.id);

        if (!PLANS[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        const planDetails = PLANS[plan];

        // Create Razorpay order with simplified format
        const options = {
            amount: planDetails.amount,
            currency: planDetails.currency,
            receipt: `rcpt_${Date.now()}`,
            notes: {
                plan: plan,
                user_id: String(req.user.id),
                credits: String(planDetails.credits)
            }
        };

        console.log('Creating Razorpay order with options:', JSON.stringify(options, null, 2));

        const order = await razorpay.orders.create(options);

        console.log('Order created successfully:', order.id);

        res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
        });
    } catch (error) {
        console.error('Create order error:', error);
        console.error('Error details:', JSON.stringify(error, null, 2));
        res.status(500).json({
            error: 'Failed to create payment order',
            details: error.error?.description || error.message
        });
    }
};

export const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        // Verify signature
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'PLACEHOLDER_SECRET')
            .update(sign.toString())
            .digest('hex');

        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        // Fetch order details to get plan info
        const order = await razorpay.orders.fetch(razorpay_order_id);
        const { userId, plan, credits } = order.notes;

        // Update user plan and add credits
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                plan: plan,
                credits: { increment: parseInt(credits) }
            },
            select: {
                id: true,
                email: true,
                plan: true,
                credits: true,
                role: true
            }
        });

        res.json({
            success: true,
            message: 'Payment verified and plan upgraded successfully',
            user: updatedUser
        });
    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({ error: 'Payment verification failed', details: error.message });
    }
};

export const handleWebhook = async (req, res) => {
    try {
        const webhookSignature = req.headers['x-razorpay-signature'];
        const webhookBody = JSON.stringify(req.body);

        // Verify webhook signature
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
            .update(webhookBody)
            .digest('hex');

        if (webhookSignature === expectedSignature) {
            const event = req.body.event;
            const payload = req.body.payload.payment.entity;

            if (event === 'payment.captured') {
                // Payment successful - handled in verifyPayment
                console.log('Payment captured:', payload.id);
            }
        }

        res.json({ status: 'ok' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
};
