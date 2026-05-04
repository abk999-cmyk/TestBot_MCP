'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const HealixMCPServer = require('../src/index');

test('test strategy defaults to sequential and preserves script fallback', () => {
  const server = new HealixMCPServer();
  assert.equal(server.resolveTestStrategy(), 'sequential');
  assert.equal(server.resolveTestStrategy('script'), 'script');
  assert.equal(server.resolveTestStrategy('SCRIPT'), 'script');
  assert.equal(server.resolveTestStrategy(' sequential '), 'sequential');
  assert.equal(server.resolveTestStrategy('unknown'), 'sequential');
});

test('test strategy can default from HEALIX_TEST_STRATEGY', (t) => {
  const original = process.env.HEALIX_TEST_STRATEGY;
  t.after(() => {
    if (original === undefined) delete process.env.HEALIX_TEST_STRATEGY;
    else process.env.HEALIX_TEST_STRATEGY = original;
  });

  process.env.HEALIX_TEST_STRATEGY = 'script';
  assert.equal(new HealixMCPServer().resolveTestStrategy(), 'script');
  process.env.HEALIX_TEST_STRATEGY = 'bad-value';
  assert.equal(new HealixMCPServer().resolveTestStrategy(), 'sequential');
});

test('videoMode defaults to on and preserves retain-on-failure fallback', (t) => {
  const original = process.env.HEALIX_VIDEO_MODE;
  t.after(() => {
    if (original === undefined) delete process.env.HEALIX_VIDEO_MODE;
    else process.env.HEALIX_VIDEO_MODE = original;
  });

  const server = new HealixMCPServer();
  assert.equal(server.resolveVideoMode(), 'on');
  assert.equal(server.resolveVideoMode('retain-on-failure'), 'retain-on-failure');
  assert.equal(server.resolveVideoMode('bad-value'), 'on');
  process.env.HEALIX_VIDEO_MODE = 'retain-on-failure';
  assert.equal(new HealixMCPServer().resolveVideoMode(), 'retain-on-failure');
});

test('direct run config requires baseURL and startCommand', () => {
  const server = new HealixMCPServer();
  assert.equal(server.hasDirectRunConfig({ baseURL: 'http://localhost:3000' }), false);
  assert.equal(server.hasDirectRunConfig({ startCommand: 'npm run dev' }), false);
  assert.equal(server.hasDirectRunConfig({ baseURL: '   ', startCommand: 'npm run dev' }), false);
  assert.equal(server.hasDirectRunConfig({ baseURL: 'http://localhost:3000', startCommand: '  ' }), false);
  assert.equal(server.hasDirectRunConfig({
    baseURL: 'http://localhost:3000',
    startCommand: 'npm run dev',
  }), true);
});

test('direct submission carries credentials without launching config UI', () => {
  const server = new HealixMCPServer();
  const submission = server.buildDirectUISubmission(
    {
      testType: 'both',
      baseURL: 'http://localhost:3000',
      startCommand: 'npm run dev',
      generateTests: true,
      openDashboard: true,
    },
    {
      baseURL: 'http://localhost:3001',
      startCommand: 'npm run dev -- -p 3001',
      credentials: [{ role: 'admin', username: 'admin@example.com', password: 'pw' }],
    },
  );

  assert.equal(submission.baseURL, 'http://localhost:3001');
  assert.equal(submission.startCommand, 'npm run dev -- -p 3001');
  assert.equal(submission.credentials[0].role, 'admin');
  assert.equal(submission.generateTests, true);
  assert.equal(submission.openDashboard, true);
  assert.equal(submission.videoMode, 'on');
  assert.equal(submission.prd, null);
  assert.equal(submission.prdFiles, null);
});

test('direct submission carries explicit videoMode', () => {
  const server = new HealixMCPServer();
  const submission = server.buildDirectUISubmission(
    {
      testType: 'both',
      baseURL: 'http://localhost:3000',
      startCommand: 'npm run dev',
      videoMode: 'on',
    },
    {
      videoMode: 'retain-on-failure',
    },
  );

  assert.equal(submission.videoMode, 'retain-on-failure');
});

test('direct submission preserves explicit disabled generation/dashboard flags', () => {
  const server = new HealixMCPServer();
  const submission = server.buildDirectUISubmission(
    {
      testType: 'frontend',
      baseURL: 'http://localhost:3000',
      startCommand: 'npm run dev',
    },
    {
      generateTests: false,
      openDashboard: false,
    },
  );

  assert.equal(submission.testType, 'frontend');
  assert.equal(submission.generateTests, false);
  assert.equal(submission.openDashboard, false);
});

test('headless mode disables browser auto-open even when requested', (t) => {
  const originalHeadless = process.env.HEALIX_HEADLESS;
  const originalAutoOpen = process.env.HEALIX_AUTO_OPEN_BROWSER;
  t.after(() => {
    if (originalHeadless === undefined) delete process.env.HEALIX_HEADLESS;
    else process.env.HEALIX_HEADLESS = originalHeadless;
    if (originalAutoOpen === undefined) delete process.env.HEALIX_AUTO_OPEN_BROWSER;
    else process.env.HEALIX_AUTO_OPEN_BROWSER = originalAutoOpen;
  });

  process.env.HEALIX_HEADLESS = 'true';
  process.env.HEALIX_AUTO_OPEN_BROWSER = 'true';
  const server = new HealixMCPServer();

  assert.equal(server.resolveHeadlessPreference({}), true);
  assert.equal(server.resolveAutoOpenBrowserPreference({ autoOpenBrowser: true }, true), false);
  assert.equal(server.resolveAutoOpenBrowserPreference({ autoOpenBrowser: true }, false), true);
});

test('normalizeCredentials accepts a single credential or array and drops empty entries', () => {
  const server = new HealixMCPServer();

  assert.equal(server.normalizeCredentials(undefined), undefined);
  assert.deepEqual(server.normalizeCredentials({ role: 'admin' }), undefined);
  assert.deepEqual(
    server.normalizeCredentials({ role: 'admin', username: 'admin@example.com', password: 'pw' }),
    [{ role: 'admin', username: 'admin@example.com', password: 'pw' }],
  );
  assert.deepEqual(
    server.normalizeCredentials([
      { role: 'admin', username: 'admin@example.com', password: 'pw' },
      { role: 'empty' },
    ]),
    [{ role: 'admin', username: 'admin@example.com', password: 'pw' }],
  );
});
