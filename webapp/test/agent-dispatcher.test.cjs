'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf-8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './openai-generator') {
      return { OpenAITestGenerator: class OpenAITestGenerator {} };
    }
    if (request === './planner-agent') {
      return {
        isPlannerAgentEnabled: () => false,
        runPlannerAgent: async () => null,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(outputText, filename);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const { planAgents } = loadTypeScriptModule('src/lib/test-generation/agent-dispatcher.ts');

test('planAgents selects only API-focused agents for apiOnly projects', () => {
  assert.deepEqual(
    planAgents({
      testType: 'both',
      projectInfo: { apiOnly: true },
      context: { errorScenarios: [{ name: 'bad token' }] },
      options: { includeErrorStates: true },
    }).agents,
    ['api', 'error'],
  );

  assert.deepEqual(
    planAgents({
      testType: 'both',
      projectInfo: { apiOnly: true },
      context: { pages: [{ path: '/' }], workflows: [{ name: 'login' }] },
      options: { includeErrorStates: true },
    }).agents,
    ['api'],
  );
});

test('planAgents pins frontend/backend/both contextual planning', () => {
  assert.deepEqual(
    planAgents({
      testType: 'frontend',
      context: { pages: [{ path: '/' }], apiEndpoints: [{ path: '/api/health' }] },
      options: { includeSmoke: true, includeWorkflows: true, includeErrorStates: true },
    }).agents,
    ['smoke', 'frontend'],
  );

  assert.deepEqual(
    planAgents({
      testType: 'backend',
      context: { pages: [{ path: '/' }], apiEndpoints: [{ path: '/api/health' }] },
      options: { includeSmoke: true, includeWorkflows: true, includeErrorStates: true },
    }).agents,
    ['smoke', 'api'],
  );

  assert.deepEqual(
    planAgents({
      testType: 'both',
      context: {
        pages: [{ path: '/' }],
        apiEndpoints: [{ path: '/api/health' }],
        workflows: [{ name: 'checkout' }],
        errorScenarios: [{ name: 'invalid payment' }],
      },
      options: { includeSmoke: true, includeWorkflows: true, includeErrorStates: true },
    }).agents,
    ['smoke', 'frontend', 'api', 'workflow', 'error'],
  );
});

test('planAgents falls back to smoke and can infer frontend from PRD or exploration', () => {
  assert.deepEqual(
    planAgents({
      testType: 'backend',
      context: {},
      options: { includeSmoke: false },
    }).agents,
    ['smoke'],
  );

  assert.deepEqual(
    planAgents({
      testType: 'frontend',
      context: {},
      explorationArtifact: { authFlow: {} },
      options: { includeSmoke: false },
    }).agents,
    ['frontend'],
  );
});
