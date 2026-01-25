#!/usr/bin/env node
/**
 * Quick Veo Test Script
 * Run: node test-veo.js
 */
import dotenv from 'dotenv';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';

dotenv.config();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function testVeo() {
    console.log('🚀 Testing Veo Video Generation...\n');

    // Setup credentials
    if (process.env.GCP_SA_KEY) {
        fs.writeFileSync('vertex-key.json', process.env.GCP_SA_KEY);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = './vertex-key.json';
    }

    // Get project info
    let project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (!project && process.env.GCP_SA_KEY) {
        project = JSON.parse(process.env.GCP_SA_KEY).project_id;
    }

    const location = process.env.GCP_LOCATION || 'us-central1';
    const modelId = (process.env.VEO_MODEL || 'veo-3.1-fast-generate-001').trim();

    console.log(`Project: ${project}`);
    console.log(`Location: ${location}`);
    console.log(`Model: ${modelId}\n`);

    // Get access token
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();

    if (!token) {
        console.error('❌ Failed to get access token');
        return;
    }
    console.log('✅ Got access token\n');

    // Make Veo request
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:predictLongRunning`;

    console.log(`Endpoint: ${endpoint}\n`);

    const request = {
        instances: [{ prompt: 'A beautiful sunset over the ocean, waves gently crashing, golden light' }],
        parameters: { aspectRatio: '16:9', sampleCount: 1 }
    };

    console.log('📤 Sending request...');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Request failed: ${response.status}\n${error}`);
        return;
    }

    const data = await response.json();
    console.log('✅ Operation started!');
    console.log('Full response:', JSON.stringify(data, null, 2));

    const operationName = data.name;
    if (!operationName) {
        console.error('❌ No operation name returned');
        return;
    }

    // Poll for result
    console.log(`\n🔄 Polling operation: ${operationName}`);
    const pollUrl = `https://${location}-aiplatform.googleapis.com/v1beta1/${operationName}`;

    for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const pollRes = await fetch(pollUrl, { headers: { 'Authorization': `Bearer ${token}` } });

        if (!pollRes.ok) {
            console.log(`  Attempt ${i + 1}: Status ${pollRes.status}`);
            continue;
        }

        const pollData = await pollRes.json();
        if (pollData.done) {
            console.log('\n✅ Video generation complete!');
            console.log('Result:', JSON.stringify(pollData, null, 2));
            return;
        }
        console.log(`  Attempt ${i + 1}: Still processing...`);
    }
    console.log('⏰ Timeout - check Google Cloud Console for status');
}

testVeo().catch(console.error);
