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
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(outputText, filename);
  return mod.exports;
}

const {
  ACTION_TYPES,
  SequentialActionSchema,
  NextActionRequestSchema,
  SynthesizeSpecRequestSchema,
  extractJsonObject,
  fallbackActionForRequest,
  sanitizeFilename,
} = loadTypeScriptModule('src/lib/test-generation/turn-contract.ts');

test('ACTION_TYPES contains only the sequential action contract surface', () => {
  assert.deepEqual(ACTION_TYPES, [
    'goto',
    'click',
    'fill',
    'select',
    'assertVisible',
    'assertText',
    'assertURL',
    'apiRequest',
    'finish',
  ]);
});

test('SequentialActionSchema accepts shorthand locator objects and rejects unknown actions', () => {
  const valid = SequentialActionSchema.safeParse({
    type: 'click',
    locatorCandidates: [
      { css: '#submit' },
      { role: 'button', name: 'Submit' },
      { label: 'Email' },
      { placeholder: 'Search' },
      { testId: 'submit-order' },
    ],
    timeoutMs: 5000,
    rationale: 'Click the stable submit button.',
  });

  assert.equal(valid.success, true);
  assert.equal(SequentialActionSchema.safeParse({ type: 'hover' }).success, false);
  assert.equal(SequentialActionSchema.safeParse({ type: 'goto', timeoutMs: 10 }).success, false);
});

test('NextActionRequestSchema applies defaults for optional turn context', () => {
  const parsed = NextActionRequestSchema.parse({
    testCase: { id: 'case-1', title: 'Case one' },
    observation: {},
  });

  assert.deepEqual(parsed.history, []);
  assert.deepEqual(parsed.projectInfo, {});
  assert.deepEqual(parsed.roles, []);
  assert.deepEqual(parsed.options, {});
});

test('SynthesizeSpecRequestSchema accepts minimal successful trace payloads', () => {
  const parsed = SynthesizeSpecRequestSchema.parse({
    testCase: { id: 'case-1', title: 'Case one' },
    trace: { turns: [{ action: { type: 'goto', path: '/' }, status: 'ok' }] },
  });

  assert.equal(parsed.testCase.id, 'case-1');
  assert.equal(parsed.trace.turns.length, 1);
  assert.deepEqual(parsed.roles, []);
});

test('extractJsonObject handles raw JSON, fenced JSON, and prefixed model text', () => {
  assert.deepEqual(extractJsonObject('{"action":{"type":"finish"}}'), { action: { type: 'finish' } });
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJsonObject('Here is the JSON:\n{"ok":true}\nDone.'), { ok: true });
  assert.throws(() => extractJsonObject('no json here'), /response did not contain a JSON object/);
});

test('fallbackActionForRequest advances API and UI smoke paths deterministically', () => {
  assert.deepEqual(
    fallbackActionForRequest({
      testCase: { id: 'api', title: 'API', kind: 'api', path: '/api/health' },
      observation: {},
      history: [],
      projectInfo: {},
      roles: [],
      options: {},
    }),
    { type: 'apiRequest', method: 'GET', path: '/api/health', rationale: 'Probe API endpoint.' },
  );
  assert.deepEqual(
    fallbackActionForRequest({
      testCase: { id: 'api', title: 'API', kind: 'api', path: '/api/health' },
      observation: {},
      history: [{}],
      projectInfo: {},
      roles: [],
      options: {},
    }),
    { type: 'finish', summary: 'API endpoint probe completed.' },
  );
  assert.equal(
    fallbackActionForRequest({
      testCase: { id: 'ui', title: 'UI', kind: 'ui', path: '/shop' },
      observation: {},
      history: [],
      projectInfo: {},
      roles: [],
      options: {},
    }).path,
    '/shop',
  );
  assert.equal(
    fallbackActionForRequest({
      testCase: { id: 'ui', title: 'UI', kind: 'ui', path: '/shop' },
      observation: {},
      history: [{}],
      projectInfo: {},
      roles: [],
      options: {},
    }).type,
    'assertVisible',
  );
});

test('sanitizeFilename produces bounded spec filenames', () => {
  assert.equal(sanitizeFilename('My generated spec', 'fallback'), 'my-generated-spec.spec.ts');
  assert.equal(sanitizeFilename('already.spec.ts', 'fallback'), 'already.spec.ts');
  assert.equal(sanitizeFilename('', 'fallback'), 'fallback.spec.ts');
  assert.ok(sanitizeFilename('x'.repeat(200), 'fallback').length <= 128);
});
