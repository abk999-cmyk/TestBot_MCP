'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyMouseCursorOverlayToGeneratedTests,
  buildAgentHealth,
  pickAgentsForRun,
} = require('../src/pipeline-worker');

function makeProject(t) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-pipeline-'));
  fs.mkdirSync(path.join(projectPath, 'tests', 'generated'), { recursive: true });
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  return projectPath;
}

test('pickAgentsForRun mirrors webapp dispatcher for api-only and contextual runs', () => {
  assert.deepEqual(
    pickAgentsForRun(
      'backend',
      { apiOnly: true },
      { errorScenarios: [{ name: 'bad token' }] },
      null,
      null,
      { includeErrorStates: true },
    ),
    ['api', 'error'],
  );

  assert.deepEqual(
    pickAgentsForRun(
      'both',
      {},
      {
        pages: [{ path: '/' }],
        apiEndpoints: [{ path: '/api/health' }],
        workflows: [{ name: 'checkout' }],
        errorScenarios: [{ name: 'invalid card' }],
      },
      null,
      null,
      { includeSmoke: true, includeWorkflows: true, includeErrorStates: true },
    ),
    ['smoke', 'frontend', 'api', 'workflow', 'error'],
  );

  assert.deepEqual(
    pickAgentsForRun('frontend', {}, {}, null, { authFlow: {} }, { includeSmoke: false }),
    ['frontend'],
  );

  assert.deepEqual(
    pickAgentsForRun('backend', {}, {}, null, null, { includeSmoke: false }),
    ['smoke'],
  );
});

test('buildAgentHealth accounts for completed, failed, missing, and all-failed states', () => {
  const partial = buildAgentHealth({
    agents: ['smoke', 'api', 'workflow'],
    agentsCompleted: ['smoke'],
    agentFailures: [{ agent: 'api', code: 'TIMEOUT', message: 'timed out' }],
    files: [{ agent: 'smoke' }, { agent: 'smoke' }],
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.partialSuccess, true);
  assert.deepEqual(partial.missingAgents, ['workflow']);
  assert.deepEqual(partial.filesByAgent, { smoke: 2 });

  const accountedPartial = buildAgentHealth({
    agents: ['smoke', 'api'],
    agentsCompleted: ['smoke'],
    agentFailures: [{ agent: 'api', code: 'TIMEOUT', message: 'timed out' }],
    files: [{ agent: 'smoke' }],
  });
  assert.equal(accountedPartial.ok, true);
  assert.equal(accountedPartial.partialSuccess, true);

  const allFailed = buildAgentHealth({
    agents: ['smoke', 'api'],
    agentsCompleted: [],
    agentFailures: [
      { agent: 'smoke', code: 'FAILED', message: 'failed' },
      { agent: 'api', code: 'FAILED', message: 'failed' },
    ],
    files: [],
  });
  assert.equal(allFailed.ok, false);
  assert.equal(allFailed.allAgentsFailed, true);
});

test('cursor overlay patch rewrites generated specs only when enabled', (t) => {
  const disabledProject = makeProject(t);
  const disabledSpec = path.join(disabledProject, 'tests', 'generated', 'disabled.spec.ts');
  const specSource = "import { test, expect } from '@playwright/test';\n\ntest('disabled', async ({ page }) => { await page.goto('/'); });\n";
  fs.writeFileSync(disabledSpec, specSource, 'utf-8');

  const disabled = applyMouseCursorOverlayToGeneratedTests({ projectPath: disabledProject, enabled: false });
  assert.deepEqual(disabled, { enabled: false, reason: 'disabled' });
  assert.equal(fs.readFileSync(disabledSpec, 'utf-8'), specSource);

  const enabledProject = makeProject(t);
  const enabledSpec = path.join(enabledProject, 'tests', 'generated', 'enabled.spec.ts');
  fs.writeFileSync(enabledSpec, specSource, 'utf-8');

  const enabled = applyMouseCursorOverlayToGeneratedTests({ projectPath: enabledProject, enabled: true });
  const patched = fs.readFileSync(enabledSpec, 'utf-8');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.patchedFiles, 1);
  assert.match(patched, /from '\.\/__healix-fixture'/);
  assert.doesNotMatch(patched, /from '@playwright\/test'/);
});
