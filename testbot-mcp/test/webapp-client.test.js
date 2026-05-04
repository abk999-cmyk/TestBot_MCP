'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const WebappClient = require('../src/webapp-client');
const {
  ENDPOINT_TIMEOUTS_MS,
  computePollBackoffMs,
} = WebappClient;

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('computePollBackoffMs uses bounded staged backoff', () => {
  assert.equal(computePollBackoffMs(0, 1000), 1000);
  assert.equal(computePollBackoffMs(9, 1000), 1000);
  assert.equal(computePollBackoffMs(10, 1000), 5000);
  assert.equal(computePollBackoffMs(20, 1000), 8000);
  assert.equal(computePollBackoffMs(30, 1000), 12000);
  assert.equal(computePollBackoffMs(40, 1000), 15000);
  assert.equal(computePollBackoffMs(40, 20000), 20000);
});

test('nextSequentialAction posts API key, turn payload, and normalized local dashboard URL', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      success: true,
      source: 'openai',
      action: { type: 'finish', summary: 'done' },
    });
  };

  const client = new WebappClient({
    apiKey: 'tb_test',
    dashboardUrl: 'http://localhost:3000/',
  });
  const response = await client.nextSequentialAction({
    testCase: { id: 'case-1', title: 'Case one' },
    observation: { url: 'http://127.0.0.1:3001/' },
    history: null,
    lastError: '',
  });

  assert.equal(response.action.type, 'finish');
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/test-turns/next-action');
  assert.equal(calls[0].options.headers['x-api-key'], 'tb_test');
  assert.ok(calls[0].options.signal);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.api_key, 'tb_test');
  assert.deepEqual(body.history, []);
  assert.equal(body.lastError, null);
});

test('synthesizeSequentialSpec posts trace payload to the synthesis endpoint', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      success: true,
      source: 'openai',
      spec: { filename: 'case.spec.ts', content: 'import { test } from "./__healix-fixture";' },
    });
  };

  const client = new WebappClient({ apiKey: 'tb_test', dashboardUrl: 'http://127.0.0.1:3000' });
  const response = await client.synthesizeSequentialSpec({
    testCase: { id: 'case-1', title: 'Case one' },
    trace: { turns: [] },
  });

  assert.equal(response.spec.filename, 'case.spec.ts');
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/test-turns/synthesize-spec');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.api_key, 'tb_test');
  assert.deepEqual(body.trace, { turns: [] });
});

test('webapp client maps token, auth, rate, and server failures to explicit error codes', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const cases = [
    [401, 'Invalid or inactive API key', 'INVALID_API_KEY'],
    [402, 'No tokens remaining. Please renew your plan.', 'INSUFFICIENT_CREDITS'],
    [429, 'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED'],
    [500, 'Internal error', 'WEBAPP_SERVER_ERROR'],
  ];

  for (const [status, message, code] of cases) {
    global.fetch = async () => jsonResponse(status, { error: message });
    const client = new WebappClient({ apiKey: 'tb_test', dashboardUrl: 'http://127.0.0.1:3000' });
    await assert.rejects(
      () => client.nextSequentialAction({ testCase: { id: 'case-1', title: 'Case one' }, observation: {} }),
      (err) => err.code === code && err.status === status && err.message.includes(message),
    );
  }
});

test('sequential endpoint timeouts are long enough for live turn generation', () => {
  assert.equal(ENDPOINT_TIMEOUTS_MS.nextSequentialAction, 180000);
  assert.equal(ENDPOINT_TIMEOUTS_MS.synthesizeSequentialSpec, 180000);
});

test('client rejects sequential calls before network when the Healix API key is missing', async () => {
  const client = new WebappClient({ apiKey: '', dashboardUrl: 'http://127.0.0.1:3000' });

  await assert.rejects(
    () => client.nextSequentialAction({ testCase: { id: 'case-1', title: 'Case one' }, observation: {} }),
    (err) => err.code === 'MISSING_HEALIX_API_KEY' && err.message.includes('/api/test-turns/next-action'),
  );
});
