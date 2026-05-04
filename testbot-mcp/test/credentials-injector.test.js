'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  authDirFor,
  stateFileFor,
  loginUrlCandidates,
  injectCredentials,
} = require('../src/credentials-injector');

test('loginUrlCandidates prioritizes discovered auth flow then common login routes before root', () => {
  const candidates = loginUrlCandidates('http://127.0.0.1:3000/app', { loginUrl: '/custom-login' });

  assert.equal(candidates[0], 'http://127.0.0.1:3000/custom-login');
  assert.equal(candidates[1], 'http://127.0.0.1:3000/login');
  assert.equal(candidates.at(-1), 'http://127.0.0.1:3000/');
  assert.equal(new Set(candidates).size, candidates.length);
});

test('loginUrlCandidates falls back to root only after real login route probes', () => {
  const candidates = loginUrlCandidates('http://localhost:5173');

  assert.deepEqual(candidates.slice(0, 5), [
    'http://localhost:5173/login',
    'http://localhost:5173/signin',
    'http://localhost:5173/sign-in',
    'http://localhost:5173/auth/login',
    'http://localhost:5173/admin/login',
  ]);
  assert.equal(candidates[5], 'http://localhost:5173/');
});

test('stateFileFor sanitizes role labels and keeps auth state under .healix', () => {
  const projectPath = '/tmp/healix-project';
  const statePath = stateFileFor(projectPath, 'admin/user 1');

  assert.equal(authDirFor(projectPath), path.join(projectPath, '.healix'));
  assert.equal(statePath, path.join(projectPath, '.healix', 'auth-state-admin_user_1.json'));
});

test('injectCredentials skips empty credential lists without creating auth artifacts', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-creds-'));
  try {
    const roles = await injectCredentials({
      projectPath,
      baseURL: 'http://127.0.0.1:3000',
      credentials: [],
    });

    assert.deepEqual(roles, []);
    assert.equal(fs.existsSync(authDirFor(projectPath)), false);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('injectCredentials ignores malformed credential entries but creates protected auth dir', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-creds-'));
  try {
    const roles = await injectCredentials({
      projectPath,
      baseURL: 'http://127.0.0.1:3000',
      credentials: [{ role: 'admin' }, { username: 'missing-password@example.com' }],
    });

    assert.deepEqual(roles, []);
    assert.equal(fs.readFileSync(path.join(authDirFor(projectPath), '.gitignore'), 'utf-8'), '*\n!.gitignore\n');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
