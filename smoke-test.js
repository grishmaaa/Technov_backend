
import axios from 'axios';

const API_URL = 'http://localhost:8000/api';

async function testBackend() {
    try {
        console.log("1. Checking Health...");
        await axios.get('http://localhost:8000/health');
        console.log("✅ Health Check Passed");

        const email = `test_${Date.now()}@example.com`;
        const password = "password123";

        console.log(`2. Registering User ${email}...`);
        try {
            await axios.post(`${API_URL}/auth/register`, {
                email,
                password,
                name: "Test User"
            });
            console.log("✅ Registration Successful");
        } catch (e) {
            console.log("❌ Registration Failed:", e.response ? e.response.data : e.message);
        }

        console.log("3. Logging in (waiting for iat tick)...");
        await new Promise(r => setTimeout(r, 1500));

        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email,
            password
        });

        const token = loginRes.data.accessToken;
        console.log("✅ Login Successful. Token obtained.");

        console.log("4. Testing Payment Session Creation...");
        const paymentRes = await axios.post(
            `${API_URL}/payments/create-checkout-session`,
            { planId: "pro" },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        console.log("✅ Payment Session Created:", paymentRes.data);

        console.log("5. Testing Verification...");
        const verifyRes = await axios.post(
            `${API_URL}/payments/verify`,
            { planId: "pro" },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log("✅ Verification Successful. New Credits:", verifyRes.data.newCredits);


    } catch (error) {
        console.error("❌ Test Failed:", error.response ? error.response.data : error.message);
    }
}

testBackend();
