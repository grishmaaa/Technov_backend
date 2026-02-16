import 'dotenv/config';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

async function testEmail() {
    console.log('Testing Resend email service...');
    console.log('API Key:', process.env.RESEND_API_KEY ? `${process.env.RESEND_API_KEY.substring(0, 10)}...` : 'NOT SET');
    console.log('From Email:', process.env.EMAIL_FROM || 'Technov AI <noreply@technov.ai>');

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM || 'Technov AI <noreply@technov.ai>',
            to: 'delivered@resend.dev', // Resend test email
            subject: 'Test Email from Technov AI',
            html: '<p>This is a test email to verify Resend integration works!</p>',
        });

        if (error) {
            console.error('❌ Email failed:', error);
            return;
        }

        console.log('✅ Email sent successfully!');
        console.log('Email ID:', data.id);
        console.log('\nNow try registering a user and check the logs.');
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

testEmail();
