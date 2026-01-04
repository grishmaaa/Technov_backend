import Razorpay from 'razorpay';
import dotenv from 'dotenv';

dotenv.config();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

console.log('Testing Razorpay order creation...\n');

// Test with minimal order
const testOrder = async () => {
    try {
        const order = await razorpay.orders.create({
            amount: 50000, // ₹500 in paise
            currency: 'INR',
            receipt: `test_${Date.now()}`,
        });

        console.log('✅ SUCCESS! Order created:');
        console.log('Order ID:', order.id);
        console.log('Amount:', order.amount);
        console.log('Currency:', order.currency);
        console.log('\nYour Razorpay integration is working! 🎉');
        process.exit(0);
    } catch (error) {
        console.error('❌ FAILED! Error creating order:');
        console.error('Message:', error.error?.description || error.message);
        console.error('Code:', error.error?.code);
        console.error('Reason:', error.error?.reason);
        console.error('\nFull error:', JSON.stringify(error, null, 2));
        process.exit(1);
    }
};

testOrder();
