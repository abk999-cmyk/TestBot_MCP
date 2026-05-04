'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PlaywrightIntegration = require('../src/playwright-integration');

function makeProject(t) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-pw-'));
  fs.mkdirSync(path.join(projectPath, 'tests', 'generated'), { recursive: true });
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  return projectPath;
}

test('generated Healix Playwright config defaults video capture to on', (t) => {
  const projectPath = makeProject(t);
  const runner = new PlaywrightIntegration({
    projectPath,
    baseURL: 'http://127.0.0.1:3000',
  });

  const configPath = runner.ensureGeneratedPlaywrightConfig();
  const body = fs.readFileSync(configPath, 'utf-8');

  assert.match(configPath, /\.healix[/\\]playwright\.config\.generated\.cjs$/);
  assert.match(body, /baseURL: "http:\/\/127\.0\.0\.1:3000"/);
  assert.match(body, /video: 'on'/);
  assert.match(body, /screenshot: 'only-on-failure'/);
});

test('videoMode retain-on-failure preserves legacy video policy', (t) => {
  const projectPath = makeProject(t);
  const runner = new PlaywrightIntegration({
    projectPath,
    baseURL: 'http://127.0.0.1:3000',
    videoMode: 'retain-on-failure',
  });

  assert.equal(runner.getArtifactPolicy().video, 'retain-on-failure');

  const configPath = runner.ensureGeneratedPlaywrightConfig();
  const body = fs.readFileSync(configPath, 'utf-8');
  assert.match(body, /video: 'retain-on-failure'/);
});

test('Healix execution uses generated config even when project has its own Playwright config', (t) => {
  const projectPath = makeProject(t);
  const userConfigPath = path.join(projectPath, 'playwright.config.ts');
  fs.writeFileSync(userConfigPath, 'export default { use: { video: "off" } }\n', 'utf-8');

  const runner = new PlaywrightIntegration({
    projectPath,
    baseURL: 'http://127.0.0.1:3000',
    videoMode: 'on',
  });

  const resolved = runner.resolvePlaywrightConfig();
  assert.match(resolved, /\.healix[/\\]playwright\.config\.generated\.cjs$/);
  assert.equal(fs.readFileSync(userConfigPath, 'utf-8'), 'export default { use: { video: "off" } }\n');
});

test('real Playwright smoke run produces a non-empty webm video', { timeout: 180_000 }, async (t) => {
  const projectPath = makeProject(t);
  const specPath = path.join(projectPath, 'tests', 'generated', 'video-smoke.spec.js');
  fs.writeFileSync(specPath, `
const { test, expect } = require('@playwright/test');

test('records video for passing generated spec', async ({ page }) => {
  await page.goto('data:text/html,<main><h1>Ready</h1><button>Go</button></main>');
  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
});
`, 'utf-8');

  const runner = new PlaywrightIntegration({
    projectPath,
    baseURL: 'http://127.0.0.1:1',
    phaseMode: 'single',
    videoMode: 'on',
    timeout: 180_000,
    playwrightRetries: 0,
  });

  const results = await runner.executePlaywright({
    outputDir: path.join(projectPath, 'test-results'),
  });

  assert.equal(results.total, 1);
  assert.equal(results.failed, 0);
  const videos = (results.tests || []).flatMap((item) => item.artifacts?.videos || []);
  assert.ok(videos.length >= 1, 'expected at least one video attachment');

  for (const video of videos) {
    const videoPath = path.isAbsolute(video.path)
      ? video.path
      : path.resolve(projectPath, video.path);
    assert.ok(fs.existsSync(videoPath), `video does not exist: ${videoPath}`);
    assert.ok(fs.statSync(videoPath).size > 0, `video is empty: ${videoPath}`);
  }
});
