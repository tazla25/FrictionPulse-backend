const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

const TEST_PORT = process.env.TEST_PORT || '3003';
const MOCK_SUPABASE_PORT = process.env.MOCK_SUPABASE_PORT || '3004';
const BASE_URL = `http://localhost:${TEST_PORT}`;

// 1. Start Mock Supabase Server
const mockSupabase = http.createServer((req, res) => {
  if (req.url === '/auth/v1/user') {
    if (req.headers.authorization === 'Bearer valid_test_token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'test-user-id',
        email: 'test@example.com',
        aud: 'authenticated',
        role: 'authenticated'
      }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid token' }));
    }
  } else {
    res.writeHead(404).end();
  }
});

mockSupabase.listen(MOCK_SUPABASE_PORT, () => {
  console.log(`Mock Supabase server running on port ${MOCK_SUPABASE_PORT}`);
  
  // 2. Start Backend Server
  const backendEnv = {
    ...process.env,
    PORT: TEST_PORT,
    SUPABASE_URL: `http://localhost:${MOCK_SUPABASE_PORT}`,
    SUPABASE_SERVICE_KEY: 'mock_service_key',
    WEBHOOK_SECRET: 'mock_webhook_secret',
    RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || 'mock_webhook_secret'
  };

  const backend = spawn('node', ['index.js'], { env: backendEnv });
  
  let backendOutput = '';
  backend.stdout.on('data', (data) => {
    backendOutput += data.toString();
  });
  backend.stderr.on('data', (data) => {
    backendOutput += data.toString();
  });

  backend.on('error', (err) => {
    console.error('Failed to start backend process:', err);
    cleanup(1);
  });

  backend.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`Backend process exited with code ${code}`);
      console.error('Backend logs:\n', backendOutput);
      cleanup(1);
    }
  });

  function cleanup(exitCode) {
    backend.kill();
    mockSupabase.close(() => {
      console.log('Cleanup complete. Exiting with code', exitCode);
      process.exit(exitCode);
    });
  }

  // Helper to wait for backend to be ready
  async function waitForBackend(retries = 20, delay = 500) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(`${BASE_URL}/ping`);
        if (res.status === 200) {
          if (i > 0) console.log(); // print newline if dots were printed
          return true;
        }
      } catch (err) {
        // Silent retry
      }
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, delay));
    }
    console.log();
    return false;
  }

  // 3. Run Tests
  async function runTests() {
    try {
      console.log('Waiting for backend server to start...');
      const ready = await waitForBackend();
      if (!ready) {
        throw new Error('Backend server failed to start or respond on /ping');
      }
      console.log('Backend server is ready.');

      // --- Test 1: Check /ping ---
      console.log('Running Test 1: Check /ping...');
      const resPing = await fetch(`${BASE_URL}/ping`);
      assert.strictEqual(resPing.status, 200, '/ping should return 200');
      const textPing = await resPing.text();
      assert.ok(textPing.includes('Server is awake!'), '/ping response text mismatch');
      console.log('✓ Test 1 Passed: /ping works successfully');

      // --- Test 2: Check create-subscription without token ---
      console.log('Running Test 2: Check create-subscription without token...');
      const resCreateNoToken = await fetch(`${BASE_URL}/api/payments/create-subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'starter' })
      });
      assert.strictEqual(resCreateNoToken.status, 401, 'Should return 401 without token');
      console.log('✓ Test 2 Passed: create-subscription without token returns 401');

      // --- Test 3: Check create-subscription with invalid token ---
      console.log('Running Test 3: Check create-subscription with invalid token...');
      const resCreateInvalidToken = await fetch(`${BASE_URL}/api/payments/create-subscription`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer invalid_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ planId: 'starter' })
      });
      assert.strictEqual(resCreateInvalidToken.status, 401, 'Should return 401 with invalid token');
      console.log('✓ Test 3 Passed: create-subscription with invalid token returns 401');

      // --- Test 4: Check create-subscription with invalid planId ---
      console.log('Running Test 4: Check create-subscription with invalid planId...');
      const resCreateInvalidPlan = await fetch(`${BASE_URL}/api/payments/create-subscription`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid_test_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ planId: 'invalid_plan' })
      });
      assert.strictEqual(resCreateInvalidPlan.status, 400, 'Should return 400 with invalid planId');
      console.log('✓ Test 4 Passed: create-subscription with invalid planId returns 400');

      // --- Test 5: Check verify-subscription without token ---
      console.log('Running Test 5: Check verify-subscription without token...');
      const resVerifyNoToken = await fetch(`${BASE_URL}/api/payments/verify-subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'starter' })
      });
      assert.strictEqual(resVerifyNoToken.status, 401, 'Should return 401 without token');
      console.log('✓ Test 5 Passed: verify-subscription without token returns 401');

      // --- Test 6: Check verify-subscription with missing parameters ---
      console.log('Running Test 6: Check verify-subscription with missing parameters...');
      const resVerifyMissingParams = await fetch(`${BASE_URL}/api/payments/verify-subscription`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid_test_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ planId: 'starter' }) // missing payment_id, sub_id, signature
      });
      assert.strictEqual(resVerifyMissingParams.status, 400, 'Should return 400 with missing parameters');
      console.log('✓ Test 6 Passed: verify-subscription with missing parameters returns 400');

      // --- Test 7: Check webhook/razorpay with invalid signature ---
      console.log('Running Test 7: Check webhook/razorpay with invalid signature...');
      const webhookSecret = backendEnv.RAZORPAY_WEBHOOK_SECRET;
      const isMockSecret = !webhookSecret || webhookSecret === 'mock_webhook_secret';
      const expectedStatus = isMockSecret ? 200 : 400;

      console.log(`(RAZORPAY_WEBHOOK_SECRET is set to "${webhookSecret}". Expected status: ${expectedStatus})`);

      const resWebhook = await fetch(`${BASE_URL}/webhook/razorpay`, {
        method: 'POST',
        headers: {
          'x-razorpay-signature': 'invalid_signature',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ event: 'unsupported.event' })
      });

      assert.strictEqual(resWebhook.status, expectedStatus, `Webhook should return ${expectedStatus}`);
      console.log(`✓ Test 7 Passed: webhook/razorpay returned expected status ${expectedStatus}`);

      console.log('\n======================================');
      console.log('All tests passed successfully! 🎉');
      console.log('======================================');
      cleanup(0);
    } catch (err) {
      console.error('\n❌ Test failed:', err.message);
      if (err.stack) {
        console.error(err.stack);
      }
      cleanup(1);
    }
  }

  // Delay a bit before running tests
  setTimeout(runTests, 1000);
});
