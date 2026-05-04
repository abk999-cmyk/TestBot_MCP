'use strict';

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

const ACTION_TYPES = new Set([
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

const DEFAULT_MAX_CASES = 24;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_REPAIRS = 3;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function slugify(value, fallback = 'case') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quote(value) {
  return JSON.stringify(String(value ?? ''));
}

function attrSelector(name, value) {
  return `[${name}="${String(value).replace(/"/g, '\\"')}"]`;
}

function redactCredentialValue(value) {
  if (!value) return value;
  return '***';
}

function redactAction(action) {
  if (!action || typeof action !== 'object') return action;
  const copy = { ...action };
  if (copy.value && /pass|secret|token/i.test(String(copy.field || copy.target || copy.type || ''))) {
    copy.value = redactCredentialValue(copy.value);
  }
  return copy;
}

function normalizeLocatorCandidates(action) {
  const raw = action?.locatorCandidates || action?.locators || action?.selectors || action?.target;
  if (Array.isArray(raw)) return raw.filter(Boolean).slice(0, 8);
  if (raw) return [raw];
  return [];
}

function candidateToSelector(candidate, fallback = 'body') {
  if (!candidate) return fallback;
  if (typeof candidate === 'object') {
    if (candidate.css) return String(candidate.css);
    if (candidate.selector) return String(candidate.selector);
    if (candidate.testId || candidate.testid || candidate['test-id'] || candidate.dataTestId) {
      return attrSelector('data-testid', candidate.testId || candidate.testid || candidate['test-id'] || candidate.dataTestId);
    }
    if (candidate.name && !candidate.role && !candidate.type) {
      return attrSelector('name', candidate.name);
    }
    const type = String(candidate.type || '').toLowerCase();
    const value = String(candidate.value || candidate.name || candidate.label || candidate.placeholder || candidate.text || '');
    if (!value) return fallback;
    if (type === 'testid' || type === 'test-id') return attrSelector('data-testid', value);
    if (type === 'text') return `text=${value}`;
    if (type === 'label' || candidate.label) return `input[aria-label="${value.replace(/"/g, '\\"')}"], textarea[aria-label="${value.replace(/"/g, '\\"')}"]`;
    if (type === 'placeholder' || candidate.placeholder) return attrSelector('placeholder', value);
    return value;
  }
  return String(candidate);
}

function candidateToLocatorCode(candidate, fallback = 'body') {
  if (!candidate || typeof candidate !== 'object') {
    return `page.locator(${quote(candidateToSelector(candidate, fallback))})`;
  }

  const exact = candidate.exact === true ? ', { exact: true }' : '';
  if (candidate.css) return `page.locator(${quote(candidate.css)})`;
  if (candidate.selector) return `page.locator(${quote(candidate.selector)})`;
  if (candidate.label) return `page.getByLabel(${quote(candidate.label)}${exact})`;
  if (candidate.placeholder) return `page.getByPlaceholder(${quote(candidate.placeholder)}${exact})`;
  if (candidate.testId || candidate.testid || candidate['test-id'] || candidate.dataTestId) {
    return `page.getByTestId(${quote(candidate.testId || candidate.testid || candidate['test-id'] || candidate.dataTestId)})`;
  }
  if (candidate.text) return `page.getByText(${quote(candidate.text)}${exact})`;
  if (candidate.role) {
    const role = String(candidate.role);
    const name = candidate.name || candidate.text || candidate.label;
    if (name) return `page.getByRole(${quote(role)}, { name: ${quote(name)}${candidate.exact === true ? ', exact: true' : ''} })`;
    return `page.getByRole(${quote(role)})`;
  }

  const type = String(candidate.type || '').toLowerCase();
  const value = candidate.value || candidate.name || candidate.selector;
  if (type === 'label') return `page.getByLabel(${quote(value)}${exact})`;
  if (type === 'placeholder') return `page.getByPlaceholder(${quote(value)}${exact})`;
  if (type === 'testid' || type === 'test-id') return `page.getByTestId(${quote(value)})`;
  if (type === 'text') return `page.getByText(${quote(value)}${exact})`;
  if (type === 'role') return `page.getByRole(${quote(value)})`;
  return `page.locator(${quote(candidateToSelector(candidate, fallback))})`;
}

function validateSequentialAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, reason: 'Action must be an object' };
  }
  if (!ACTION_TYPES.has(action.type)) {
    return { ok: false, reason: `Unsupported action type: ${String(action.type)}` };
  }
  if (action.type === 'goto' && !action.url && !action.path) {
    return { ok: false, reason: 'goto action requires url or path' };
  }
  if (['click', 'fill', 'select', 'assertVisible', 'assertText'].includes(action.type)) {
    if (normalizeLocatorCandidates(action).length === 0) {
      return { ok: false, reason: `${action.type} action requires locatorCandidates` };
    }
  }
  if (action.type === 'fill' && typeof action.value !== 'string') {
    return { ok: false, reason: 'fill action requires string value' };
  }
  if (action.type === 'select' && (action.value === undefined || action.value === null)) {
    return { ok: false, reason: 'select action requires value' };
  }
  if (action.type === 'apiRequest' && !action.url && !action.path) {
    return { ok: false, reason: 'apiRequest action requires url or path' };
  }
  return { ok: true };
}

function isFatalTurnServiceError(message) {
  const text = String(message || '');
  return (
    /\/api\/test-turns\/next-action failed \((401|402|403|429)\)/i.test(text)
    || /No tokens remaining/i.test(text)
    || /Missing api_key/i.test(text)
    || /Invalid or inactive API key/i.test(text)
    || /API key has (expired|been revoked)/i.test(text)
    || /RATE_LIMIT_EXCEEDED|CONCURRENT_LIMIT_EXCEEDED/i.test(text)
  );
}

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());
}

function joinUrl(baseURL, target) {
  const raw = String(target || '/');
  try {
    const base = new URL(baseURL);
    const resolved = new URL(raw, base);
    if (
      isLoopbackHost(base.hostname)
      && isLoopbackHost(resolved.hostname)
      && base.protocol === resolved.protocol
      && base.port === resolved.port
    ) {
      resolved.hostname = base.hostname;
    }
    return resolved.toString();
  } catch {
    return raw;
  }
}

function locatorFromCandidate(page, candidate) {
  if (!candidate) return null;
  if (typeof candidate === 'object') {
    if (candidate.css) return page.locator(String(candidate.css));
    if (candidate.selector) return page.locator(String(candidate.selector));
    if (candidate.label) return page.getByLabel(String(candidate.label), { exact: candidate.exact === true });
    if (candidate.placeholder) return page.getByPlaceholder(String(candidate.placeholder), { exact: candidate.exact === true });
    if (candidate.testId || candidate.testid || candidate['test-id'] || candidate.dataTestId) {
      return page.getByTestId(String(candidate.testId || candidate.testid || candidate['test-id'] || candidate.dataTestId));
    }
    if (candidate.text) return page.getByText(String(candidate.text), { exact: candidate.exact === true });
    if (candidate.role) {
      const role = String(candidate.role);
      const name = candidate.name || candidate.text || candidate.label;
      return page.getByRole(role, name ? { name: String(name), exact: candidate.exact === true } : undefined);
    }

    const type = String(candidate.type || '').toLowerCase();
    const value = String(candidate.value || candidate.name || candidate.selector || '');
    const exact = candidate.exact === true;
    if (!value) return null;
    if (type === 'role') return page.getByRole(value, candidate.name ? { name: candidate.name, exact } : undefined);
    if (type === 'label') return page.getByLabel(value, { exact });
    if (type === 'placeholder') return page.getByPlaceholder(value, { exact });
    if (type === 'testid' || type === 'test-id') return page.getByTestId(value);
    if (type === 'text') return page.getByText(value, { exact });
    if (type === 'css' || type === 'selector') return page.locator(value);
    return page.locator(value);
  }

  const raw = String(candidate).trim();
  if (!raw) return null;
  const [prefix, ...rest] = raw.split('=');
  const value = rest.join('=').trim();
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (value && normalizedPrefix === 'text') return page.getByText(value);
  if (value && normalizedPrefix === 'label') return page.getByLabel(value);
  if (value && normalizedPrefix === 'placeholder') return page.getByPlaceholder(value);
  if (value && (normalizedPrefix === 'testid' || normalizedPrefix === 'test-id')) return page.getByTestId(value);
  if (value && normalizedPrefix === 'role') return page.getByRole(value);
  if (value && (normalizedPrefix === 'css' || normalizedPrefix === 'selector')) return page.locator(value);
  return page.locator(raw);
}

async function firstWorkingLocator(page, candidates, timeoutMs) {
  let lastError = null;
  for (const candidate of candidates) {
    const locator = locatorFromCandidate(page, candidate);
    if (!locator) continue;
    try {
      await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
      return locator.first();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`No locator matched: ${JSON.stringify(candidates)}`);
}

async function executeSequentialAction({ page, action, baseURL, apiBaseURL }) {
  const timeoutMs = Math.max(1000, Math.min(Number(action.timeoutMs || 8000), 30000));
  const candidates = normalizeLocatorCandidates(action);

  if (action.type === 'goto') {
    const url = joinUrl(baseURL, action.url || action.path);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { ok: true, detail: `Navigated to ${url}` };
  }

  if (action.type === 'click') {
    const locator = await firstWorkingLocator(page, candidates, timeoutMs);
    await locator.click({ timeout: timeoutMs });
    return { ok: true, detail: `Clicked ${JSON.stringify(candidates[0])}` };
  }

  if (action.type === 'fill') {
    const locator = await firstWorkingLocator(page, candidates, timeoutMs);
    await locator.fill(String(action.value), { timeout: timeoutMs });
    return { ok: true, detail: `Filled ${JSON.stringify(candidates[0])}` };
  }

  if (action.type === 'select') {
    const locator = await firstWorkingLocator(page, candidates, timeoutMs);
    await locator.selectOption(String(action.value), { timeout: timeoutMs });
    return { ok: true, detail: `Selected ${String(action.value)}` };
  }

  if (action.type === 'assertVisible') {
    await firstWorkingLocator(page, candidates, timeoutMs);
    return { ok: true, detail: `Visible ${JSON.stringify(candidates[0])}` };
  }

  if (action.type === 'assertText') {
    const locator = await firstWorkingLocator(page, candidates, timeoutMs);
    const text = String(action.text || action.value || '');
    const actual = await locator.textContent({ timeout: timeoutMs }).catch(() => '');
    if (text && !String(actual || '').toLowerCase().includes(text.toLowerCase())) {
      throw new Error(`Expected text "${text}" but saw "${String(actual || '').slice(0, 160)}"`);
    }
    return { ok: true, detail: `Text matched ${text || '(non-empty)'}` };
  }

  if (action.type === 'assertURL') {
    const current = page.url();
    const expected = String(action.url || action.path || action.pattern || '');
    if (expected && !new RegExp(escapeRegex(expected), 'i').test(current)) {
      throw new Error(`Expected URL to include "${expected}" but saw "${current}"`);
    }
    return { ok: true, detail: `URL matched ${expected || current}` };
  }

  if (action.type === 'apiRequest') {
    const fetchFn = global.fetch || require('node-fetch');
    const url = joinUrl(apiBaseURL || baseURL, action.url || action.path);
    const response = await fetchFn(url, {
      method: String(action.method || 'GET').toUpperCase(),
      headers: action.headers || undefined,
      body: action.body ? JSON.stringify(action.body) : undefined,
    });
    const expectedStatus = Number(action.expectedStatus || 0);
    if (expectedStatus && response.status !== expectedStatus) {
      throw new Error(`Expected HTTP ${expectedStatus} but got ${response.status}`);
    }
    if (!expectedStatus && response.status >= 500) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return { ok: true, detail: `HTTP ${response.status} ${url}` };
  }

  if (action.type === 'finish') {
    return { ok: true, detail: action.summary || 'Case finished' };
  }

  throw new Error(`Unhandled action type: ${action.type}`);
}

async function captureObservation(page, screenshotPath = null) {
  const observation = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: '',
    controls: [],
    screenshotPath,
  };

  try {
    observation.text = await page.locator('body').innerText({ timeout: 2000 });
    observation.text = observation.text.replace(/\s+/g, ' ').slice(0, 4000);
  } catch {
    observation.text = '';
  }

  try {
    observation.controls = await page.evaluate(() => {
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 120),
        id: el.id || '',
        name: el.getAttribute('name') || '',
        testId: el.getAttribute('data-testid') || '',
      });
      return Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
        .slice(0, 80)
        .map(describe);
    });
  } catch {
    observation.controls = [];
  }

  if (screenshotPath) {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
    } catch {
      observation.screenshotPath = null;
    }
  }

  return observation;
}

function loginPathCandidates(baseURL, authFlow = null) {
  const candidates = [];
  if (authFlow?.loginUrl) candidates.push(joinUrl(baseURL, authFlow.loginUrl));
  ['/login', '/signin', '/sign-in', '/auth/login', '/admin/login', '/'].forEach((pathName) => {
    candidates.push(joinUrl(baseURL, pathName));
  });
  return Array.from(new Set(candidates));
}

function createSequentialCases({ config, context, parsedPRD, explorationArtifact, roles }) {
  const cases = [];
  const add = (input) => {
    const id = input.id || `seq-${cases.length + 1}`;
    cases.push({
      id: slugify(id, `seq-${cases.length + 1}`),
      title: input.title || input.objective || id,
      kind: input.kind || 'ui',
      path: input.path || '/',
      role: input.role || null,
      objective: input.objective || input.title || '',
      acIds: input.acIds || [],
      seedActions: input.seedActions || [],
      source: input.source || 'derived',
    });
  };

  if (Array.isArray(config.testCredentials) && config.testCredentials.length > 0) {
    for (const cred of config.testCredentials.slice(0, 4)) {
      const role = cred.role || 'user';
      add({
        id: `auth-${role}`,
        title: `Verify ${role} login setup`,
        kind: 'auth',
        path: explorationArtifact?.authFlow?.loginUrl || '/login',
        role,
        objective: `Sign in as ${role} and verify the session is usable.`,
        source: 'credentials',
      });
    }
  }

  const features = Array.isArray(parsedPRD?.features) ? parsedPRD.features : [];
  for (const feature of features) {
    for (const story of feature.userStories || []) {
      for (const ac of story.acceptanceCriteria || []) {
        add({
          id: ac.id,
          title: `[REQ:${ac.id}] ${String(ac.text || story.goal || feature.name).slice(0, 140)}`,
          kind: ac.authRequired ? 'auth-ui' : 'ui',
          role: ac.roleHint || null,
          path: '/',
          objective: ac.text || story.goal || feature.name,
          acIds: [ac.id],
          source: 'prd',
        });
      }
    }
  }

  for (const flow of (explorationArtifact?.keyFlows || []).slice(0, 8)) {
    add({
      id: flow.name || flow.route || `flow-${cases.length + 1}`,
      title: flow.name || `Observed flow ${flow.route || cases.length + 1}`,
      kind: 'ui',
      path: flow.route || flow.path || '/',
      objective: flow.endCondition || flow.description || flow.name || 'Complete observed flow',
      seedActions: Array.isArray(flow.steps) ? flow.steps : [],
      source: 'exploration',
    });
  }

  for (const page of (context?.pages || []).slice(0, 10)) {
    add({
      id: `page-${page.path || cases.length + 1}`,
      title: `Page smoke ${page.path || '/'}`,
      kind: 'ui',
      path: page.path || '/',
      objective: page.description || `Verify ${page.path || '/'} renders and exposes expected controls.`,
      source: 'context.pages',
    });
  }

  for (const endpoint of (context?.apiEndpoints || []).slice(0, 8)) {
    add({
      id: `api-${endpoint.method || 'get'}-${endpoint.path || cases.length + 1}`,
      title: `API ${String(endpoint.method || 'GET').toUpperCase()} ${endpoint.path || '/'}`,
      kind: 'api',
      path: endpoint.path || '/',
      objective: endpoint.description || `Verify ${endpoint.method || 'GET'} ${endpoint.path || '/'} responds without a server error.`,
      source: 'context.apiEndpoints',
    });
  }

  if (cases.length === 0) {
    add({
      id: 'smoke-root',
      title: 'Root page smoke',
      kind: 'ui',
      path: '/',
      objective: 'Verify the root page renders without crashing.',
      source: 'fallback',
    });
  }

  const maxCases = Math.max(1, Math.min(Number(config.maxSequentialCases || DEFAULT_MAX_CASES), 100));
  return cases.slice(0, maxCases);
}

function fallbackActionForTurn(testCase, turnIndex, credentials, baseURL, authFlow) {
  if (testCase.kind === 'api') {
    if (turnIndex === 0) {
      return {
        type: 'apiRequest',
        method: 'GET',
        path: testCase.path || '/',
        rationale: 'Probe endpoint and block only on server errors.',
      };
    }
    return { type: 'finish', summary: 'API probe completed' };
  }

  if (testCase.kind === 'auth') {
    const credential = credentials.find((c) => (c.role || 'user') === (testCase.role || 'user')) || credentials[0] || {};
    const loginCandidates = loginPathCandidates(baseURL, authFlow);
    if (turnIndex === 0) return { type: 'goto', url: loginCandidates[0], rationale: 'Open the likely login page.' };
    if (turnIndex === 1) {
      return {
        type: 'fill',
        locatorCandidates: ['input[type="email"]', 'input[name="email"]', 'input[name="username"]'],
        value: credential.username || '',
        field: 'username',
        rationale: 'Fill the username/email field from supplied credentials.',
      };
    }
    if (turnIndex === 2) {
      return {
        type: 'fill',
        locatorCandidates: ['input[type="password"]', 'input[name="password"]'],
        value: credential.password || '',
        field: 'password',
        rationale: 'Fill the password field from supplied credentials.',
      };
    }
    if (turnIndex === 3) {
      return {
        type: 'click',
        locatorCandidates: ['button[type="submit"]', 'input[type="submit"]', 'text=Sign in', 'text=Login', 'text=Log in'],
        rationale: 'Submit the login form.',
      };
    }
    if (turnIndex === 4) return { type: 'assertURL', pattern: '/', rationale: 'Verify login left the login page.' };
    return { type: 'finish', summary: 'Auth setup case completed' };
  }

  if (turnIndex === 0) return { type: 'goto', path: testCase.path || '/', rationale: 'Open the case target page.' };
  if (turnIndex === 1) {
    return {
      type: 'assertVisible',
      locatorCandidates: ['main', 'body'],
      rationale: 'Verify the page rendered visible content.',
    };
  }
  return { type: 'finish', summary: 'UI smoke case completed' };
}

function buildSpecFromTrace({ testCase, trace, baseURL, blockedReason }) {
  const safeTitle = `[SEQ:${testCase.id}] ${testCase.title}`;
  const lines = [
    "import { test, expect } from './__healix-fixture';",
    '',
    `test(${quote(safeTitle)}, async ({ page, request }) => {`,
  ];

  if (blockedReason) {
    lines.push(`  test.skip(true, ${quote(`Sequential case blocked: ${blockedReason}`)});`);
    lines.push('});');
    return lines.join('\n');
  }

  for (const turn of trace.turns || []) {
    const action = turn.action || {};
    if (turn.status !== 'ok' || action.type === 'finish') continue;
    if (action.type === 'goto') {
      lines.push(`  await page.goto(${quote(joinUrl(baseURL, action.url || action.path || testCase.path || '/'))});`);
    } else if (action.type === 'click') {
      const locator = candidateToLocatorCode(normalizeLocatorCandidates(action)[0], 'button');
      lines.push(`  await ${locator}.first().click();`);
    } else if (action.type === 'fill') {
      const locator = candidateToLocatorCode(normalizeLocatorCandidates(action)[0], 'input');
      lines.push(`  await ${locator}.first().fill(${quote(action.value)});`);
    } else if (action.type === 'select') {
      const locator = candidateToLocatorCode(normalizeLocatorCandidates(action)[0], 'select');
      lines.push(`  await ${locator}.first().selectOption(${quote(action.value)});`);
    } else if (action.type === 'assertVisible') {
      const locator = candidateToLocatorCode(normalizeLocatorCandidates(action)[0], 'body');
      lines.push(`  await expect(${locator}.first()).toBeVisible();`);
    } else if (action.type === 'assertText') {
      const locator = candidateToLocatorCode(normalizeLocatorCandidates(action)[0], 'body');
      const expected = action.text || action.value || '';
      lines.push(`  await expect(${locator}.first()).toContainText(${quote(expected)});`);
    } else if (action.type === 'assertURL') {
      const expected = action.url || action.path || action.pattern || '';
      lines.push(`  await expect(page).toHaveURL(new RegExp(${quote(escapeRegex(expected))}));`);
    } else if (action.type === 'apiRequest') {
      const method = String(action.method || 'GET').toLowerCase();
      lines.push(`  const response = await request.${method}(${quote(joinUrl(baseURL, action.url || action.path || testCase.path || '/'))});`);
      lines.push('  expect(response.status()).toBeLessThan(500);');
    }
  }

  if (!lines.some((line) => line.includes('expect('))) {
    lines.push("  await expect(page.locator('body')).toBeVisible();");
  }

  lines.push('});');
  return lines.join('\n');
}

async function synthesizeSpec({ client, testCase, trace, projectInfo, roles, testsDir, index, baseURL, blockedReason }) {
  const fallbackContent = buildSpecFromTrace({ testCase, trace, baseURL, blockedReason });
  let filename = `${slugify(testCase.id, `sequential-${index + 1}`)}.spec.ts`;
  let content = fallbackContent;
  let source = 'local-trace-synthesis';

  if (!blockedReason && client?.synthesizeSequentialSpec) {
    try {
      const response = await client.synthesizeSequentialSpec({
        testCase,
        trace,
        projectInfo,
        roles,
        options: { fixtureImport: './__healix-fixture' },
      });
      if (response?.spec?.content) {
        filename = response.spec.filename || filename;
        content = response.spec.content;
        source = response.source || 'webapp-synthesis';
      }
    } catch (err) {
      Logger.warn('SequentialRunner', 'Spec synthesis fell back to local trace compiler', {
        caseId: testCase.id,
        reason: err.message,
      });
    }
  }

  const safeFilename = `${slugify(filename.replace(/\.spec\.(ts|js)$/i, ''), `sequential-${index + 1}`)}.spec.ts`;
  const target = path.join(testsDir, safeFilename);
  fs.writeFileSync(target, String(content || fallbackContent).trim() + '\n', 'utf-8');
  return { filename: safeFilename, path: target, source };
}

async function askForNextAction({ client, testCase, observation, history, lastError, projectInfo, roles, fallbackAction }) {
  if (!client?.nextSequentialAction) return { action: fallbackAction, source: 'local-fallback' };
  try {
    const response = await client.nextSequentialAction({
      testCase,
      observation,
      history,
      lastError,
      projectInfo,
      roles,
      options: { allowedActions: Array.from(ACTION_TYPES) },
    });
    const action = response?.action || null;
    const validation = validateSequentialAction(action);
    if (!validation.ok) {
      return {
        action: fallbackAction,
        source: 'local-fallback-invalid-webapp-action',
        warning: validation.reason,
      };
    }
    return { action, source: response.source || 'webapp' };
  } catch (err) {
    const warning = err.message;
    if (isFatalTurnServiceError(warning)) {
      return {
        action: fallbackAction,
        source: 'blocked-webapp-error',
        warning,
        fatalError: warning,
      };
    }
    return { action: fallbackAction, source: 'local-fallback-webapp-error', warning };
  }
}

async function runCase({ browser, client, testCase, index, config, projectInfo, roles, traceDir, testsDir, updateStatus, telemetryReporter, runId, statusDir, explorationArtifact }) {
  const trace = {
    id: testCase.id,
    title: testCase.title,
    kind: testCase.kind,
    role: testCase.role,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    turns: [],
    blockedReason: null,
    spec: null,
  };
  const tracePath = path.join(traceDir, `${slugify(testCase.id, `case-${index + 1}`)}.json`);
  const context = await browser.newContext();
  const page = await context.newPage();
  let repairAttempts = 0;
  let lastError = null;
  const maxTurns = Math.max(1, Math.min(Number(config.maxSequentialTurns || DEFAULT_MAX_TURNS), 30));
  const maxRepairs = Math.max(0, Math.min(Number(config.maxSequentialRepairs || DEFAULT_MAX_REPAIRS), 10));

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500));
  });

  try {
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
      const screenshotPath = path.join(traceDir, `${slugify(testCase.id)}-turn-${turnIndex + 1}.png`);
      const observation = await captureObservation(page, screenshotPath);
      const fallbackAction = fallbackActionForTurn(
        testCase,
        turnIndex,
        config.testCredentials || [],
        config.baseURL,
        explorationArtifact?.authFlow || null,
      );
      const { action, source, warning, fatalError } = await askForNextAction({
        client,
        testCase,
        observation,
        history: trace.turns,
        lastError,
        projectInfo,
        roles,
        fallbackAction,
      });

      const turn = {
        turn: turnIndex + 1,
        source,
        warning: warning || null,
        action: redactAction(action),
        observation,
        consoleErrors: consoleErrors.splice(0),
        status: 'pending',
        error: null,
      };

      updateStatus?.(statusDir, 'sequential_turn', {
        runId,
        caseId: testCase.id,
        caseTitle: testCase.title,
        turn: turn.turn,
        actionType: action.type,
        source,
      }, telemetryReporter);

      if (fatalError) {
        turn.status = 'failed';
        turn.error = fatalError;
        trace.turns.push(turn);
        trace.status = 'blocked';
        trace.blockedReason = `Turn generation unavailable: ${fatalError}`;
        fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
        break;
      }

      if (action.type === 'finish') {
        turn.status = 'ok';
        trace.turns.push(turn);
        trace.status = 'passed';
        break;
      }

      const validation = validateSequentialAction(action);
      if (!validation.ok) {
        turn.status = 'failed';
        turn.error = validation.reason;
        trace.turns.push(turn);
        repairAttempts += 1;
        lastError = validation.reason;
      } else {
        try {
          const result = await executeSequentialAction({
            page,
            action,
            baseURL: config.baseURL,
            apiBaseURL: projectInfo?.baseURL || config.baseURL,
          });
          turn.status = 'ok';
          turn.result = result;
          trace.turns.push(turn);
          lastError = null;
        } catch (err) {
          turn.status = 'failed';
          turn.error = err.message;
          trace.turns.push(turn);
          repairAttempts += 1;
          lastError = err.message;
        }
      }

      fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
      if (repairAttempts > maxRepairs) {
        trace.status = 'blocked';
        trace.blockedReason = `Repair budget exceeded after ${repairAttempts} failed turn(s): ${lastError || 'unknown'}`;
        break;
      }
    }

    if (trace.status === 'running') {
      trace.status = 'blocked';
      trace.blockedReason = `Max sequential turns (${maxTurns}) reached before the case returned finish`;
    }
  } catch (err) {
    trace.status = 'blocked';
    trace.blockedReason = err.message;
  } finally {
    trace.finishedAt = new Date().toISOString();
    try { await context.close(); } catch { /* ignore */ }
  }

  const spec = await synthesizeSpec({
    client,
    testCase,
    trace,
    projectInfo,
    roles,
    testsDir,
    index,
    baseURL: config.baseURL,
    blockedReason: trace.status === 'blocked' ? trace.blockedReason : null,
  });
  trace.spec = spec;
  fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));

  updateStatus?.(statusDir, 'sequential_case_complete', {
    runId,
    caseId: testCase.id,
    caseTitle: testCase.title,
    status: trace.status,
    blockedReason: trace.blockedReason,
    spec: spec.filename,
  }, telemetryReporter);

  if (telemetryReporter && telemetryReporter.isEnabled()) {
    telemetryReporter.emitBackground({
      toolName: 'healix_test_my_app',
      eventType: 'sequential_case',
      runId,
      phase: 'generating',
      status: trace.status === 'blocked' ? 'warning' : 'success',
      success: trace.status !== 'blocked',
      message: `${trace.status}: ${testCase.title}`,
      metadata: {
        caseId: testCase.id,
        status: trace.status,
        turns: trace.turns.length,
        spec: spec.filename,
        blockedReason: trace.blockedReason,
      },
    });
  }

  return trace;
}

async function runSequentialGeneration({
  config,
  context,
  parsedPRD,
  explorationArtifact,
  roles,
  projectInfo,
  testsDir,
  statusDir,
  runId,
  client,
  telemetryReporter,
  updateStatus,
}) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    const error = new Error('Sequential tester requires the playwright package to drive live turns');
    error.code = 'SEQUENTIAL_PLAYWRIGHT_MISSING';
    throw error;
  }

  ensureDir(testsDir);
  const traceDir = path.join(statusDir, 'sequential-traces');
  ensureDir(traceDir);

  const cases = createSequentialCases({ config, context, parsedPRD, explorationArtifact, roles });
  fs.writeFileSync(path.join(traceDir, 'cases.json'), JSON.stringify(cases, null, 2));

  const browser = await chromium.launch({ headless: config.headless !== false });
  const traces = [];
  try {
    for (let i = 0; i < cases.length; i += 1) {
      const testCase = cases[i];
      updateStatus?.(statusDir, 'sequential_case', {
        runId,
        caseId: testCase.id,
        caseTitle: testCase.title,
        caseIndex: i + 1,
        totalCases: cases.length,
      }, telemetryReporter);
      const trace = await runCase({
        browser,
        client,
        testCase,
        index: i,
        config,
        projectInfo,
        roles,
        traceDir,
        testsDir,
        updateStatus,
        telemetryReporter,
        runId,
        statusDir,
        explorationArtifact,
      });
      traces.push(trace);
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }

  const files = traces
    .filter((trace) => trace.spec?.path)
    .map((trace) => ({
      path: trace.spec.path,
      filename: trace.spec.filename,
      type: 'sequential',
      caseId: trace.id,
    }));

  const blocked = traces.filter((trace) => trace.status === 'blocked');
  const passed = traces.filter((trace) => trace.status === 'passed');
  const summary = {
    strategy: 'sequential',
    totalCases: traces.length,
    passedCases: passed.length,
    blockedCases: blocked.length,
    traceDir,
    traces: traces.map((trace) => ({
      id: trace.id,
      title: trace.title,
      status: trace.status,
      turns: trace.turns.length,
      blockedReason: trace.blockedReason,
      spec: trace.spec?.filename || null,
    })),
  };
  fs.writeFileSync(path.join(traceDir, 'summary.json'), JSON.stringify(summary, null, 2));

  return {
    generated: files.length,
    files,
    provider: 'saas',
    generationMeta: {
      selectedGenerator: 'sequential',
      provider: 'saas',
      fallbackUsed: false,
      testStrategy: 'sequential',
      sequential: summary,
    },
  };
}

module.exports = {
  ACTION_TYPES,
  validateSequentialAction,
  isFatalTurnServiceError,
  executeSequentialAction,
  captureObservation,
  createSequentialCases,
  loginPathCandidates,
  buildSpecFromTrace,
  runSequentialGeneration,
};
