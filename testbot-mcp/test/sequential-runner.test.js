'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSequentialAction,
  isFatalTurnServiceError,
  executeSequentialAction,
  createSequentialCases,
  loginPathCandidates,
  buildSpecFromTrace,
} = require('../src/sequential-runner');

function createLocator(name, calls, text = 'expected text') {
  return {
    first() {
      calls.push(['first', name]);
      return this;
    },
    async waitFor(options) {
      calls.push(['waitFor', name, options?.state || null]);
    },
    async fill(value) {
      calls.push(['fill', name, value]);
    },
    async click() {
      calls.push(['click', name]);
    },
    async selectOption(value) {
      calls.push(['selectOption', name, value]);
    },
    async textContent() {
      calls.push(['textContent', name]);
      return text;
    },
  };
}

function createPageStub({ initialUrl = 'http://127.0.0.1:3000/login', text = 'expected text' } = {}) {
  const calls = [];
  let currentUrl = initialUrl;
  const page = {
    calls,
    url() {
      return currentUrl;
    },
    async goto(url) {
      calls.push(['goto', url]);
      currentUrl = url;
    },
    locator(selector) {
      calls.push(['locator', selector]);
      return createLocator(`locator:${selector}`, calls, text);
    },
    getByLabel(value, options) {
      calls.push(['getByLabel', value, options || null]);
      return createLocator(`label:${value}`, calls, text);
    },
    getByPlaceholder(value, options) {
      calls.push(['getByPlaceholder', value, options || null]);
      return createLocator(`placeholder:${value}`, calls, text);
    },
    getByTestId(value) {
      calls.push(['getByTestId', value]);
      return createLocator(`testid:${value}`, calls, text);
    },
    getByText(value, options) {
      calls.push(['getByText', value, options || null]);
      return createLocator(`text:${value}`, calls, text);
    },
    getByRole(role, options) {
      calls.push(['getByRole', role, options || null]);
      return createLocator(`role:${role}:${options?.name || ''}`, calls, text);
    },
  };
  return page;
}

test('validateSequentialAction rejects malformed actions', () => {
  assert.equal(validateSequentialAction(null).ok, false);
  assert.equal(validateSequentialAction({ type: 'hover' }).ok, false);
  assert.equal(validateSequentialAction({ type: 'click' }).ok, false);
  assert.equal(validateSequentialAction({ type: 'goto', path: '/login' }).ok, true);
  assert.equal(validateSequentialAction({
    type: 'fill',
    locatorCandidates: ['input[type="email"]'],
    value: 'user@example.com',
  }).ok, true);
});

test('validateSequentialAction enforces action-specific required fields', () => {
  assert.equal(validateSequentialAction({ type: 'fill', locatorCandidates: ['#email'] }).ok, false);
  assert.equal(validateSequentialAction({ type: 'fill', locatorCandidates: ['#email'], value: '' }).ok, true);
  assert.equal(validateSequentialAction({ type: 'select', locatorCandidates: ['select'] }).ok, false);
  assert.equal(validateSequentialAction({ type: 'select', locatorCandidates: ['select'], value: 'M' }).ok, true);
  assert.equal(validateSequentialAction({ type: 'apiRequest' }).ok, false);
  assert.equal(validateSequentialAction({ type: 'apiRequest', path: '/api/health' }).ok, true);
  assert.equal(validateSequentialAction({ type: 'finish' }).ok, true);
});

test('executeSequentialAction resolves shorthand CSS, role, and label locators', async () => {
  const page = createPageStub();

  await executeSequentialAction({
    page,
    baseURL: 'http://127.0.0.1:3000',
    action: { type: 'fill', locatorCandidates: [{ css: '#email' }, { label: 'Email' }], value: 'user@example.com' },
  });
  await executeSequentialAction({
    page,
    baseURL: 'http://127.0.0.1:3000',
    action: { type: 'click', locatorCandidates: [{ role: 'button', name: 'Sign In' }] },
  });
  await executeSequentialAction({
    page,
    baseURL: 'http://127.0.0.1:3000',
    action: { type: 'assertVisible', locatorCandidates: [{ label: 'Password' }] },
  });

  assert.deepEqual(page.calls.filter(([kind]) => kind === 'locator')[0], ['locator', '#email']);
  assert.ok(page.calls.some((call) => call[0] === 'fill' && call[2] === 'user@example.com'));
  assert.ok(page.calls.some((call) => call[0] === 'getByRole' && call[1] === 'button' && call[2].name === 'Sign In'));
  assert.ok(page.calls.some((call) => call[0] === 'getByLabel' && call[1] === 'Password'));
});

test('executeSequentialAction normalizes same-port loopback goto actions', async () => {
  const page = createPageStub();
  await executeSequentialAction({
    page,
    baseURL: 'http://127.0.0.1:3005',
    action: { type: 'goto', url: 'http://localhost:3005/login' },
  });

  assert.equal(page.url(), 'http://127.0.0.1:3005/login');
  assert.ok(page.calls.some((call) => call[0] === 'goto' && call[1] === 'http://127.0.0.1:3005/login'));
});

test('executeSequentialAction fails assertions with useful messages', async () => {
  const page = createPageStub({ initialUrl: 'http://127.0.0.1:3000/login', text: 'actual body copy' });

  await assert.rejects(
    () => executeSequentialAction({
      page,
      baseURL: 'http://127.0.0.1:3000',
      action: { type: 'assertText', locatorCandidates: ['body'], text: 'missing phrase' },
    }),
    /Expected text "missing phrase"/,
  );

  await assert.rejects(
    () => executeSequentialAction({
      page,
      baseURL: 'http://127.0.0.1:3000',
      action: { type: 'assertURL', path: '/admin' },
    }),
    /Expected URL to include "\/admin"/,
  );
});

test('executeSequentialAction handles API probes and status expectations', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { status: 204 };
  };

  const result = await executeSequentialAction({
    page: createPageStub(),
    baseURL: 'http://127.0.0.1:3000',
    apiBaseURL: 'http://127.0.0.1:4000',
    action: { type: 'apiRequest', method: 'POST', path: '/api/orders', expectedStatus: 204, body: { id: 1 } },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:4000/api/orders');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, JSON.stringify({ id: 1 }));

  global.fetch = async () => ({ status: 500 });
  await assert.rejects(
    () => executeSequentialAction({
      page: createPageStub(),
      baseURL: 'http://127.0.0.1:3000',
      action: { type: 'apiRequest', path: '/api/orders' },
    }),
    /HTTP 500/,
  );
});

test('createSequentialCases makes auth a first-class setup case', () => {
  const cases = createSequentialCases({
    config: {
      testCredentials: [{ role: 'admin', username: 'a@example.com', password: 'secret' }],
    },
    context: { pages: [{ path: '/dashboard', description: 'Dashboard' }] },
    parsedPRD: null,
    explorationArtifact: { authFlow: { loginUrl: '/login' } },
    roles: [],
  });

  assert.equal(cases[0].kind, 'auth');
  assert.equal(cases[0].role, 'admin');
  assert.ok(cases.some((c) => c.path === '/dashboard'));
});

test('createSequentialCases merges PRD, exploration, page, and API targets with a max cap', () => {
  const cases = createSequentialCases({
    config: { maxSequentialCases: 5 },
    context: {
      pages: [{ path: '/shop', description: 'Shop' }],
      apiEndpoints: [{ method: 'GET', path: '/api/products', description: 'Products API' }],
    },
    parsedPRD: {
      features: [
        {
          name: 'Catalog',
          userStories: [
            {
              goal: 'Browse products',
              acceptanceCriteria: [
                { id: 'F1.S1.AC1', text: 'Product catalog filters by category', authRequired: false },
                { id: 'F1.S1.AC2', text: 'Admin can edit product inventory', authRequired: true, roleHint: 'admin' },
              ],
            },
          ],
        },
      ],
    },
    explorationArtifact: {
      keyFlows: [{ name: 'Checkout flow', route: '/checkout', endCondition: 'Order confirmation visible' }],
    },
    roles: [],
  });

  assert.equal(cases.length, 5);
  assert.equal(cases[0].id, 'f1-s1-ac1');
  assert.equal(cases[1].kind, 'auth-ui');
  assert.equal(cases[1].role, 'admin');
  assert.ok(cases.some((testCase) => testCase.source === 'exploration'));
  assert.ok(cases.some((testCase) => testCase.source === 'context.pages'));
});

test('loginPathCandidates tries real login routes before app root', () => {
  const candidates = loginPathCandidates('http://127.0.0.1:3002');
  assert.equal(candidates[0], 'http://127.0.0.1:3002/login');
  assert.ok(candidates.includes('http://127.0.0.1:3002/'));
});

test('isFatalTurnServiceError blocks quota and auth gate failures', () => {
  assert.equal(isFatalTurnServiceError('Healix webapp /api/test-turns/next-action failed (402): No tokens remaining. Please renew your plan.'), true);
  assert.equal(isFatalTurnServiceError('Healix webapp /api/test-turns/next-action failed (401): Missing api_key'), true);
  assert.equal(isFatalTurnServiceError('Healix webapp /api/test-turns/next-action failed (429): RATE_LIMIT_EXCEEDED'), true);
  assert.equal(isFatalTurnServiceError('Healix webapp /api/test-turns/next-action failed (403): API key has been revoked'), true);
  assert.equal(isFatalTurnServiceError('network socket closed'), false);
});

test('buildSpecFromTrace synthesizes a deterministic Playwright spec', () => {
  const content = buildSpecFromTrace({
    baseURL: 'http://localhost:3000',
    testCase: { id: 'home', title: 'Home renders' },
    trace: {
      turns: [
        { status: 'ok', action: { type: 'goto', path: '/' } },
        { status: 'ok', action: { type: 'assertVisible', locatorCandidates: ['main', 'body'] } },
        { status: 'ok', action: { type: 'finish' } },
      ],
    },
  });

  assert.match(content, /__healix-fixture/);
  assert.match(content, /page\.goto/);
  assert.match(content, /expect/);
});

test('buildSpecFromTrace covers click, fill, select, text, URL, and API actions', () => {
  const content = buildSpecFromTrace({
    baseURL: 'http://127.0.0.1:3000',
    testCase: { id: 'checkout', title: 'Checkout happy path' },
    trace: {
      turns: [
        { status: 'ok', action: { type: 'goto', path: '/checkout' } },
        { status: 'ok', action: { type: 'fill', locatorCandidates: [{ placeholder: 'Email' }], value: 'user@example.com' } },
        { status: 'ok', action: { type: 'select', locatorCandidates: ['select[name="size"]'], value: 'M' } },
        { status: 'ok', action: { type: 'click', locatorCandidates: [{ testId: 'submit-order' }] } },
        { status: 'ok', action: { type: 'assertText', locatorCandidates: ['body'], text: 'Order confirmed' } },
        { status: 'ok', action: { type: 'assertURL', path: '/orders' } },
        { status: 'ok', action: { type: 'apiRequest', method: 'GET', path: '/api/orders' } },
      ],
    },
  });

  assert.match(content, /page\.getByPlaceholder\("Email"\)\.first\(\)\.fill/);
  assert.match(content, /page\.locator\("select\[name=\\"size\\"\]"\)\.first\(\)\.selectOption/);
  assert.match(content, /page\.getByTestId\("submit-order"\)\.first\(\)\.click/);
  assert.match(content, /toContainText\("Order confirmed"\)/);
  assert.ok(content.includes('await expect(page).toHaveURL(new RegExp("/orders"));'));
  assert.match(content, /request\.get\("http:\/\/127\.0\.0\.1:3000\/api\/orders"\)/);
});

test('buildSpecFromTrace understands shorthand locator objects from turn API', () => {
  const content = buildSpecFromTrace({
    baseURL: 'http://localhost:3000',
    testCase: { id: 'login', title: 'Login works' },
    trace: {
      turns: [
        { status: 'ok', action: { type: 'goto', path: '/login' } },
        { status: 'ok', action: { type: 'fill', locatorCandidates: [{ css: '#email' }], value: 'user@example.com' } },
        { status: 'ok', action: { type: 'fill', locatorCandidates: [{ label: 'Password' }], value: 'secret' } },
        { status: 'ok', action: { type: 'click', locatorCandidates: [{ role: 'button', name: 'Sign In' }] } },
        { status: 'ok', action: { type: 'assertVisible', locatorCandidates: [{ placeholder: 'Search' }] } },
      ],
    },
  });

  assert.match(content, /page\.locator\("#email"\)/);
  assert.match(content, /page\.getByLabel\("Password"\)/);
  assert.match(content, /page\.getByRole\("button", \{ name: "Sign In" \}\)/);
  assert.match(content, /page\.getByPlaceholder\("Search"\)/);
});

test('buildSpecFromTrace keeps loopback goto actions on the configured base origin', () => {
  const content = buildSpecFromTrace({
    baseURL: 'http://127.0.0.1:3005',
    testCase: { id: 'loopback', title: 'Loopback host normalization' },
    trace: {
      turns: [
        { status: 'ok', action: { type: 'goto', url: 'http://localhost:3005/login' } },
        { status: 'ok', action: { type: 'assertURL', path: '/login' } },
      ],
    },
  });

  assert.match(content, /http:\/\/127\.0\.0\.1:3005\/login/);
  assert.doesNotMatch(content, /http:\/\/localhost:3005\/login/);
});

test('buildSpecFromTrace emits skipped spec for blocked cases', () => {
  const content = buildSpecFromTrace({
    baseURL: 'http://localhost:3000',
    testCase: { id: 'auth-admin', title: 'Admin auth' },
    trace: { turns: [] },
    blockedReason: 'login form not found',
  });

  assert.match(content, /test\.skip/);
  assert.match(content, /login form not found/);
});
