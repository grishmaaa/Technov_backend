import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Test Razorpay keys loading
console.log('\n=== RAZORPAY KEY CHECK ===');
console.log('Key ID exists:', !!process.env.RAZORPAY_KEY_ID);
console.log('Key ID starts with rzp_test_:', process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_'));
console.log('Key ID length:', process.env.RAZORPAY_KEY_ID?.length);
console.log('Key Secret exists:', !!process.env.RAZORPAY_KEY_SECRET);
console.log('Key Secret length:', process.env.RAZORPAY_KEY_SECRET?.length);
console.log('=========================\n');

// Try to initialize Razorpay
try {
    const Razorpay = (await import('razorpay')).default;
    const rzp = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('✅ Razorpay initialized successfully!');
} catch (error) {
    console.error('❌ Razorpay initialization failed:', error.message);
}

app.listen(3001, () => {
    console.log('\nTest server on port 3001 - Check output above');
});
