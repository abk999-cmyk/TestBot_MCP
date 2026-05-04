'use strict';

/**
 * Per-role credential injector. For each entry in `testCredentials`, drive a
 * headless Playwright login against the `authFlow` observed by exploration (or
 * supplied in config) and persist the resulting `storageState` to
 * `.healix/auth-state-<role>.json`.
 *
 * Output:
 *   [{ role, storageStatePath, loginVerified, reason? }, ...]
 *
 * Behaviour when exploration hasn't found an authFlow:
 *   - Return an empty roles array. Tier B tests won't be run, but Tier A and
 *     Tier C continue. This matches the "partial green" promise in the plan.
 *
 * Credentials NEVER leave the user's machine:
 *   - Written to `.healix/` which is in the artifact-uploader deny-list.
 *   - Dashboard record stores only role labels + `loginVerified`.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

const AUTH_DIR_NAME = '.healix';
const STATE_FILE_PREFIX = 'auth-state-';

function authDirFor(projectPath) {
  return path.join(projectPath, AUTH_DIR_NAME);
}

function stateFileFor(projectPath, role) {
  const safeRole = String(role || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(authDirFor(projectPath), `${STATE_FILE_PREFIX}${safeRole}.json`);
}

function ensureAuthDir(projectPath) {
  const dir = authDirFor(projectPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, '*\n!.gitignore\n', 'utf-8');
    } catch { /* non-fatal */ }
  }
  return dir;
}

function loginUrlCandidates(baseURL, authFlow = null) {
  const candidates = [];
  if (authFlow?.loginUrl) candidates.push(new URL(authFlow.loginUrl, baseURL).toString());
  for (const pathname of ['/login', '/signin', '/sign-in', '/auth/login', '/admin/login', '/']) {
    try {
      candidates.push(new URL(pathname, baseURL).toString());
    } catch {
      // ignore malformed fallback
    }
  }
  return Array.from(new Set(candidates));
}

async function openFirstLoginForm(page, { baseURL, authFlow, userField }) {
  const candidates = loginUrlCandidates(baseURL, authFlow);
  let lastError = null;
  for (const loginUrl of candidates) {
    try {
      await page.goto(loginUrl, { waitUntil: 'load', timeout: 30_000 });
      await page.locator(userField).first().waitFor({ state: 'visible', timeout: 7_500 });
      return {
        loginUrl,
        loginPathname: (() => { try { return new URL(loginUrl).pathname; } catch { return loginUrl; } })(),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`No login form found at candidates: ${candidates.join(', ')}`);
}

/**
 * Drive a login with Playwright. Returns true if post-login state shows the
 * `successIndicator` and not the `failureIndicator`. We use Playwright via
 * runtime require so missing deps fall through to a clear error, not a crash.
 */
async function driveLogin({ baseURL, authFlow, credentials, storageStatePath }) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { ok: false, reason: 'playwright not installed — cannot drive login' };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const userField = authFlow?.credentialFields?.username || 'input[type="email"], input[name="email"], input[name="username"]';
    const passField = authFlow?.credentialFields?.password || 'input[type="password"], input[name="password"]';

    // Use `load` not `networkidle` — Next.js/Supabase apps have persistent background
    // fetches that can prevent networkidle from firing within any reasonable timeout.
    // When exploration did not discover authFlow, try common login routes before
    // falling back to the app root. Treating baseURL as the login page is what
    // caused every downstream auth-gated test to fail on apps with /login routes.
    const { loginPathname } = await openFirstLoginForm(page, { baseURL, authFlow, userField });

    await page.fill(userField, credentials.username, { timeout: 10_000 });
    await page.fill(passField, credentials.password, { timeout: 10_000 });

    const submit = page.locator('button[type="submit"], input[type="submit"]').first();

    // Wait for SPA navigation to complete. Supabase fires router.replace() in the
    // .then() of signInWithPassword — this is async and fires AFTER the API response,
    // so networkidle can resolve before the redirect. waitForURL is the only reliable
    // signal that the auth flow has actually completed.
    await Promise.all([
      page.waitForURL(
        (url) => { try { return url.pathname !== loginPathname; } catch { return false; } },
        { timeout: 20_000 }
      ).catch(() => null),
      submit.click({ timeout: 10_000 }),
    ]);

    // Allow middleware chain redirects (e.g. /admin → / for non-admin users) to settle.
    await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => null);

    // Primary signal: URL must have changed away from the login page.
    // A successful Supabase auth always redirects; staying on the same page means failure.
    const finalPathname = (() => { try { return new URL(page.url()).pathname; } catch { return loginPathname; } })();
    let loginVerified = finalPathname !== loginPathname;

    // Secondary signal: if a custom success indicator was provided, that overrides.
    if (authFlow?.successIndicator) {
      loginVerified = await page.locator(authFlow.successIndicator).first().isVisible({ timeout: 5_000 }).catch(() => false);
    } else if (loginVerified && authFlow?.failureIndicator) {
      // URL changed but still check no failure banner appeared (e.g. wrong-role redirect to error page)
      const failureVisible = await page.locator(authFlow.failureIndicator).first().isVisible({ timeout: 1_000 }).catch(() => false);
      if (failureVisible) loginVerified = false;
    }

    if (!loginVerified) {
      return { ok: false, reason: 'Login success indicator not detected post-submit' };
    }

    await context.storageState({ path: storageStatePath });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Login driver error: ${err.message}` };
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

async function injectCredentials({
  projectPath,
  baseURL,
  credentials = [],
  authFlow = null,
} = {}) {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    Logger.info('CredentialsInjector', 'no credentials provided — skipping');
    return [];
  }
  ensureAuthDir(projectPath);

  const roles = [];
  for (const cred of credentials) {
    if (!cred?.username || !cred?.password) continue;
    const role = cred.role || 'user';
    const storageStatePath = stateFileFor(projectPath, role);

    const result = await driveLogin({ baseURL, authFlow, credentials: cred, storageStatePath });
    if (result.ok) {
      Logger.info('CredentialsInjector', `Login verified for role=${role}`, { storageStatePath });
      roles.push({ role, storageStatePath, loginVerified: true });
    } else {
      Logger.warn('CredentialsInjector', `Login failed for role=${role}`, { reason: result.reason });
      roles.push({ role, storageStatePath: null, loginVerified: false, reason: result.reason });
    }
  }
  return roles;
}

module.exports = {
  injectCredentials,
  authDirFor,
  stateFileFor,
  loginUrlCandidates,
};
