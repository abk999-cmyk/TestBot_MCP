/**
 * Pipeline Worker
 * Runs the full Healix pipeline in a background process.
 * Receives config via IPC from the MCP server, runs independently.
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync, spawnSync } = require('child_process');

// Load environment variables from multiple paths
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) break;
}

const PlaywrightIntegration = require('./playwright-integration');
const PlaywrightMCPClient = require('./playwright-mcp-client');
const PlaywrightMCPIntegration = require('./playwright-mcp-integration');
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const AgentContextRequester = require('./agent-context-requester');
let JiraClient;
try { JiraClient = require('./jira/client'); } catch { JiraClient = null; }
const ReportGenerator = require('./report-generator');
const ArtifactUploader = require('./artifact-uploader');
const DashboardLauncher = require('./dashboard-launcher');
const AIAnalyzer = require('./ai-providers/index');
const WebappClient = require('./webapp-client');
const { runSequentialGeneration } = require('./sequential-runner');
const { startSecondaryServices, stopSecondaryServices, probeHttpReady, waitForServiceReady } = require('./multi-service-starter');
const { runExplorationPhase, EMPTY_ARTIFACT } = require('./exploration-phase');
const { injectCredentials } = require('./credentials-injector');
const Logger = require('./logger');
const MCPTelemetryReporter = require('./mcp-telemetry');

// Initialize logger for the worker process
Logger.initialize();

function killPreStartedProc(proc) {
  if (!proc?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {
        try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  } catch { /* ignore */ }
}

const DEFAULT_TOTAL_BUDGET_MS = 7200000; // 120 minutes
// Generation used to be 6 min and was hit routinely by real-world repos. With
// the per-agent parallel fan-out (P1-d) 5 concurrent <60s calls give a typical
// wall-clock of ~2 min, but we budget generously (30 min) for slow customers,
// cold Vercel starts, occasional webapp retries, and larger projects like
// zapminds_PM that routinely exceeded the prior 15-min cap. Users can override
// per run via HEALIX_GEN_BUDGET_MS.
const DEFAULT_STAGE_CAPS_MS = {
  jira: 45000,
  context: 90000,
  prdParse: 300000,
  generation: 1800000,  // 30 minutes
  validation: 90000,
  execution: 2400000,  // 40 minutes
  aiTriage: 60000,
  reporting: 30000,
  dashboard: 30000,
};

const STRICT_AI_REQUIRED_CATEGORIES = [
  'ui_flow',
  'form_validation',
  'workflow_journey',
  'api_contract',
  'api_auth',
  'api_negative',
  'api_stress',
];

const CURSOR_FIXTURE_BASENAME = '__healix-fixture';
const CURSOR_OVERLAY_INIT_SCRIPT = `
(() => {
  if (window.__healixCursorOverlayInstalled) return;
  window.__healixCursorOverlayInstalled = true;

  const ensureCursor = () => {
    const existing = document.getElementById('__healix-cursor-overlay');
    if (existing) return existing;

    const dot = document.createElement('div');
    dot.id = '__healix-cursor-overlay';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:16px',
      'height:16px',
      'margin-left:-8px',
      'margin-top:-8px',
      'border-radius:9999px',
      'background:rgba(255,82,82,0.95)',
      'border:2px solid rgba(255,255,255,0.95)',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.35)',
      'z-index:2147483647',
      'pointer-events:none',
      'opacity:0',
      'transform:translate(-100px,-100px)',
      'transition:opacity 80ms linear, transform 16ms linear'
    ].join(';');
    document.documentElement.appendChild(dot);
    return dot;
  };

  const move = (event) => {
    const dot = ensureCursor();
    dot.style.opacity = '1';
    dot.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px)';
  };

  const hide = () => {
    const dot = document.getElementById('__healix-cursor-overlay');
    if (dot) dot.style.opacity = '0';
  };

  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseenter', move, true);
  document.addEventListener('mouseleave', hide, true);
})();
`;

// ── Healix PID-file helpers ────────────────────────────────────────────────
// We write a PID file for every process Healix starts (dev server, worker).
// On the next run startup we read these files and kill only those PIDs —
// never any unrelated user process.

const HEALIX_SERVER_PID_FILENAME  = '.healix-server.pid';
const HEALIX_WORKER_PID_FILENAME  = '.healix-worker.pid';

/**
 * Kill a process tree identified by a PID file Healix previously wrote.
 * Silently no-ops if the file is missing or the process is already gone.
 * Removes the file regardless.
 */
function killOrphanedHealixProcess(pidFile, label) {
  if (!fs.existsSync(pidFile)) return;
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch { /* unreadable — just delete */ }

  if (pid > 0) {
    try {
      if (process.platform === 'win32') {
        const { spawnSync } = require('child_process');
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
      Logger.info('PipelineWorker', `Killed leftover Healix ${label} process`, { pid });
    } catch { /* process already gone — ignore */ }
  }

  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

/**
 * Write a PID to a Healix-owned PID file so it can be cleaned up later.
 */
function writeHealixPidFile(pidFile, pid) {
  try { fs.writeFileSync(pidFile, String(pid)); } catch { /* non-fatal */ }
}

// ────────────────────────────────────────────────────────────────────────────

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRunBudget(config = {}) {
  const totalMs = toFiniteNumber(config.maxRunMs || process.env.HEALIX_RUN_BUDGET_MS, DEFAULT_TOTAL_BUDGET_MS);
  const stageCaps = {};
  for (const [stage, fallback] of Object.entries(DEFAULT_STAGE_CAPS_MS)) {
    const envKey = `HEALIX_STAGE_${stage.toUpperCase()}_MS`;
    stageCaps[stage] = toFiniteNumber(config.stageCaps?.[stage] || process.env[envKey], fallback);
  }

  // Friendly alias for the generation stage — `HEALIX_GEN_BUDGET_MS` is the
  // knob most customers reach for when their codebase is too large to
  // generate inside the default 15-minute cap. Precedence:
  //   explicit config.stageCaps.generation  >  HEALIX_GEN_BUDGET_MS
  //     >  HEALIX_STAGE_GENERATION_MS        >  default
  // If the user set the env alias, treat it as an "explicit" cap so the
  // adaptive-strictAI floor below doesn't silently raise it back up.
  const genBudgetOverride = toFiniteNumber(process.env.HEALIX_GEN_BUDGET_MS, null);
  const explicitConfigGen = Number.isFinite(Number(config.stageCaps?.generation)) && Number(config.stageCaps.generation) > 0;
  if (!explicitConfigGen && genBudgetOverride !== null && genBudgetOverride > 0) {
    stageCaps.generation = genBudgetOverride;
    Logger.info?.('pipeline-worker', `generation stage budget overridden via HEALIX_GEN_BUDGET_MS=${genBudgetOverride}ms`);
  }

  const strictAI = strictAIEnabled(config);
  const coverageProfile = String(config.coverageProfile || 'qa-max').toLowerCase();
  const twoPhase = String(config.phaseMode || 'two-phase') === 'two-phase';

  const hasExplicitGenerationCap =
    Boolean(config.stageCaps?.generation) ||
    Boolean(process.env.HEALIX_STAGE_GENERATION_MS) ||
    Boolean(process.env.HEALIX_GEN_BUDGET_MS);
  if (strictAI && !hasExplicitGenerationCap) {
    const requestedMinTests = toFiniteNumber(config.minGeneratedTests, 50);
    const adaptiveGenerationCap = coverageProfile === 'exhaustive' || requestedMinTests >= 75
      ? 600000
      : requestedMinTests >= 50
        ? 480000
        : stageCaps.generation;
    stageCaps.generation = Math.max(stageCaps.generation, adaptiveGenerationCap);
  }

  // Scale execution cap for heavier profiles / two-phase mode
  const hasExplicitExecutionCap = Boolean(config.stageCaps?.execution) || Boolean(process.env.HEALIX_STAGE_EXECUTION_MS);
  if (!hasExplicitExecutionCap) {
    const adaptiveExecutionCap = coverageProfile === 'exhaustive'
      ? 2400000
      : twoPhase
        ? 1200000
        : 900000;
    stageCaps.execution = Math.max(stageCaps.execution, adaptiveExecutionCap);
  }

  return {
    startedAt: Date.now(),
    totalMs,
    stageCaps,
  };
}

function getBudgetElapsedMs(budget) {
  return Date.now() - budget.startedAt;
}

function getBudgetRemainingMs(budget) {
  return Math.max(0, budget.totalMs - getBudgetElapsedMs(budget));
}

function createBudgetError(message, code = 'TIME_BUDGET_EXCEEDED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function computePassRatePercent(results) {
  if (!results || !Number.isFinite(results.total) || results.total <= 0) {
    return 0;
  }
  return (Number(results.passed || 0) / Number(results.total)) * 100;
}

function strictAIEnabled(config = {}) {
  return config.strictAIGeneration !== false;
}


function countTestsInContent(content) {
  if (!content) return 0;
  const matches = String(content).match(/\b(?:test|it)(?:\.(?:only|skip|fixme|fail|slow|todo))?\s*\(\s*(['"`])/g);
  return matches ? matches.length : 0;
}

function listGeneratedTestFiles(projectPath) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return [];
  }

  return fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name))
    .map((name) => path.join(generatedDir, name));
}

/**
 * Auto-discover candidate PRD / spec / design docs in the project root when the
 * user didn't explicitly pass a PRD. Healix was coming up empty on runs where
 * the repo clearly had a README / walkthrough describing the product — this
 * closes that gap without forcing CLI flags on the user.
 *
 * Priority:
 *   1. Well-known top-level filenames (README.md, PRD.md, SPEC.md, DESIGN.md,
 *      walkthrough.md) in that order.
 *   2. docs/*.md (depth-1)
 *   3. docs/**\/*.md (depth-2 only; we cap depth to avoid blowing out on
 *      accidentally-shipped site generators or monorepo docs).
 *
 * Hard caps:
 *   - total aggregated bytes ≤ MAX (~30 KB) so we don't drown the generator
 *     prompt
 *   - ignores node_modules / dist / build / .next
 */
function autoDiscoverPrdDocs(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return { paths: [], content: null, totalBytes: 0 };
  const MAX_TOTAL_BYTES = 30 * 1024; // ~30 KB aggregated
  const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git']);
  const WELL_KNOWN = ['README.md', 'PRD.md', 'SPEC.md', 'DESIGN.md', 'walkthrough.md'];

  const picked = [];
  const seen = new Set();
  let totalBytes = 0;

  const safeStat = (p) => {
    try { return fs.statSync(p); } catch { return null; }
  };

  const addCandidate = (absPath) => {
    if (!absPath || seen.has(absPath)) return false;
    const st = safeStat(absPath);
    if (!st || !st.isFile()) return false;
    if (totalBytes >= MAX_TOTAL_BYTES) return false;
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return false;
    }
    const remaining = MAX_TOTAL_BYTES - totalBytes;
    const truncated = content.length > remaining ? content.slice(0, remaining) : content;
    picked.push({ path: absPath, content: truncated });
    seen.add(absPath);
    totalBytes += truncated.length;
    return true;
  };

  // Pass 1: well-known root filenames
  for (const name of WELL_KNOWN) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    addCandidate(path.join(projectPath, name));
  }

  // Pass 2 & 3: docs/ tree at depth ≤ 2
  const docsRoot = path.join(projectPath, 'docs');
  const docsStat = safeStat(docsRoot);
  if (docsStat && docsStat.isDirectory() && totalBytes < MAX_TOTAL_BYTES) {
    const walk = (dir, depth) => {
      if (depth > 2 || totalBytes >= MAX_TOTAL_BYTES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // Files first (shallow-preferred ordering), then subdirs.
      const files = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files) {
        if (totalBytes >= MAX_TOTAL_BYTES) return;
        addCandidate(path.join(dir, f.name));
      }
      if (depth === 2) return; // leaf depth
      const subdirs = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const d of subdirs) {
        if (totalBytes >= MAX_TOTAL_BYTES) return;
        walk(path.join(dir, d.name), depth + 1);
      }
    };
    walk(docsRoot, 1);
  }

  if (picked.length === 0) {
    return { paths: [], content: null, totalBytes: 0 };
  }

  const aggregated = picked
    .map((p) => `# === ${path.relative(projectPath, p.path) || p.path} ===\n\n${p.content}`)
    .join('\n\n---\n\n');

  return {
    paths: picked.map((p) => p.path),
    content: aggregated,
    totalBytes,
  };
}

/**
 * Detect when the user's playwright.config.* declares a `webServer` block
 * whose URL disagrees with the Healix-configured baseURL. When this mismatch
 * exists AND Healix is also starting its own dev server, Playwright will
 * waste 120s waiting for its own spawned webServer to come up and then throw
 * "Timed out waiting 120000ms from config.webServer". This function returns
 * `{ ext, configuredUrl }` on conflict or `null` when safe.
 *
 * Intentionally regex-based — we don't execute the user's TS config. This is
 * best-effort; we only act when we're confident (explicit url: '...' literal).
 */
function detectPlaywrightWebServerConflict(projectPath, healixBaseURL) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];
  for (const fileName of candidates) {
    const full = path.join(projectPath, fileName);
    if (!fs.existsSync(full)) continue;
    let content = '';
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const webServerMatch = content.match(/webServer\s*:\s*\{([\s\S]*?)\}/);
    if (!webServerMatch) return null; // no webServer block → safe
    const body = webServerMatch[1];
    const urlMatch = body.match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!urlMatch) return null; // webServer without url → safe (Playwright spawns only, won't probe)
    const configuredUrl = urlMatch[1];
    let cfgPort = null;
    let basePort = null;
    try { cfgPort = new URL(configuredUrl).port || (configuredUrl.startsWith('https') ? '443' : '80'); } catch { return null; }
    try { basePort = new URL(healixBaseURL).port || (healixBaseURL.startsWith('https') ? '443' : '80'); } catch { return null; }
    if (cfgPort && basePort && cfgPort !== basePort) {
      return { ext: fileName.split('.').pop(), configuredUrl };
    }
    return null;
  }
  return null;
}

function toCoverageProfile(value) {
  const normalized = String(value || 'qa-max').toLowerCase();
  if (normalized === 'balanced' || normalized === 'exhaustive') {
    return normalized;
  }
  return 'qa-max';
}

function extractCategoryTags(content) {
  const text = String(content || '');
  const categories = new Set();
  const aliases = {
    ui: 'ui_flow',
    uiflow: 'ui_flow',
    ui_flow: 'ui_flow',
    form: 'form_validation',
    form_validation: 'form_validation',
    workflow: 'workflow_journey',
    workflow_journey: 'workflow_journey',
    journey: 'workflow_journey',
    api: 'api_contract',
    api_contract: 'api_contract',
    contract: 'api_contract',
    api_auth: 'api_auth',
    auth: 'api_auth',
    api_negative: 'api_negative',
    negative: 'api_negative',
    error: 'api_negative',
    api_stress: 'api_stress',
    stress: 'api_stress',
    load: 'api_stress',
  };

  const matches = text.matchAll(/\[CAT:([^\]\r\n]+)\]/gi);
  for (const match of matches) {
    const raw = String(match?.[1] || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    if (!raw) continue;
    categories.add(aliases[raw] || raw);
  }

  return categories;
}

function detectCoverageCategoriesFromContent(content, filename) {
  const text = String(content || '');
  const fileLabel = String(filename || '').toLowerCase();
  const categories = extractCategoryTags(text);
  const taggedApiSignals = ['api_contract', 'api_auth', 'api_negative', 'api_stress'].some((name) => categories.has(name));
  const isApiSuite = taggedApiSignals || /request\.(get|post|put|patch|delete|fetch)\(/i.test(text) || /api/.test(fileLabel);

  if (!isApiSuite) {
    if (
      /page\.(goto|click|fill|check|selectOption|press)\(/i.test(text) ||
      /getBy(Role|Label|Placeholder|TestId|Text|AltText)\(/.test(text) ||
      /toHaveURL\(|toBeVisible\(/.test(text)
    ) {
      categories.add('ui_flow');
    }

    if (
      /fill\(|getBy(Label|Placeholder)\(|required|validation|invalid|error message|toBeDisabled\(/i.test(text)
    ) {
      categories.add('form_validation');
    }

    if (
      /workflow|journey|onboarding|checkout|multi-step|end-to-end|critical path/i.test(fileLabel) ||
      /step\s*\d+|complete flow|end-to-end|journey/i.test(text)
    ) {
      categories.add('workflow_journey');
    }
  } else {
    if (
      /response\.status\(\)|toBe\(\s*\d{3}\s*\)|toContain\(\s*response\.status\(\)\s*\)|toHaveProperty\(/i.test(text)
    ) {
      categories.add('api_contract');
    }

    if (/authorization|bearer|unauth|401|403|auth required|test_auth_token/i.test(text)) {
      categories.add('api_auth');
    }

    if (/malformed|invalid|negative|error|expect\(response\.status\(\)\)\.toBeGreaterThanOrEqual\(\s*400/i.test(text) ||
      /\b(400|404|409|422|429)\b/.test(text)
    ) {
      categories.add('api_negative');
    }

    if (/promise\.all|burst|stress|load|p95|percentile|concurrent/i.test(text)) {
      categories.add('api_stress');
    }
  }

  return categories;
}

function collectGenerationQuality(projectPath) {
  const files = listGeneratedTestFiles(projectPath);
  const categories = Object.fromEntries(STRICT_AI_REQUIRED_CATEGORIES.map((name) => [name, 0]));
  let totalTests = 0;
  let filesWithPreferredSelectors = 0;
  let uiFiles = 0;

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    totalTests += countTestsInContent(content);
    const detected = detectCoverageCategoriesFromContent(content, path.basename(filePath));
    for (const category of detected) {
      categories[category] = (categories[category] || 0) + 1;
    }

    const isApiSuite = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(path.basename(filePath));
    if (!isApiSuite) {
      uiFiles += 1;
      if (/getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/.test(content)) {
        filesWithPreferredSelectors += 1;
      }
    }
  }

  const selectorQuality = uiFiles > 0
    ? Number((filesWithPreferredSelectors / uiFiles).toFixed(2))
    : 1;

  return {
    totalFiles: files.length,
    totalTests,
    categories,
    selectorQuality,
  };
}

function buildRequirementsCoverage({ prdContent, prdContents, projectPath }) {
  const fallback = {
    totalRequirements: 0,
    mappedRequirements: 0,
    uncoveredRequirements: [],
  };

  const allPrdContent = [];
  if (prdContent && String(prdContent).trim()) {
    allPrdContent.push(String(prdContent));
  }
  if (Array.isArray(prdContents)) {
    for (const content of prdContents) {
      if (content && String(content).trim()) {
        allPrdContent.push(String(content));
      }
    }
  }

  if (allPrdContent.length === 0) {
    return fallback;
  }

  const combinedPrdContent = allPrdContent.join('\n');
  const requirementMatches = combinedPrdContent.match(/\b(?:REQ|AC|US)[-_ ]?\d+\b/gi) || [];
  const normalizedRequirements = [...new Set(requirementMatches.map((item) => item.toUpperCase().replace(/\s+/g, '-')))];
  if (normalizedRequirements.length === 0) {
    return fallback;
  }

  const filePaths = listGeneratedTestFiles(projectPath);
  const corpus = [];
  for (const filePath of filePaths) {
    try {
      corpus.push(fs.readFileSync(filePath, 'utf-8').toUpperCase());
    } catch {
      // ignore
    }
  }
  const allContent = corpus.join('\n');

  const uncoveredRequirements = normalizedRequirements.filter((requirement) =>
    !allContent.includes(requirement) &&
    !allContent.includes(`[REQ:${requirement}]`) &&
    !allContent.includes(`[REQ-${requirement}]`)
  );

  return {
    totalRequirements: normalizedRequirements.length,
    mappedRequirements: normalizedRequirements.length - uncoveredRequirements.length,
    uncoveredRequirements,
  };
}

function requiredCategoriesForRun({ testType, context = {} }) {
  const normalizedType = String(testType || 'both').toLowerCase();
  const pageCount = (context.pages || []).length;
  const formCount = (context.forms || []).length;
  const workflowCount = (context.workflows || []).length;
  const navEdgeCount = (context.navigationGraph || []).length;
  const apiCount = (context.apiEndpoints || []).length;
  const authPatternCount = (context.authPatterns || []).length;
  const apiAuthSignals = (context.apiEndpoints || []).filter((endpoint) =>
    endpoint?.authRequired === true ||
    /auth|token|login|logout|session|bearer/i.test(String(endpoint?.path || ''))
  ).length;

  const explicitFrontend = normalizedType === 'frontend';
  const explicitBackend = normalizedType === 'backend';

  const hasUiSurface = !explicitBackend && (
    pageCount > 0 ||
    formCount > 0 ||
    workflowCount > 0 ||
    navEdgeCount > 0
  );
  const hasApiSurface = !explicitFrontend && (
    apiCount > 0 ||
    normalizedType === 'backend'
  );

  const required = [];
  if (hasUiSurface) {
    required.push('ui_flow');
    if (formCount > 0) {
      required.push('form_validation');
    }
    if (navEdgeCount > 1 || workflowCount > 1 || (workflowCount > 0 && formCount > 0)) {
      required.push('workflow_journey');
    }
  }
  if (hasApiSurface) {
    required.push('api_contract', 'api_negative', 'api_stress');
    if (apiAuthSignals > 0 || authPatternCount > 0) {
      required.push('api_auth');
    }
  }

  if (required.length === 0) {
    if (explicitFrontend) {
      return ['ui_flow'];
    }
    if (explicitBackend) {
      return ['api_contract', 'api_negative', 'api_stress'];
    }
    return ['ui_flow', 'api_contract', 'api_negative'];
  }

  return required;
}

function minimumCategoryHitsByProfile(profile) {
  if (profile === 'exhaustive') return 2;
  return 1;
}

// Compute a 0-100 quality score and a list of "if you do X, quality can
// improve by Y%" suggestions. Heuristic on purpose — the dashboard banner
// isn't a scientific rubric, it's a nudge that tells users WHY we couldn't
// generate higher-quality tests and how they could help next run.
function computeQualityScoreAndSuggestions({
  quality,
  requiredCategories,
  missingCategories,
  minSelectorQuality,
  prdContent,
  parsedPRD,
  context,
  requirementsCoverage,
}) {
  // Start at 100 and subtract for each quality signal that's below target.
  // Caps at 35 so we never show "quality 0%" which reads as "broken".
  let score = 100;
  const suggestions = [];

  // Selector quality: below threshold is the #1 driver of flaky/brittle tests.
  const selQ = Number(quality.selectorQuality ?? 1);
  if (selQ < minSelectorQuality) {
    const deficit = Math.round((minSelectorQuality - selQ) * 100);
    score -= Math.min(20, deficit);
    suggestions.push({
      key: 'selector_quality',
      potentialImprovement: Math.min(20, deficit),
      text: `Add data-testid attributes to interactive elements — current selector quality ${Math.round(selQ * 100)}%, target ${Math.round(minSelectorQuality * 100)}%.`,
    });
  }

  // Missing coverage categories: each missing category removes a meaningful
  // chunk of the suite's surface area.
  if (missingCategories.length > 0) {
    const perCategory = 8;
    score -= Math.min(30, missingCategories.length * perCategory);
    suggestions.push({
      key: 'missing_categories',
      potentialImprovement: Math.min(30, missingCategories.length * perCategory),
      text: `Suite is missing coverage for: ${missingCategories.join(', ')}. Re-run with broader \`testType\` or expand the codebase exploration.`,
    });
  }

  // PRD / acceptance-criteria signal. The generator produces much tighter
  // tests when AC are available to trace against — this is the most common
  // "why is my suite thin" cause.
  const prdText = String(prdContent || '').trim();
  const parsedAcCount = Array.isArray(parsedPRD?.acceptanceCriteria)
    ? parsedPRD.acceptanceCriteria.length
    : (parsedPRD && typeof parsedPRD === 'object'
        ? Object.values(parsedPRD).reduce((n, v) => n + (Array.isArray(v?.acceptanceCriteria) ? v.acceptanceCriteria.length : 0), 0)
        : 0);
  if (prdText.length < 200) {
    score -= 18;
    suggestions.push({
      key: 'missing_prd',
      potentialImprovement: 18,
      text: 'Add a PRD or BRD file (README, docs/*.md, etc.) describing what the app should do — generation currently has no product context to trace against.',
    });
  } else if (parsedAcCount < 3) {
    score -= 12;
    suggestions.push({
      key: 'thin_acceptance_criteria',
      potentialImprovement: 12,
      text: `Add explicit acceptance criteria to your PRD (found ${parsedAcCount}) — tests would then assert against user-stated requirements instead of inferred behavior.`,
    });
  }

  // BRD requirement trace. When PRD has REQ-### tags but none made it into
  // generated tests, suggest enabling AC-trace or upgrading the PRD format.
  if (
    requirementsCoverage &&
    requirementsCoverage.totalRequirements > 0 &&
    requirementsCoverage.mappedRequirements === 0
  ) {
    score -= 10;
    suggestions.push({
      key: 'zero_brd_trace',
      potentialImprovement: 10,
      text: `Your PRD has ${requirementsCoverage.totalRequirements} requirement tag(s) (REQ-###/AC-###/US-###) but none appear in generated tests — consider enabling stricter AC-trace or re-running after bulking up the PRD.`,
    });
  }

  // Exploration thinness: fewer pages/endpoints = thinner coverage.
  const pageCount = (context?.pages || []).length;
  const endpointCount = (context?.apiEndpoints || []).length;
  if (pageCount + endpointCount < 3) {
    score -= 8;
    suggestions.push({
      key: 'thin_exploration',
      potentialImprovement: 8,
      text: `Only ${pageCount} page(s) and ${endpointCount} endpoint(s) discovered — run with browser exploration enabled or point Healix at a running dev server for richer context.`,
    });
  }

  score = Math.max(35, Math.min(100, Math.round(score)));
  const totalPotentialImprovement = Math.min(
    100 - score,
    suggestions.reduce((sum, s) => sum + (s.potentialImprovement || 0), 0)
  );

  return {
    qualityScore: score,
    totalPotentialImprovement,
    suggestions,
  };
}

function evaluateGenerationQualityGates({ config, context, quality, prdContent, parsedPRD, requirementsCoverage }) {
  const requiredCategories = requiredCategoriesForRun({
    testType: config.testType,
    context,
  });
  const profile = toCoverageProfile(config.coverageProfile);
  const minHits = minimumCategoryHitsByProfile(profile);
  const missingCategories = requiredCategories.filter((category) => (quality.categories[category] || 0) < minHits);

  const minGeneratedTests = toFiniteNumber(config.minGeneratedTests, 50);
  const minSelectorQuality = profile === 'balanced' ? 0.35 : (profile === 'exhaustive' ? 0.6 : 0.5);

  // Hard-fail when running under a strict coverage profile (qa-max / exhaustive)
  // with strictAIGeneration enabled. Non-strict profiles (balanced) retain the
  // legacy warn-and-continue behavior so dev-loop runs still produce artifacts
  // even when generation undershoots.
  if (quality.totalTests < minGeneratedTests) {
    const strictCoverage = profile === 'qa-max' || profile === 'exhaustive';
    if (strictAIEnabled(config) && strictCoverage) {
      const error = new Error(
        `Generated tests ${quality.totalTests} below minimum ${minGeneratedTests} for strict profile ${profile}`
      );
      error.code = 'MIN_TEST_COUNT_NOT_MET';
      error.generationQuality = {
        ...quality,
        minGeneratedTests,
        requiredCategories,
        missingCategories,
        minSelectorQuality,
        coverageProfile: profile,
      };
      return { ok: false, error };
    }
    Logger.warn('PipelineWorker', `Generated tests ${quality.totalTests} below minimum ${minGeneratedTests}, but continuing pipeline`);
  }

  const warnings = [];
  if (missingCategories.length > 0) {
    warnings.push(`missing categories: ${missingCategories.join(', ')}`);
  }
  if (quality.selectorQuality < minSelectorQuality) {
    warnings.push(`selectorQuality=${quality.selectorQuality} below ${minSelectorQuality}`);
  }

  // Only hard-fail when there are literally zero tests to run. A suite that
  // fell short on one coverage category or is a few percentage points below
  // the selector-quality threshold is still worth executing — Playwright's
  // pass/fail verdict is more useful to the user than an abort that leaves
  // them with nothing. Match the philosophy already used for
  // MIN_TEST_COUNT_NOT_MET above (warn and continue).
  if (warnings.length > 0 && quality.totalTests === 0) {
    const error = new Error(`Coverage gates failed with zero tests generated. ${warnings.join('; ')}`);
    error.code = 'COVERAGE_GATES_FAILED';
    error.generationQuality = {
      ...quality,
      minGeneratedTests,
      requiredCategories,
      missingCategories,
      minSelectorQuality,
      coverageProfile: profile,
    };
    return { ok: false, error };
  }

  const scoreBundle = computeQualityScoreAndSuggestions({
    quality,
    requiredCategories,
    missingCategories,
    minSelectorQuality,
    prdContent,
    parsedPRD,
    context,
    requirementsCoverage,
  });

  if (warnings.length > 0) {
    Logger.warn(
      'PipelineWorker',
      `Coverage gates flagged warnings but continuing to execution: ${warnings.join('; ')} (quality=${scoreBundle.qualityScore}%)`
    );
  }

  return {
    ok: true,
    result: {
      ...quality,
      minGeneratedTests,
      requiredCategories,
      missingCategories,
      minSelectorQuality,
      coverageProfile: profile,
      warnings,
      qualityScore: scoreBundle.qualityScore,
      potentialImprovement: scoreBundle.totalPotentialImprovement,
      improvementSuggestions: scoreBundle.suggestions,
    },
  };
}

// Optional reporter — installed by runPipeline when a HEALIX_API_KEY is present.
// Every stage emits a `stage_budget_consumed` telemetry event through this so
// dashboards can see "parsing took 62s of a 90s cap" without the run ingesting
// first.
let __stageBudgetReporter = null;
function setStageBudgetReporter(fn) {
  __stageBudgetReporter = typeof fn === 'function' ? fn : null;
}

async function withStageBudget(budget, stage, workFn) {
  const remainingMs = getBudgetRemainingMs(budget);
  if (remainingMs <= 0) {
    throw createBudgetError(`No budget left before stage: ${stage}`);
  }

  const capMs = budget.stageCaps[stage] || remainingMs;
  const timeoutMs = Math.max(1000, Math.min(capMs, remainingMs));
  const startedAt = Date.now();

  let timeoutRef;
  let success = false;
  try {
    const result = await Promise.race([
      Promise.resolve().then(workFn),
      new Promise((_, reject) => {
        timeoutRef = setTimeout(() => {
          reject(createBudgetError(`Stage '${stage}' exceeded budget (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
    success = true;
    return result;
  } finally {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
    if (__stageBudgetReporter) {
      try {
        __stageBudgetReporter({
          stage,
          consumedMs: Date.now() - startedAt,
          capMs: timeoutMs,
          success,
        });
      } catch { /* non-blocking */ }
    }
  }
}

function phaseToTelemetryStatus(phase) {
  const normalized = String(phase || '').toLowerCase();
  if (normalized === 'completed') {
    return 'success';
  }
  if (normalized === 'error' || normalized === 'error_reported') {
    return 'error';
  }
  return 'info';
}

function emitPipelineTelemetry(reporter, payload) {
  if (!reporter || !reporter.isEnabled() || !payload?.runId) {
    return;
  }

  const status = phaseToTelemetryStatus(payload.phase);
  reporter.emitBackground({
    toolName: 'healix_test_my_app',
    eventType: 'pipeline_status',
    runId: payload.runId,
    phase: payload.phase,
    status,
    success: status === 'success',
    errorCode: payload.errorCode,
    reason: payload.error || undefined,
    message: payload.message,
    durationMs: Number(payload?.results?.duration || payload?.budget?.consumedMs || 0) || undefined,
    metadata: {
      project: payload.project,
      aiOnlyEnforced: payload.aiOnlyEnforced,
      fallbackUsed: payload.fallbackUsed,
      total: payload?.results?.total,
      passed: payload?.results?.passed,
      failed: payload?.results?.failed,
      skipped: payload?.results?.skipped,
      passRate: payload?.results?.passRate,
      generationProvider: payload?.generationMeta?.selectedGenerator || payload?.generationMeta?.provider || null,
    },
  });
}

// Optional fire-and-forget durable phase reporter. Populates
// `test_runs.current_phase + current_phase_at` so a crashed run's dashboard can
// show "last seen at tier-B auth probe 3 minutes ago".
let __durablePhaseReporter = null;
function setDurablePhaseReporter(fn) {
  __durablePhaseReporter = typeof fn === 'function' ? fn : null;
}

/**
 * Circular-reference-safe JSON serialiser for status payloads.
 * Handles Buffers, Errors, BigInts, and circular refs — all of which can appear
 * in Playwright's testResults or phaseResults and would otherwise silently
 * prevent status.json from being updated (JSON.stringify throws, caught by the
 * outer try/catch, and the file is never written).
 */
function safeStatusStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return undefined;
    if (value instanceof Error) return { message: value.message, code: value.code || undefined };
    if (Buffer.isBuffer(value)) return `[Buffer(${value.length})]`;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  }, 2);
}

/**
 * Write status update to disk so the caller can track progress.
 */
function updateStatus(statusDir, phase, data, telemetryReporter = null) {
  try {
    const payload = {
      phase,
      timestamp: new Date().toISOString(),
      ...data,
    };
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      safeStatusStringify(payload)
    );
    emitPipelineTelemetry(telemetryReporter, payload);
    if (__durablePhaseReporter) {
      try { __durablePhaseReporter(payload); } catch { /* non-blocking */ }
    }
  } catch (e) {
    Logger.error('PipelineWorker', 'Failed to write status', e);
  }
}

function classifyErrorCode(error) {
  if (error?.code) {
    return String(error.code);
  }

  const message = String(error?.message || '').toLowerCase();
  if (
    message.includes('expo dependency validation failed') ||
    message.includes('best compatibility with the installed expo version') ||
    (message.includes('expo version') && message.includes('expected version')) ||
    (message.includes('dependency validation') && message.includes('expo'))
  ) {
    return 'EXPO_DEPENDENCY_VALIDATION_FAILED';
  }
  if (
    message.includes('requested interactive input') ||
    (message.includes('input is required') && (message.includes('non-interactive') || message.includes('expo'))) ||
    (message.includes('cannot prompt') && message.includes('non-interactive'))
  ) {
    return 'EXPO_NON_INTERACTIVE_PROMPT';
  }
  if (
    message.includes("cannot find module '@playwright/test'") ||
    message.includes("cannot find module \"@playwright/test\"") ||
    message.includes("package subpath './cli.js' is not defined by \"exports\" in") ||
    message.includes("package subpath './cli.js' is not defined by 'exports' in")
  ) {
    return 'PLAYWRIGHT_DEPENDENCY_MISSING';
  }
  if (message.includes('server failed to start') || message.includes('process exited before becoming ready')) {
    return 'SERVER_START_TIMEOUT';
  }
  if (message.includes('exceeded budget') || message.includes('no budget left') || message.includes('time_budget_exceeded')) {
    return 'TIME_BUDGET_EXCEEDED';
  }
  if (message.includes('timed out')) {
    return 'PIPELINE_TIMEOUT';
  }
  if (message.includes('validation')) {
    return 'GENERATION_VALIDATION_FAILED';
  }
  if (message.includes('openai') || message.includes('ai generation')) {
    return 'AI_GENERATION_FAILED';
  }
  if (message.includes('minimum') && message.includes('generated')) {
    return 'MIN_TEST_COUNT_NOT_MET';
  }
  if (message.includes('coverage gates')) {
    return 'COVERAGE_GATES_FAILED';
  }
  if (message.includes('pipeline')) {
    return 'PIPELINE_FAILED';
  }
  return 'PIPELINE_ERROR';
}

function normalizeErrorText(value) {
  return String(value || '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeGenerationAttemptError(error) {
  const base = normalizeErrorText(error?.message) || 'generation attempt failed';
  const validation = error?.validation;
  if (!validation) {
    return base;
  }

  const details = [];
  if (validation.reason) {
    details.push(`validation=${normalizeErrorText(validation.reason)}`);
  }

  if (typeof validation.stderr === 'string' && validation.stderr.trim()) {
    const lines = validation.stderr
      .split('\n')
      .map((line) => normalizeErrorText(line))
      .filter(Boolean);
    const actionable = lines.find((line) =>
      /cannot find module ['"]@playwright\/test['"]|package subpath ['"]\.?\/cli\.js['"] is not defined by ["']exports["']|module_not_found|error:/i.test(line)
    ) || lines[0];
    if (actionable) {
      details.push(actionable.slice(0, 220));
    }
  }

  if (validation.qualityAudit?.errors?.length) {
    details.push(`quality=${validation.qualityAudit.errors.join(',')}`);
  }

  return details.length > 0
    ? `${base} (${details.join('; ')})`
    : base;
}

function buildUserFacingPipelineError(errorCode, error) {
  const normalizedMessage = normalizeErrorText(error?.message) || 'Healix run failed';

  if (errorCode === 'EXPO_DEPENDENCY_VALIDATION_FAILED') {
    return 'Expo blocked server startup due to dependency version validation. Set compatible dependency versions (for example via `npx expo install --check`) or rerun with dependency validation disabled for CI automation.';
  }

  if (errorCode === 'EXPO_NON_INTERACTIVE_PROMPT') {
    return 'Expo requested interactive input while Healix is running headless. Update start command/env to non-interactive mode and fixed port values.';
  }

  if (errorCode === 'PLAYWRIGHT_DEPENDENCY_MISSING') {
    return 'Test runtime could not be resolved while validating generated tests. Healix attempted to auto-link the test runner; install @playwright/test in the target project if this persists.';
  }

  if (errorCode === 'GENERATION_VALIDATION_FAILED') {
    if (/playwright_list_failed/i.test(normalizedMessage)) {
      return 'Generated tests failed pre-run validation. This is usually caused by missing test runner dependencies or invalid generated imports.';
    }
    return `Generated tests did not pass validation gates. ${normalizedMessage}`;
  }

  if (errorCode === 'TIME_BUDGET_EXCEEDED') {
    return 'Healix exceeded the configured time budget before tests could complete. Increase time budget or reduce generation/execution scope.';
  }

  if (errorCode === 'SERVER_START_TIMEOUT') {
    const detail = normalizedMessage ? ` Detail: ${normalizedMessage}` : '';
    return `App server did not become reachable before timeout. Verify start command, base URL, and port settings in the config form.${detail}`;
  }

  if (errorCode === 'MISSING_HEALIX_API_KEY') {
    return 'HEALIX_API_KEY is required for AI test generation. Set it in your MCP config: "HEALIX_API_KEY": "tb_your_key_here".';
  }

  if (errorCode === 'WEBAPP_UNREACHABLE') {
    const dashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';
    return `Healix could not reach the webapp at ${dashboardUrl}. Start it locally with \`cd webapp && npm run dev\` (default http://localhost:3000), or point HEALIX_DASHBOARD_URL at your deployed instance in the MCP config, then re-run.`;
  }

  return normalizedMessage;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isVideoCursorEnabled(config = {}) {
  if (config.showMouseCursorInVideo === false) {
    return false;
  }

  const envValue = String(process.env.HEALIX_VIDEO_CURSOR || '').trim().toLowerCase();
  if (!envValue) {
    return true;
  }

  return !['0', 'false', 'off', 'no'].includes(envValue);
}

function resolveVideoMode(value) {
  const raw = String(value || process.env.HEALIX_VIDEO_MODE || 'on').trim().toLowerCase();
  return raw === 'retain-on-failure' ? 'retain-on-failure' : 'on';
}

function toImportPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized === '.') {
    return './';
  }
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

/**
 * Read the target project's package.json to decide whether Node will treat
 * sibling `.js` files as ESM. An ambiguous `.js` fixture using `module.exports`
 * inside a `"type": "module"` project fails at load with
 *   "The requested module './__healix-fixture' does not provide an export named 'expect'"
 * because Node parses it as ESM and synthesized named exports aren't available.
 * This helper is the source of truth we use to emit the right body.
 */
function detectProjectModuleType(projectPath) {
  if (!projectPath) return 'commonjs';
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return 'commonjs';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}

/**
 * Scan the project source for splash-screen patterns and return the
 * sessionStorage keys that need to be set to bypass them in headless tests.
 *
 * Patterns detected:
 *   - sessionStorage.getItem('key') used inside a showSplash/splash/intro/
 *     firstVisit conditional, OR
 *   - aria-hidden controlled by a state variable that reads from sessionStorage
 *
 * Returns an array of { key, value } objects (may be empty).
 */
function detectSplashScreenStorageKeys(projectPath) {
  if (!projectPath) return [];
  const results = [];
  const seen = new Set();

  // Directories that typically contain app-level components/layouts.
  const dirsToScan = ['src', 'app', 'pages', 'components', 'layouts'].map((d) =>
    path.join(projectPath, d)
  );

  // Patterns that indicate "read from sessionStorage to control a splash/intro".
  // Group 1 captures the key string.
  const SESSION_READ_RE =
    /sessionStorage\.getItem\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const SPLASH_CONTEXT_RE =
    /splash|intro|firstVisit|first_visit|hasSeenSplash|showSplash|splashVisible|skipIntro/i;

  function scanFile(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
    if (!SPLASH_CONTEXT_RE.test(content)) return; // fast skip

    let match;
    SESSION_READ_RE.lastIndex = 0;
    while ((match = SESSION_READ_RE.exec(content)) !== null) {
      const key = match[1];
      if (seen.has(key)) continue;
      // Only include keys whose surrounding context looks splash-related.
      const snippet = content.slice(Math.max(0, match.index - 200), match.index + 200);
      if (SPLASH_CONTEXT_RE.test(snippet)) {
        seen.add(key);
        results.push({ key, value: 'true' });
      }
    }
  }

  function scanDir(dirPath, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDir(full, depth + 1);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        scanFile(full);
      }
    }
  }

  for (const dir of dirsToScan) {
    if (fs.existsSync(dir)) scanDir(dir);
  }

  return results;
}

function getCursorFixtureContent(serializedInitScript, moduleType = 'commonjs', splashStorageKeys = [], roles = []) {
  // Splash-screen bypass: set sessionStorage keys before the page loads so
  // headless Playwright never sees an empty-session splash (the user's browser
  // always has these keys set after their first visit; Playwright starts fresh).
  const splashLines = (splashStorageKeys || []).map(
    ({ key, value }) =>
      `      sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`
  );
  const splashBlock = splashLines.length
    ? `    await page.addInitScript(() => {\n${splashLines.join('\n')}\n    });\n`
    : '';

  // Auth injection block: for tests running under a tierB-auth-<role> project,
  // explicitly load the role's storageState from disk and inject cookies +
  // localStorage into the page context. This is belt-and-suspenders on top of
  // the project-level `use.storageState` — it reads the file at test time so
  // it always picks up the freshest tokens (including those written by the
  // pre-execution refresh pass).
  const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);
  let authPreamble = '';
  let authPreambleCjs = '';
  let authBlock = '';
  if (verifiedRoles.length > 0) {
    const stateMapEntries = verifiedRoles
      .map((r) => `  ${JSON.stringify(String(r.role))}: ${JSON.stringify(r.storageStatePath)}`)
      .join(',\n');
    // ESM/TS: top-level import + named reference in helper
    authPreamble =
      `import { readFileSync as _healixReadFileSync } from 'fs';\n\n` +
      `const _HEALIX_ROLE_STATES: Record<string, string> = {\n${stateMapEntries},\n};\n\n` +
      `function _healixLoadState(p: string): any {\n` +
      `  try { return JSON.parse(_healixReadFileSync(p, 'utf-8')); } catch { return null; }\n` +
      `}\n\n`;
    // CJS: inline require in helper, no top-level import needed
    authPreambleCjs =
      `const _HEALIX_ROLE_STATES = {\n${stateMapEntries},\n};\n\n` +
      `function _healixLoadState(p) {\n` +
      `  try { return JSON.parse(require('fs').readFileSync(p, 'utf-8')); } catch { return null; }\n` +
      `}\n\n`;
    authBlock =
      `    const _roleMatch = testInfo.project.name.match(/^tierB-auth-(.+)$/);\n` +
      `    if (_roleMatch) {\n` +
      `      const _statePath = _HEALIX_ROLE_STATES[_roleMatch[1]];\n` +
      `      if (_statePath) {\n` +
      `        const _state = _healixLoadState(_statePath);\n` +
      `        if (_state && Array.isArray(_state.cookies) && _state.cookies.length > 0) {\n` +
      `          await page.context().addCookies(_state.cookies);\n` +
      `        }\n` +
      `        for (const _origin of (_state && _state.origins) || []) {\n` +
      `          if (Array.isArray(_origin.localStorage) && _origin.localStorage.length > 0) {\n` +
      `            await page.addInitScript((items) => {\n` +
      `              items.forEach(function(item) { localStorage.setItem(item.name, item.value); });\n` +
      `            }, _origin.localStorage);\n` +
      `          }\n` +
      `        }\n` +
      `      }\n` +
      `    }\n`;
  }

  // The page fixture runs splash bypass, auth injection (if any), and the
  // cursor overlay in a single extend block.
  const pageFixtureBody =
    `async ({ page }, use, testInfo) => {\n` +
    splashBlock +
    authBlock +
    `    await page.addInitScript(${serializedInitScript});\n` +
    `    await use(page);\n` +
    `  }`;

  const ts = `import { test as base, expect, request } from '@playwright/test';

${authPreamble}const test = base.extend({
  page: ${pageFixtureBody},
});

export { test, expect, request };
`;

  // Body must match the container's module system or Node will blow up at load.
  // ESM projects ("type":"module"): named exports via `export { ... }`.
  // CJS projects: `module.exports = { ... }`, our historical default.
  const jsEsm = `import { test as base, expect, request } from '@playwright/test';

${authPreamble}const test = base.extend({
  page: ${pageFixtureBody},
});

export { test, expect, request };
`;

  const jsCjs = `const { test: base, expect, request } = require('@playwright/test');

${authPreambleCjs}const test = base.extend({
  page: ${pageFixtureBody},
});

module.exports = { test, expect, request };
`;

  const js = moduleType === 'module' ? jsEsm : jsCjs;
  return { ts, js, moduleType };
}

function ensureCursorFixtureFiles(generatedDir, projectPath = null, roles = []) {
  const serializedInitScript = JSON.stringify(CURSOR_OVERLAY_INIT_SCRIPT);
  // projectPath can be omitted only in tests; in production the caller passes
  // it so we emit the correct module-system body for this project.
  const resolvedProject = projectPath || path.resolve(generatedDir, '..', '..');
  const moduleType = detectProjectModuleType(resolvedProject);
  const splashKeys = detectSplashScreenStorageKeys(resolvedProject);
  if (splashKeys.length > 0) {
    Logger.info('PipelineWorker', `Splash screen detected — injecting sessionStorage bypass for keys: ${splashKeys.map(k => k.key).join(', ')}`);
  }
  const { ts, js } = getCursorFixtureContent(serializedInitScript, moduleType, splashKeys, roles);

  const fixtureTs = path.join(generatedDir, `${CURSOR_FIXTURE_BASENAME}.ts`);
  const fixtureJs = path.join(generatedDir, `${CURSOR_FIXTURE_BASENAME}.js`);

  fs.writeFileSync(fixtureTs, ts, 'utf-8');
  fs.writeFileSync(fixtureJs, js, 'utf-8');

  return [fixtureTs, fixtureJs];
}

function rewritePlaywrightImportToFixture(content, fixtureImportPath) {
  let rewritten = String(content || '');
  const importPattern = /from\s+(['"])@playwright\/test\1/g;
  const requirePattern = /require\((['"])@playwright\/test\1\)/g;

  rewritten = rewritten.replace(importPattern, (_match, quote) => `from ${quote}${fixtureImportPath}${quote}`);
  rewritten = rewritten.replace(requirePattern, (_match, quote) => `require(${quote}${fixtureImportPath}${quote})`);

  return rewritten;
}

// Runs unconditionally after generation. The Healix fixture bundles splash-bypass
// and storageState auto-load that auth-gated SPAs need — without it, every UI
// test redirects to '/' and fails on `url.toContain('/dashboard')`. The cursor
// overlay is a separate, optional concern; see applyMouseCursorOverlayToGeneratedTests.
function ensureHealixFixtureImports({ projectPath, roles = [] }) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { applied: false, reason: 'generated_dir_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name))
    .map((name) => path.join(generatedDir, name));

  if (testFiles.length === 0) {
    return { applied: false, reason: 'no_generated_test_files' };
  }

  const fixtureFiles = ensureCursorFixtureFiles(generatedDir, projectPath, roles);
  let patchedFiles = 0;
  let alreadyUsingFixture = 0;

  for (const testFile of testFiles) {
    const raw = fs.readFileSync(testFile, 'utf-8');
    if (!raw.includes('@playwright/test')) {
      alreadyUsingFixture += 1;
      continue;
    }

    const fixtureBasePath = path.join(generatedDir, CURSOR_FIXTURE_BASENAME);
    const relativeFixturePath = path.relative(path.dirname(testFile), fixtureBasePath);
    const fixtureImportPath = toImportPath(relativeFixturePath);
    const rewritten = rewritePlaywrightImportToFixture(raw, fixtureImportPath);

    if (rewritten !== raw) {
      fs.writeFileSync(testFile, rewritten, 'utf-8');
      patchedFiles += 1;
    }
  }

  return {
    applied: true,
    patchedFiles,
    alreadyUsingFixture,
    totalFiles: testFiles.length,
    fixtureFiles: fixtureFiles.map((filePath) => path.basename(filePath)),
  };
}

function applyMouseCursorOverlayToGeneratedTests({ projectPath, enabled }) {
  if (!enabled) {
    return { enabled: false, reason: 'disabled' };
  }

  // Fixture files + import rewrite are owned by ensureHealixFixtureImports now
  // and run unconditionally. This function is responsible only for the cursor
  // overlay init script, which is the reason fixtures were originally touched
  // here. If the fixture's already in place we're a no-op.
  const result = ensureHealixFixtureImports({ projectPath });
  if (!result.applied) {
    return { enabled: false, reason: result.reason };
  }

  return {
    enabled: true,
    patchedFiles: result.patchedFiles,
    skippedFiles: result.alreadyUsingFixture,
    fixtureFiles: result.fixtureFiles,
  };
}

function resolveFailureAnalysisProvider() {
  const healixApiKey = process.env.HEALIX_API_KEY || null;
  if (healixApiKey) {
    return { provider: 'saas', apiKey: healixApiKey };
  }
  return { provider: null, reason: 'HEALIX_API_KEY is required for AI failure analysis' };
}

function resetGeneratedTestsDir(projectPath) {
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.rmSync(testsDir, { recursive: true, force: true });
  ensureDir(testsDir);
  return testsDir;
}

/**
 * Inspect the generated-tests directory and decide whether we can rescue
 * a budget-exhausted generation attempt. Returns a synthetic result
 * resembling what maybeGenerateViaSaaS would have returned — file paths +
 * count — or null if nothing is on disk.
 *
 * Why not just look at the in-flight meta: the whole point is that the
 * Promise chain rejected, so the meta object never made it back out.
 * Disk is the only source of truth that survived the budget trip.
 */
function rescuePartialGeneration({ projectPath, generatorName, error, startedAt, summarizedReason }) {
  const testsDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(testsDir)) return null;

  let entries;
  try {
    entries = fs.readdirSync(testsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => e.isFile() && /\.spec\.(ts|js)$/i.test(e.name))
    .map((e) => ({
      path: path.join(testsDir, e.name),
      filename: e.name,
      type: 'generated',
    }));

  if (files.length === 0) return null;

  Logger.warn('PipelineWorker', 'Rescuing partial generation after budget trip', {
    generator: generatorName,
    partialsCount: files.length,
    elapsedMs: Date.now() - startedAt,
    summarizedReason,
    errorCode: error?.code || null,
  });

  return {
    generated: files.length,
    files,
    provider: 'saas',
    partial: true,
  };
}

function sanitizeGeneratedFilename(rawFilename, fallbackPrefix, index) {
  const defaultName = `${fallbackPrefix}-${index + 1}.spec.ts`;
  if (!rawFilename || typeof rawFilename !== 'string') {
    return defaultName;
  }

  let base = path.basename(rawFilename.trim());
  base = base.replace(/[^a-zA-Z0-9_.-]/g, '-');
  base = base.replace(/-+/g, '-').replace(/^\.+/, '').replace(/^\-+/, '');

  if (!base) {
    return defaultName;
  }

  if (!/\.spec\.(ts|js)$/i.test(base)) {
    if (/\.(ts|js)$/i.test(base)) {
      base = base.replace(/\.(ts|js)$/i, '.spec.ts');
    } else {
      base = `${base}.spec.ts`;
    }
  }

  return base;
}

function safeWriteGeneratedTest(testsDir, test, index, fallbackPrefix, usedFilenames) {
  const filename = sanitizeGeneratedFilename(test?.filename, fallbackPrefix, index);
  const content = String(test?.content || '').trim();

  if (!content) {
    throw new Error(`Generated file '${filename}' is empty`);
  }
  if (content.length > 300000) {
    throw new Error(`Generated file '${filename}' exceeds size limit`);
  }

  let safeFilename = filename;
  let suffix = 1;
  while (usedFilenames.has(safeFilename.toLowerCase())) {
    safeFilename = filename.replace(/\.spec\.(ts|js)$/i, `-${suffix}.spec.ts`);
    suffix += 1;
  }
  usedFilenames.add(safeFilename.toLowerCase());

  const targetPath = path.resolve(testsDir, safeFilename);
  const resolvedTestsDir = path.resolve(testsDir);
  if (!targetPath.startsWith(`${resolvedTestsDir}${path.sep}`)) {
    throw new Error(`Unsafe generated filename rejected: ${safeFilename}`);
  }

  fs.writeFileSync(targetPath, content, 'utf-8');
  return {
    path: targetPath,
    filename: safeFilename,
  };
}

function writeSupplementalAuthConfig(projectPath, baseURL, verifiedRoles, options = {}) {
  if (!verifiedRoles || verifiedRoles.length === 0) return null;
  const videoMode = resolveVideoMode(options.videoMode);
  const tierBProjects = verifiedRoles.map((r) => `    {
      name: 'tierB-auth-${String(r.role || 'user').replace(/[^a-zA-Z0-9_-]/g, '_')}',
      grep: /@auth|@tierB/,
      retries: 2,
      use: {
        ...devices['Desktop Chrome'],
        storageState: ${JSON.stringify(r.storageStatePath)},
      },
    }`).join(',\n');

  const body = `// Generated by Healix — supplemental Playwright config for the tierB-auth projects.
// Your own playwright.config.* remains the source of truth for the default run.
// Use \`npx playwright test --config=playwright.auth.config.ts\` to exercise
// @auth-tagged tests with pre-loaded storageState for each verified role.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'healix-reports/results/auth-results.json' }],
  ],
  use: {
    baseURL: '${baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: '${videoMode}',
  },
  projects: [
${tierBProjects}
  ],
});
`;

  const authConfigPath = path.join(projectPath, 'playwright.auth.config.ts');
  try {
    fs.writeFileSync(authConfigPath, body, 'utf-8');
    Logger.info('PipelineWorker', 'Emitted supplemental playwright.auth.config.ts', {
      path: authConfigPath,
      tierBRoles: verifiedRoles.map((r) => r.role),
    });
    return authConfigPath;
  } catch (err) {
    Logger.warn('PipelineWorker', 'Failed to write playwright.auth.config.ts — @auth tier skipped', {
      reason: err.message,
    });
    return null;
  }
}

function ensurePlaywrightConfig(projectPath, projectInfo = {}, roles = [], options = {}) {
  const videoMode = resolveVideoMode(options.videoMode);
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  // verifiedRoles determine how many tierB-auth-<role> projects we would have
  // emitted if generating from scratch. We compute it up-front so the early-exit
  // log can tell the user exactly what tier-aware config they're missing.
  const verifiedRolesSummary = (roles || [])
    .filter((r) => r && r.loginVerified && r.storageStatePath)
    .map((r) => r.role || 'user');

  // Check if config already exists
  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      // When the user has their own config we don't touch it. But if we have
      // verified roles we still need tierB-auth projects to exist somewhere, so
      // emit a SIBLING `playwright.auth.config.ts` that the runner (and user)
      // can opt-in via `--config=playwright.auth.config.ts`. The sibling never
      // runs implicitly — it's an additive artifact that preserves the user's
      // primary config as the single source of truth for their normal workflow.
      let supplementalAuthConfigPath = null;
      if (verifiedRolesSummary.length > 0) {
        const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);
        const baseURL = projectInfo.baseURL || 'http://localhost:3000';
        supplementalAuthConfigPath = writeSupplementalAuthConfig(projectPath, baseURL, verifiedRoles, { videoMode });
      }
      // INFO (not debug): the user needs to see this because any tierB-auth
      // projects we would have wired up are being skipped — their @auth-tagged
      // tests will execute against tierA without a storageState and hit the
      // login wall. See P0-2b for the supplemental-config follow-up.
      Logger.info('PipelineWorker', 'Existing Playwright config detected — skipping tier-aware config generation', {
        path: candidate,
        skippedTierBRoles: verifiedRolesSummary,
        supplementalAuthConfigPath,
        hint: verifiedRolesSummary.length > 0
          ? (supplementalAuthConfigPath
              ? `User config preserved; @auth tier lives in ${path.basename(supplementalAuthConfigPath)} — run with --config=${path.basename(supplementalAuthConfigPath)} to exercise tierB-auth projects`
              : 'User config will not auto-include storageState for verified roles; @auth tests may hit login redirects')
          : null,
      });
      return {
        applied: false,
        reason: 'existing_config',
        existingConfigPath: candidate,
        skippedTierBRoles: verifiedRolesSummary,
        supplementalAuthConfigPath,
      };
    }
  }

  // Generate playwright.config.ts
  const baseURL = projectInfo.baseURL || 'http://localhost:3000';

  // Phase D: emit tier-aware projects.
  //   - tierA-public runs everything not tagged @auth or @api (the legacy default).
  //   - tierB-auth-<role> runs tests tagged @auth under the role's storageState,
  //     one project per verified role. Failed logins drop out here — the user
  //     still gets Tier A + Tier C green.
  //   - tierC-backend runs tests tagged @api (API-only, no browser session).
  // Until the generator tags tests, @grepInvert on tierA-public means all
  // current tests run once under tierA-public — backwards-compatible.
  const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);

  // Per-tier retries live on the individual project so UI flakes don't get masked
  // as hard failures and so tierC (backend) doesn't waste budget on retryable HTTP
  // assertion bugs that are genuinely deterministic.
  const tierBProjects = verifiedRoles.map((r) => `    {
      name: 'tierB-auth-${String(r.role || 'user').replace(/[^a-zA-Z0-9_-]/g, '_')}',
      grep: /@auth|@tierB/,
      retries: 2,
      use: {
        ...devices['Desktop Chrome'],
        storageState: ${JSON.stringify(r.storageStatePath)},
      },
    }`).join(',\n');

  const projectsBlock = [
    `    {
      name: 'tierA-public',
      grepInvert: /@auth|@tierB|@api|@tierC/,
      retries: 2,
      use: { ...devices['Desktop Chrome'] },
    }`,
    tierBProjects,
    `    {
      name: 'tierC-backend',
      grep: /@api|@tierC/,
      retries: 1,
      use: { ...devices['Desktop Chrome'] },
    }`,
  ].filter(Boolean).join(',\n');

  const config = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  // 60 s per test — Supabase auth + Next.js SSR can easily push past 30 s on cold starts.
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'healix-reports/results/results.json' }],
    ['html', { open: 'never', outputFolder: 'healix-reports/html-report' }],
  ],
  use: {
    baseURL: '${baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: '${videoMode}',
  },
  projects: [
${projectsBlock}
  ],
});
`;

  const configPath = path.join(projectPath, 'playwright.config.ts');
  fs.writeFileSync(configPath, config, 'utf-8');
  Logger.info('PipelineWorker', 'Created playwright.config.ts', {
    path: configPath,
    tierBRoles: verifiedRoles.map((r) => r.role),
  });
  return {
    applied: true,
    reason: 'generated',
    configPath,
    tierBRoles: verifiedRoles.map((r) => r.role),
  };
}

function resolvePlaywrightConfig(projectPath) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getBundledPlaywrightPackageDir() {
  try {
    return path.dirname(require.resolve('@playwright/test/package.json'));
  } catch {
    return null;
  }
}

function ensureProjectPlaywrightBridge(projectPath) {
  const localPackageDir = path.join(projectPath, 'node_modules', '@playwright', 'test');
  if (fs.existsSync(localPackageDir)) {
    return { ok: true, bridged: false, packageDir: localPackageDir };
  }

  const bundledPackageDir = getBundledPlaywrightPackageDir();
  if (!bundledPackageDir) {
    return { ok: false, bridged: false, reason: 'bundled_playwright_missing' };
  }

  try {
    fs.mkdirSync(path.dirname(localPackageDir), { recursive: true });
    fs.symlinkSync(bundledPackageDir, localPackageDir, 'dir');
    return { ok: true, bridged: true, packageDir: localPackageDir };
  } catch (error) {
    if (fs.existsSync(localPackageDir)) {
      return { ok: true, bridged: false, packageDir: localPackageDir };
    }

    return {
      ok: false,
      bridged: false,
      reason: 'bridge_symlink_failed',
      error: error.message,
    };
  }
}

function resolvePlaywrightCliPath(projectPath) {
  try {
    return require.resolve('@playwright/test/cli', { paths: [projectPath] });
  } catch {
    // ignore and try package fallback
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json', { paths: [projectPath] });
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and try bridge/fallback
  }

  ensureProjectPlaywrightBridge(projectPath);

  try {
    return require.resolve('@playwright/test/cli', { paths: [projectPath] });
  } catch {
    // ignore and fallback to bundled resolution
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json', { paths: [projectPath] });
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and fallback to bundled resolution
  }

  try {
    return require.resolve('@playwright/test/cli');
  } catch {
    // ignore and fallback
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json');
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and fallback
  }

  const bundledBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'playwright');
  if (fs.existsSync(bundledBin)) {
    return bundledBin;
  }

  const projectBin = path.join(projectPath, 'node_modules', '.bin', 'playwright');
  if (fs.existsSync(projectBin)) {
    return projectBin;
  }

  return null;
}

function buildPlaywrightCommand(projectPath, testArgs) {
  const cliPath = resolvePlaywrightCliPath(projectPath);
  if (cliPath) {
    const isJsCli = cliPath.endsWith('.js');
    return {
      command: isJsCli ? process.execPath : cliPath,
      args: isJsCli ? [cliPath, ...testArgs] : testArgs,
      cliPath,
    };
  }

  return {
    command: 'npx',
    args: ['--yes', '@playwright/test', ...testArgs],
    cliPath: null,
  };
}

function buildPlaywrightEnv(projectPath, cliPath = null) {
  const currentNodePath = String(process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const extraNodePaths = [path.join(projectPath, 'node_modules')];
  if (cliPath && cliPath.endsWith('.js')) {
    const cliNodeModules = path.resolve(path.dirname(cliPath), '..', '..');
    extraNodePaths.push(cliNodeModules);
  }

  const mergedNodePath = [...new Set([...extraNodePaths, ...currentNodePath])];

  return {
    ...process.env,
    NODE_PATH: mergedNodePath.join(path.delimiter),
  };
}

async function validateGeneratedTestsWithList({ projectPath, validateGeneratedTests = true, timeoutMs = 90000 }) {
  if (!validateGeneratedTests) {
    return { valid: true, skipped: true, listedCount: 0 };
  }

  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { valid: false, reason: 'generated_tests_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name));

  if (testFiles.length === 0) {
    return { valid: false, reason: 'no_generated_tests' };
  }

  return new Promise((resolve) => {
    const testArgs = ['test', 'tests/generated', '--list'];
    const configPath = resolvePlaywrightConfig(projectPath);
    if (configPath) {
      testArgs.push('--config', configPath);
    }
    const command = buildPlaywrightCommand(projectPath, testArgs);

    const child = spawn(command.command, command.args, {
      cwd: projectPath,
      env: buildPlaywrightEnv(projectPath, command.cliPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ valid: false, reason: 'validation_timeout', stderr: stderr.slice(0, 2000) });
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const normalizedStdout = stdout.replace(/\u001b\[[0-9;]*m/g, '');
      const listLineMatches = normalizedStdout.match(/^[\s\S]*?$/gm) || [];
      const listedCount = listLineMatches.filter((line) => /\b›\b|\b\.spec\.(ts|js)\b|\btest\(/i.test(line)).length;

      if (code === 0 && listedCount > 0) {
        resolve({ valid: true, listedCount });
        return;
      }

      resolve({
        valid: false,
        reason: code !== 0 ? 'playwright_list_failed' : 'no_tests_listed',
        stdout: normalizedStdout.slice(0, 4000),
        stderr: stderr.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4000),
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ valid: false, reason: 'validation_spawn_failed', stderr: error.message });
    });
  });
}

/**
 * Build a structured diagnostics blob for pipeline-level failures — the things
 * that go wrong BEFORE any test actually runs (validation, quality audit,
 * server-start, etc.). This ends up on `error.diagnostics`, flows through the
 * run report, and is rendered by the dashboard as a proper failure banner with
 * the real stderr + a preview of one of the generated specs. Without this, the
 * user sees only the generic "usually caused by missing test runner
 * dependencies" message with no way to diagnose further.
 */
function buildPipelineDiagnostics({ projectPath, stage, reason, stderr, stdout, qualityAudit } = {}) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  let firstSpecPreview = null;
  let generatedSpecCount = 0;

  try {
    if (fs.existsSync(generatedDir)) {
      const files = fs.readdirSync(generatedDir).filter((name) => /\.spec\.(ts|js)$/i.test(name));
      generatedSpecCount = files.length;
      if (files.length > 0) {
        const firstPath = path.join(generatedDir, files[0]);
        const raw = fs.readFileSync(firstPath, 'utf-8');
        const lines = raw.split(/\r?\n/).slice(0, 80);
        firstSpecPreview = { file: files[0], lines: lines.join('\n') };
      }
    }
  } catch { /* best effort */ }

  const truncate = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

  // Never emit an unknown stage/reason — run it through the stderr classifier
  // so downstream banners always have structured fields the Cursor agent can
  // act on.
  const { classifyPipelineErrorFromStderr } = require('./failure-triage/pipeline-error-classifier');
  const classified = classifyPipelineErrorFromStderr({
    stderr: stderr || '',
    stdout: stdout || '',
    hintedStage: stage || null,
  });

  return {
    kind: 'pipeline',
    stage: stage && stage !== 'unknown' ? stage : classified.stage,
    reason: reason || classified.reason,
    errorCode: classified.errorCode,
    userFacingMessage: classified.userFacingMessage,
    stderr: truncate(stderr, 4000),
    stdout: truncate(stdout, 4000),
    firstSpecPreview,
    generatedSpecCount,
    qualityAuditErrors: qualityAudit?.errors || null,
  };
}

function auditGeneratedTestQuality({ projectPath, testType, context }) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const apiEndpointCount = (context?.apiEndpoints || []).length;
  Logger.info('PipelineWorker', `[QUALITY AUDIT] Starting audit — testType=${testType} apiEndpoints=${apiEndpointCount} dir=${generatedDir}`);

  const summary = {
    totalFiles: 0,
    apiFiles: 0,
    uiFiles: 0,
    hasApiBurstCoverage: false,
    selectorCoverageRatio: 0,
    riskyPatternHits: 0,
    riskyFiles: [],
    errors: [],
    warnings: [],
  };

  if (!fs.existsSync(generatedDir)) {
    Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ generated dir missing: ${generatedDir}`);
    summary.errors.push('generated_tests_missing');
    return { valid: false, ...summary };
  }

  const files = fs.readdirSync(generatedDir).filter((name) => /\.spec\.(ts|js)$/i.test(name));
  summary.totalFiles = files.length;
  Logger.info('PipelineWorker', `[QUALITY AUDIT] Found ${files.length} spec file(s): ${files.join(', ') || '(none)'}`);

  if (files.length === 0) {
    Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ No spec files found in ${generatedDir}`);
    summary.errors.push('no_generated_tests');
    return { valid: false, ...summary };
  }

  const preferredSelectorPattern = /getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/;
  const routeMockPattern = /page\.route\(/i;
  const checkValidityPattern = /\.checkValidity\(/i;
  const riskyUiPattern = /page\.pause\(/i;
  const riskyPhrasesPattern = /(invalid credentials|email is required|password is required|network error|try again|not found|does not exist|cannot find)/gi;
  const enforcePhraseRiskGates = String(process.env.HEALIX_ENFORCE_PHRASE_RISK_GATES || '').toLowerCase() === 'true';
  const knownCorpus = new Set();

  const collectKnownText = (value) => {
    if (!value) return;
    const normalized = String(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized) {
      knownCorpus.add(normalized);
    }
  };

  for (const page of context?.pages || []) {
    collectKnownText(page.path);
    collectKnownText(page.description);
    (page.components || []).forEach(collectKnownText);
    (page.interactions || []).forEach(collectKnownText);
    (page.selectorHints || []).forEach(collectKnownText);
  }

  for (const form of context?.forms || []) {
    (form.validationPatterns || []).forEach(collectKnownText);
    (form.submitButtons || []).forEach(collectKnownText);
    (form.selectorHints || []).forEach(collectKnownText);
    for (const field of form.fields || []) {
      collectKnownText(field.label);
      collectKnownText(field.placeholder);
      collectKnownText(field.name);
    }
  }

  for (const workflow of context?.workflows || []) {
    if (typeof workflow === 'string') {
      collectKnownText(workflow);
      continue;
    }
    collectKnownText(workflow.name);
    collectKnownText(workflow.description);
  }

  (context?.selectorHints || []).forEach(collectKnownText);

  let uiFilesWithPreferredSelectors = 0;

  for (const name of files) {
    const fullPath = path.join(generatedDir, name);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      summary.warnings.push(`failed_to_read:${name}`);
      continue;
    }

    const isApiFile = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(name);
    if (isApiFile) {
      summary.apiFiles += 1;
      const burstMatch = /Promise\.all|HEALIX_API_STRESS_BURST|burst|p95|percentile/i.test(content);
      if (burstMatch) {
        summary.hasApiBurstCoverage = true;
        Logger.info('PipelineWorker', `[QUALITY AUDIT]   ${name} → API file ✅ burst coverage detected`);
      } else {
        Logger.warn('PipelineWorker', `[QUALITY AUDIT]   ${name} → API file ⚠️  NO burst coverage (need Promise.all|HEALIX_API_STRESS_BURST|burst|p95|percentile)`);
      }
    } else {
      summary.uiFiles += 1;
      if (preferredSelectorPattern.test(content)) {
        uiFilesWithPreferredSelectors += 1;
      }

      if (routeMockPattern.test(content)) {
        summary.warnings.push(`uses_route_mocking:${name}`);
      }

      if (checkValidityPattern.test(content)) {
        summary.warnings.push(`uses_check_validity:${name}`);
      }

      if (riskyUiPattern.test(content)) {
        summary.riskyPatternHits += 1;
        summary.riskyFiles.push(name);
      }

      const phraseMatches = content.match(riskyPhrasesPattern) || [];
      for (const phrase of phraseMatches) {
        const normalizedPhrase = String(phrase)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const grounded = Array.from(knownCorpus).some((known) =>
          known.includes(normalizedPhrase) || normalizedPhrase.includes(known)
        );
        if (!grounded) {
          if (enforcePhraseRiskGates) {
            summary.riskyPatternHits += 1;
            summary.riskyFiles.push(name);
          } else {
            summary.warnings.push(`ungrounded_error_phrase:${name}`);
          }
          break;
        }
      }
    }
  }

  summary.selectorCoverageRatio = summary.uiFiles > 0
    ? Number((uiFilesWithPreferredSelectors / summary.uiFiles).toFixed(2))
    : 1;

  // Full-stack frameworks (Next.js, Nuxt, Remix) expose server-side logic
  // through UI flows and server actions rather than standalone REST clients.
  // Their generated tests look like UI tests to the auditor even when they
  // cover server routes, so we demote these to warnings rather than errors.
  const isFullStackFramework = ['nextjs', 'nuxt', 'remix'].includes(
    context?.projectStructure?.framework
  );

  // API-file checks only hard-fail for testType === 'backend' on non-full-stack
  // frameworks. For testType === 'both' and full-stack frameworks (Next.js,
  // Nuxt, Remix), server-side logic is tested via UI flows / server actions so
  // there will legitimately be zero request.get/post() API test files.
  // The context-gatherer also injects a synthetic /api/health endpoint when no
  // real ones are found, so apiEndpoints.length > 0 is not a reliable signal.
  if (testType === 'backend' && !isFullStackFramework && (context?.apiEndpoints || []).length > 1) {
    if (summary.apiFiles === 0) {
      Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ GATE FAIL: missing_api_test_files — no files matched API pattern despite ${apiEndpointCount} detected endpoint(s)`);
      summary.errors.push('missing_api_test_files');
    }
    if (!summary.hasApiBurstCoverage) {
      summary.warnings.push('missing_api_burst_coverage');
    }
  } else if ((testType === 'backend' || testType === 'both') && (context?.apiEndpoints || []).length > 0) {
    if (summary.apiFiles === 0) {
      summary.warnings.push('missing_api_test_files');
    }
    if (!summary.hasApiBurstCoverage) {
      summary.warnings.push('missing_api_burst_coverage');
    }
  } else {
    Logger.info('PipelineWorker', `[QUALITY AUDIT] Backend gate skipped — testType=${testType} apiEndpoints=${apiEndpointCount}`);
  }

  if ((testType === 'frontend' || testType === 'both') && summary.uiFiles > 0 && summary.selectorCoverageRatio < 0.5) {
    summary.warnings.push('low_preferred_selector_coverage');
  }

  summary.riskyFiles = [...new Set(summary.riskyFiles)];

  const auditValid = summary.errors.length === 0;
  if (auditValid) {
    Logger.info('PipelineWorker', `[QUALITY AUDIT] ✅ PASS — apiFiles=${summary.apiFiles} uiFiles=${summary.uiFiles} hasApiBurstCoverage=${summary.hasApiBurstCoverage} warnings=${summary.warnings.length}`);
  } else {
    Logger.warn('PipelineWorker', `[QUALITY AUDIT] ❌ FAIL — errors=${JSON.stringify(summary.errors)} apiFiles=${summary.apiFiles} uiFiles=${summary.uiFiles} hasApiBurstCoverage=${summary.hasApiBurstCoverage}`);
  }

  return {
    valid: auditValid,
    ...summary,
  };
}

function installMissingDependencies(projectPath, testsDir) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    Logger.warn('PipelineWorker', 'Cannot install dependencies - package.json not found');
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {})
  };

  // Scan generated test files for imports
  const testFiles = fs.readdirSync(testsDir).filter(f => /\.spec\.(ts|js)$/i.test(f));
  const missingDeps = new Set();

  testFiles.forEach(file => {
    const content = fs.readFileSync(path.join(testsDir, file), 'utf-8');
    // Match: import ... from 'package' or import('package') or require('package')
    const importMatches = content.matchAll(/(?:import\s+.*?\s+from\s+['"]([^'"./][^'"]*?)['"]|import\(['"]([^'"./][^'"]*?)['"]\)|require\(['"]([^'"./][^'"]*?)['"]\))/g);
    
    for (const match of importMatches) {
      const pkg = match[1] || match[2] || match[3];
      if (pkg && !allDeps[pkg] && !pkg.startsWith('@playwright/')) {
        // Extract base package name (e.g., 'axios/lib/core' -> 'axios')
        const basePkg = pkg.split('/')[0];
        missingDeps.add(basePkg);
      }
    }
  });

  if (missingDeps.size === 0) {
    return;
  }

  const depsToInstall = Array.from(missingDeps);
  Logger.info('PipelineWorker', `Installing missing dependencies for generated tests: ${depsToInstall.join(', ')}`);

  try {
    const installCmd = `npm install --save-dev ${depsToInstall.join(' ')}`;
    execSync(installCmd, { cwd: projectPath, stdio: 'pipe' });
    Logger.info('PipelineWorker', `Successfully installed: ${depsToInstall.join(', ')}`);
  } catch (error) {
    Logger.warn('PipelineWorker', `Failed to install dependencies: ${error.message}`);
  }
}

/**
 * Pick the set of agents to fan out to, mirroring the webapp's internal gating
 * rules (openai-generator.ts:241-272). Filtering MCP-side avoids wasted Vercel
 * invocations for agents that the webapp would no-op anyway, and keeps the
 * `generation_partial` telemetry honest (N/N never overcounts).
 *
 * apiOnly short-circuits everything UI-adjacent → just `api`. Non-apiOnly
 * backend still gets `smoke` because the existing smoke generator emits
 * backend smokes too when applicable.
 */
function pickAgentsForRun(
  testType,
  projectInfo = {},
  context = {},
  parsedPRD = null,
  explorationArtifact = null,
  options = {},
) {
  const apiOnly = projectInfo && projectInfo.apiOnly === true;
  const addUnique = (agents, agent) => {
    if (!agents.includes(agent)) agents.push(agent);
  };

  if (apiOnly) {
    const agents = ['api'];
    if (options.includeErrorStates && Array.isArray(context.errorScenarios) && context.errorScenarios.length > 0) {
      agents.push('error');
    }
    return agents;
  }

  const normalizedTestType = testType || 'both';
  const agents = [];
  if (options.includeSmoke !== false) {
    agents.push('smoke');
  }

  if (normalizedTestType === 'frontend' || normalizedTestType === 'both') {
    if (
      (Array.isArray(context.pages) && context.pages.length > 0) ||
      context.navigationGraph ||
      parsedPRD ||
      explorationArtifact
    ) {
      addUnique(agents, 'frontend');
    }
  }

  if (normalizedTestType === 'backend' || normalizedTestType === 'both') {
    if ((Array.isArray(context.apiEndpoints) && context.apiEndpoints.length > 0) || parsedPRD) {
      addUnique(agents, 'api');
    }
  }

  if (options.includeWorkflows !== false && Array.isArray(context.workflows) && context.workflows.length > 0) {
    addUnique(agents, 'workflow');
  }

  if (options.includeErrorStates && Array.isArray(context.errorScenarios) && context.errorScenarios.length > 0) {
    addUnique(agents, 'error');
  }

  return agents.length > 0 ? agents : ['smoke'];
}

function buildAgentHealth({ agents = [], agentsCompleted = [], agentFailures = [], files = [] } = {}) {
  const agentsRequested = [...new Set((agents || []).filter(Boolean))];
  const completed = [...new Set((agentsCompleted || []).filter(Boolean))];
  const failures = (agentFailures || [])
    .filter(Boolean)
    .map((failure) => ({
      agent: failure.agent || 'unknown',
      code: failure.code || null,
      message: failure.message || '',
    }));
  const failureSet = new Set(failures.map((failure) => failure.agent));
  const completedSet = new Set(completed);
  const missingAgents = agentsRequested.filter((agent) => !completedSet.has(agent) && !failureSet.has(agent));
  const filesByAgent = {};
  for (const file of files || []) {
    const agent = file?.agent || 'unknown';
    filesByAgent[agent] = (filesByAgent[agent] || 0) + 1;
  }
  const totalFiles = Array.isArray(files) ? files.length : 0;
  const allAgentsFailed = agentsRequested.length > 0 &&
    totalFiles === 0 &&
    agentsRequested.every((agent) => failureSet.has(agent));

  return {
    ok: missingAgents.length === 0 && !allAgentsFailed,
    agentsRequested,
    agentsCompleted: completed,
    agentFailures: failures,
    missingAgents,
    filesByAgent,
    totalFiles,
    partialSuccess: totalFiles > 0 && (failures.length > 0 || missingAgents.length > 0),
    allAgentsFailed,
  };
}

async function maybeGenerateViaSaaS({
  config,
  context,
  prdContent,
  testsDir,
  projectInfo,
  parsedPRD,
  explorationArtifact,
  roles,
  statusDir = null,
  runId = null,
  runBudget = null,
}) {
  const healixApiKey = process.env.HEALIX_API_KEY;
  if (!healixApiKey) {
    const err = new Error(
      'Healix test generation requires HEALIX_API_KEY.\n' +
      'Please configure it in your MCP settings:\n' +
      '{\n' +
      '  "env": {\n' +
      '    "HEALIX_API_KEY": "tb_your_key_here",\n' +
      '    "HEALIX_DASHBOARD_URL": "https://your-healix-dashboard.com"\n' +
      '  }\n' +
      '}'
    );
    err.code = 'MISSING_HEALIX_API_KEY';
    throw err;
  }

  if (!context) {
    return { generated: 0, files: [], skipped: true, reason: 'missing_context' };
  }

  // Guard: template-only generationMode is fundamentally incompatible with the
  // per-agent fan-out path we're about to take. The webapp client needs
  // AI-backed generation to fulfil per-agent scoped requests; template-only
  // bypasses the webapp entirely. If a caller reaches this point with
  // template-only, it means P0-3b's auto-upgrade didn't fire (probably because
  // the project isn't a local path) — we'd rather fail loudly than silently
  // ignore the user's requested mode. See P0-3c.
  if (config.generationMode === 'template-only') {
    const err = new Error(
      'generationMode=template-only is incompatible with the per-agent parallel fan-out. ' +
      'Either set strictAIGeneration=true (default) to use the AI-backed generator, or run ' +
      'against a project where the template-only path still exists. The current worker only ' +
      'supports AI-backed per_agent_parallel generation.'
    );
    err.code = 'INCOMPATIBLE_GENERATION_MODE';
    err.metadata = {
      generationMode: config.generationMode,
      chunkingStrategy: 'per_agent_parallel',
    };
    throw err;
  }

  const strictAI = strictAIEnabled(config);
  const client = new WebappClient({ apiKey: healixApiKey });

  const sharedPayload = {
    context,
    prd: prdContent || '',
    parsedPRD: parsedPRD || null,
    explorationArtifact: explorationArtifact || null,
    roles: roles || [],
    testType: config.testType,
    projectInfo,
    options: {
      includeSmoke: true,
      includeWorkflows: true,
      includeErrorStates: true,
      strictAIGeneration: strictAI,
      coverageProfile: config.coverageProfile || 'qa-max',
      minGeneratedTests: toFiniteNumber(config.minGeneratedTests, 50),
    },
  };

  const agents = pickAgentsForRun(
    config.testType,
    projectInfo,
    context,
    parsedPRD,
    explorationArtifact,
    sharedPayload.options,
  );

  // ── P1.5 planner pre-pass ────────────────────────────────────────────────
  // One HTTP call to /api/generate-tests/plan BEFORE the fan-out. The plan
  // gets projected into per-agent slices so each agent's prompt scopes down
  // to its assigned targets. Gated on !HEALIX_SKIP_PLANNER so an env flip
  // can disable the new path without redeploying. Any failure (timeout,
  // network, 5xx, feature-absent 404) degrades cleanly to the legacy
  // no-plan fan-out.
  let plan = null;
  let planMeta = null;
  if (!process.env.HEALIX_SKIP_PLANNER) {
    try {
      const planResult = await client.planGeneration({
        context,
        prd: prdContent || '',
        parsedPRD: parsedPRD || null,
        explorationArtifact: explorationArtifact || null,
        roles: roles || [],
        projectInfo,
        options: sharedPayload.options,
      });
      if (planResult && planResult.fallback) {
        planMeta = { status: `plan_skipped_${planResult.fallback}` };
      } else if (planResult && planResult.plan) {
        plan = planResult.plan;
        planMeta = {
          status: 'plan_generated',
          totalPlannedTests: plan.totalPlannedTests,
          cache: planResult.cache || null,
        };
        const pt = planResult.plannerTokens;
        if (pt && pt.totalTokens > 0) {
          Logger.info('PipelineWorker', '[TOKEN USAGE] planner prompt=' + pt.promptTokens + ' completion=' + pt.completionTokens + ' total=' + pt.totalTokens + ' cache=' + (planResult.cache || 'miss'));
        } else {
          Logger.info('PipelineWorker', '[TOKEN USAGE] planner — cache=' + (planResult.cache || 'miss') + ' (no tokens charged)');
        }
        // Persist the plan to runDir for post-mortem inspection. The MCP
        // already writes status.json / manifest here, so reusing the same
        // dir keeps all run telemetry in one place.
        const runDir = statusDir; // statusDir == runDir when provided
        if (runDir) {
          try {
            fs.writeFileSync(
              path.join(runDir, 'plan.json'),
              JSON.stringify(plan, null, 2),
            );
          } catch {
            /* best-effort — never block generation on a disk hiccup */
          }
          try {
            updateStatus(runDir, 'plan_generated', {
              totalPlannedTests: plan.totalPlannedTests,
              runId,
            });
          } catch {
            /* noop */
          }
        }
      }
    } catch (err) {
      planMeta = {
        status: err?.code === 'WEBAPP_TIMEOUT' ? 'plan_skipped_timeout' : 'plan_failed_fallback',
        error: err?.message || String(err),
      };
    }
  } else {
    planMeta = { status: 'plan_skipped_env_flag' };
  }

  const planSliceFor = (agent) => {
    // Expansion sits outside the planner's scope — it's a coverage
    // gap-filler triggered post-fan-out, so no slice applies.
    if (agent === 'expansion') return null;
    if (!plan) return null;
    const fe = plan.frontendPlan || null;
    const be = plan.backendPlan || null;
    switch (agent) {
      case 'smoke':
        return {
          smokeTargets: fe?.smokeTargets || [],
          plannedTests: fe?.plannedTests || 0,
        };
      case 'frontend':
        return {
          pages: fe?.pages || [],
          workflows: fe?.workflows || [],
        };
      case 'api':
        return {
          endpoints: be?.endpoints || [],
          apiFlows: be?.apiFlows || [],
        };
      case 'workflow':
        return {
          workflows: fe?.workflows || [],
        };
      case 'error': {
        const negativeRegex = /not |fail|error|invalid/i;
        const negativeAssertions = (fe?.pages || []).flatMap((p) =>
          (p.assertions || []).filter((a) => negativeRegex.test(String(a))),
        );
        const errorCases = (be?.endpoints || []).flatMap((e) => e.errorCases || []);
        return { negativeAssertions, errorCases };
      }
      default:
        return null;
    }
  };

  // ── P2-h async branch decision ───────────────────────────────────────────
  // When HEALIX_GEN_ASYNC=true, skip the per-agent HTTP fan-out and enqueue
  // a single async generation job instead, progressively polling for partials.
  // The webapp orchestrator handles per-agent dispatch on the server side.
  const asyncMode = String(process.env.HEALIX_GEN_ASYNC || '').toLowerCase() === 'true';
  if (asyncMode) {
    return await runAsyncGenerationPath({
      client,
      agents,
      sharedPayload,
      testsDir,
      runId,
      statusDir,
      runBudget,
      plan,
      planMeta,
      config,
      // Phase-1 sync fallback reuses these to stay DRY:
      context,
      prdContent,
      projectInfo,
      parsedPRD,
      explorationArtifact,
      roles,
      planSliceFor,
    });
  }

  return await runPhase1FanOut({
    client,
    agents,
    sharedPayload,
    testsDir,
    runId,
    statusDir,
    config,
    plan,
    planMeta,
    planSliceFor,
  });
}

/**
 * P1 per-agent parallel fan-out — one generateTestsForAgent call per agent,
 * all in flight simultaneously. A rejection in one agent cannot cancel the
 * others; failures accumulate in `agentFailures[]` and we only hard-fail the
 * stage if every agent rejected AND nothing landed on disk.
 *
 * Extracted so the P2-h async path can reuse it as a `{mode:'sync'}`
 * back-compat fallback when the webapp doesn't understand the async contract.
 */
async function runPhase1FanOut({
  client,
  agents,
  sharedPayload,
  testsDir,
  runId,
  statusDir,
  config,
  plan,
  planMeta,
  planSliceFor,
}) {
  const used = new Set();
  const files = [];
  const agentFailures = [];
  const agentsCompleted = [];
  const agentMeta = [];
  const allTokenRuns = [];
  let doneCount = 0;

  // Dispatch agents in batches of 2 to prevent connection starvation.
  // Firing all 5 simultaneously causes the webapp to queue the 3rd+ requests
  // while holding the HTTP connection open — after ~5 minutes the Next.js dev
  // server closes the idle connection → "fetch failed" TypeError for smoke and
  // workflow agents. Two concurrent agents saturate the webapp's AI pipeline
  // without leaving any connection idle long enough to be dropped.
  const AGENT_CONCURRENCY = 2;

  async function runAgent(agent) {
    try {
      const agentSlice = planSliceFor(agent);
      const agentPayload = { agent, ...sharedPayload };
      if (plan && agentSlice) {
        agentPayload.plan = { slice: agentSlice, planVersion: 1 };
      }
      const payload = await client.generateTestsForAgent(agentPayload);

        // ── Token usage logging ──────────────────────────────────────────
        const REAL_TOKENS_PER_DISPLAY_UNIT = 4800;
        if (Array.isArray(payload?.agentRuns) && payload.agentRuns.length > 0) {
          for (const run of payload.agentRuns) {
            allTokenRuns.push(run);
            const displayUnits = Math.floor((run.tokensTotal || 0) / REAL_TOKENS_PER_DISPLAY_UNIT);
            Logger.info('PipelineWorker', `[TOKEN USAGE] agent=${run.agent || agent} prompt=${run.tokensPrompt ?? 'n/a'} completion=${run.tokensCompletion ?? 'n/a'} total=${run.tokensTotal ?? 'n/a'} displayUnits=${displayUnits}`);
          }
        } else {
          Logger.info('PipelineWorker', `[TOKEN USAGE] agent=${agent} — no agentRuns in response (token data unavailable)`);
        }

      const tests = Array.isArray(payload?.tests) ? payload.tests : [];
      // Write this agent's tests to disk the moment the call returns —
      // makes partials durable even if a later agent blows up the run.
      tests.forEach((test) => {
        try {
          const written = safeWriteGeneratedTest(
            testsDir,
            test,
            files.length,
            `${agent}-saas`,
            used,
          );
          files.push({ ...written, type: test.type || 'generated', agent });
        } catch (writeErr) {
          // Single-file write failures shouldn't discard an agent's whole
          // result — log and skip this file only.
          Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed for one test', {
            agent,
            filename: test?.filename,
            reason: writeErr?.message,
          });
        }
      });
      agentsCompleted.push(agent);
      if (payload?.generationMeta) {
        agentMeta.push({ agent, generationMeta: payload.generationMeta });
      }
      doneCount += 1;
      if (statusDir) {
        try {
          updateStatus(statusDir, 'generating_tests', {
            runId,
            agent,
            agentsCompleted: doneCount,
            totalAgents: agents.length,
            generatedCount: files.length,
          });
        } catch {
          // status-writes are best-effort; never break the generator
        }
      }
      return { agent, count: tests.length };
    } catch (err) {
      agentFailures.push({
        agent,
        code: err?.code || 'AGENT_FAILED',
        message: err?.message || String(err),
      });
      throw err;
    }
  }

  // Process agents in batches of AGENT_CONCURRENCY; collect settled results
  // across all batches so the caller sees the same shape as before.
  const settled = [];
  for (let i = 0; i < agents.length; i += AGENT_CONCURRENCY) {
    const batch = agents.slice(i, i + AGENT_CONCURRENCY);
    const batchSettled = await Promise.allSettled(batch.map(runAgent));
    settled.push(...batchSettled);
  }

  const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
  const rejected = settled.length - fulfilled;

  // ── Aggregated token summary ─────────────────────────────────────────────
  {
    const REAL_TOKENS_PER_DISPLAY_UNIT = 4800;
    let totalPrompt = 0, totalCompletion = 0, totalReal = 0;
    for (const run of allTokenRuns) {
      totalPrompt += run.tokensPrompt || 0;
      totalCompletion += run.tokensCompletion || 0;
      totalReal += run.tokensTotal || 0;
    }
    const totalDisplayUnits = Math.floor(totalReal / REAL_TOKENS_PER_DISPLAY_UNIT);
    Logger.info('PipelineWorker', `[TOKEN SUMMARY] All agents settled — totalRealTokens=${totalReal} (prompt=${totalPrompt} completion=${totalCompletion}) displayUnitsConsumed=${totalDisplayUnits} (1 unit = ${REAL_TOKENS_PER_DISPLAY_UNIT} real tokens)`);
  }

  Logger.info('PipelineWorker', 'Per-agent generation settled', {
    totalAgents: agents.length,
    fulfilled,
    rejected,
    filesWritten: files.length,
    agentFailures: agentFailures.map((f) => `${f.agent}:${f.code}`),
  });

  const agentHealth = buildAgentHealth({
    agents,
    agentsCompleted,
    agentFailures,
    files,
  });

  if (agentHealth.missingAgents.length > 0) {
    const err = new Error(`Agent accounting incomplete: ${agentHealth.missingAgents.join(', ')} did not complete or fail`);
    err.code = 'AGENT_ACCOUNTING_INCOMPLETE';
    err.agentFailures = agentFailures;
    err.agentHealth = agentHealth;
    throw err;
  }

  // Hard fail only if every agent rejected AND nothing landed on disk.
  // Partial-success path: even a single agent's tests is enough to keep
  // the pipeline alive — validation + execution will run on what we have.
  if (agentHealth.allAgentsFailed || (files.length === 0 && rejected === agents.length)) {
    const firstFailure = agentFailures[0];
    const err = new Error(
      `All ${agents.length} agent generations failed` +
        (firstFailure ? `: ${firstFailure.agent}=${firstFailure.code}` : ''),
    );
    err.code = firstFailure?.code || 'GENERATION_FAILED';
    err.agentFailures = agentFailures;
    err.agentHealth = agentHealth;
    throw err;
  }

  // All agents fulfilled but every one returned zero tests. This happens when
  // OpenAI times out + strict mode suppresses the fallback suite, so the webapp
  // returns {success:true, tests:[]} for every scoped call. Surface as a
  // classifiable error instead of the generic "produced no files (unknown)"
  // that defaults to unclassified_pipeline_error downstream.
  if (files.length === 0 && rejected === 0) {
    const emptyAgents = agentMeta
      .filter((m) => {
        const t = m?.generationMeta?.totalGeneratedTests;
        return typeof t !== 'number' || t === 0;
      })
      .map((m) => m.agent);
    const err = new Error(
      `All ${agents.length} agent generations returned zero tests` +
        (emptyAgents.length > 0 ? ` (empty: ${emptyAgents.join(', ')})` : ''),
    );
    err.code = 'AGENTS_RETURNED_ZERO_TESTS';
    err.agentFailures = agentFailures;
    err.agentHealth = agentHealth;
    throw err;
  }

  // Deps must be installed once, after all writes are done (dedupes axios/etc.
  // across agents — installing during the Promise.allSettled loop would race).
  installMissingDependencies(config.projectPath, testsDir);

  return {
    generated: files.length,
    files,
    provider: 'saas',
    generationMeta: {
      chunkingStrategy: 'per_agent_parallel',
      agentsRequested: agents,
      agentsCompleted,
      agentFailures,
      agentHealth,
      filesByAgent: agentHealth.filesByAgent,
      partialsWrittenCount: files.length,
      plannedTests: plan?.totalPlannedTests ?? 0,
      planStatus: planMeta?.status || null,
      agentMeta,
    },
  };
}

/**
 * P2-h async generation path. Enqueues one job on the webapp orchestrator
 * and polls for partials, writing each new test spec to disk as it arrives
 * (dedupe by filename). Falls back to the Phase-1 fan-out if the webapp
 * replies with {mode:'sync'} (i.e. the server doesn't speak async yet).
 *
 * Error policy:
 *   - client.generateTestsAsync throws → propagate; outer tryGenerator handles.
 *   - pollGenerationJob POLL_ABORTED → propagate (outer run-budget fired).
 *   - pollGenerationJob WEBAPP_TIMEOUT → propagate → TIME_BUDGET_EXCEEDED.
 *   - pollGenerationJob WEBAPP_UNREACHABLE → propagate → rescue path scavenges.
 *   - final status === 'failed' && files.length === 0 → throw ALL_AGENTS_FAILED.
 *   - final status === 'partial' | 'succeeded' → return normally.
 */
async function runAsyncGenerationPath({
  client,
  agents,
  sharedPayload,
  testsDir,
  runId,
  statusDir,
  runBudget,
  plan,
  planMeta,
  config,
  planSliceFor,
}) {
  // Build a whole-plan slice for the orchestrator (it fans out internally).
  const planArg = plan
    ? { slice: plan, planVersion: 1 }
    : undefined;

  const enqueueResp = await client.generateTestsAsync({
    agents,
    context: sharedPayload.context,
    prd: sharedPayload.prd,
    parsedPRD: sharedPayload.parsedPRD,
    explorationArtifact: sharedPayload.explorationArtifact,
    roles: sharedPayload.roles,
    projectInfo: sharedPayload.projectInfo,
    options: sharedPayload.options,
    plan: planArg,
    idempotencyKey: runId ? `${runId}-saas-gen-v1` : undefined,
  });

  // Back-compat: older webapp returned a full sync payload. Two options:
  //   (1) write the payload's tests here inline, (2) fall through to Phase-1.
  // (2) is simpler + keeps the sync-path invariants, so call runPhase1FanOut.
  // Note: the sync payload itself contains pre-computed tests but those came
  // from the webapp's legacy non-async pipeline — there's no harm writing
  // them here directly since that's what Phase-1 would have produced. But
  // for simplicity (and to keep a single source of truth for the sync
  // contract), we just re-invoke the fan-out loop, which will call
  // generateTestsForAgent the same way the non-async branch does.
  //
  // Exception: if the sync payload actually carries tests, prefer writing
  // them directly — avoids a second round-trip.
  if (enqueueResp?.mode === 'sync') {
    const syncPayload = enqueueResp.payload || {};
    const syncTests = Array.isArray(syncPayload.tests) ? syncPayload.tests : null;
    if (syncTests) {
      const used = new Set();
      const files = [];
      const seen = new Set();
      for (const t of syncTests) {
        if (!t?.filename || seen.has(t.filename)) continue;
        seen.add(t.filename);
        try {
          const written = safeWriteGeneratedTest(testsDir, t, files.length, 'saas-sync', used);
          files.push({ ...written, type: t.type || 'generated', agent: t.agent || null });
        } catch (writeErr) {
          Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed (sync fallback)', {
            filename: t?.filename,
            reason: writeErr?.message,
          });
        }
      }

      if (files.length === 0) {
        const err = new Error('Async sync-fallback returned zero writable tests');
        err.code = 'GENERATION_FAILED';
        throw err;
      }

      installMissingDependencies(config.projectPath, testsDir);
      const completedFromPayload = Array.isArray(syncPayload.agentsCompleted)
        ? syncPayload.agentsCompleted
            .map((a) => (typeof a === 'string' ? a : a?.agent))
            .filter(Boolean)
        : [];
      const completedAgents = completedFromPayload.length > 0
        ? completedFromPayload
        : [...new Set(files.map((file) => file.agent).filter(Boolean))];
      const agentHealth = buildAgentHealth({
        agents,
        agentsCompleted: completedAgents.length > 0 ? completedAgents : agents,
        agentFailures: [],
        files,
      });

      return {
        generated: files.length,
        files,
        provider: 'saas',
        generationMeta: {
          chunkingStrategy: 'async_sync_fallback',
          agentsRequested: agents,
          agentsCompleted: agentHealth.agentsCompleted,
          agentFailures: [],
          agentHealth,
          filesByAgent: agentHealth.filesByAgent,
          partialsWrittenCount: files.length,
          plannedTests: plan?.totalPlannedTests ?? 0,
          planStatus: planMeta?.status || null,
          ...(syncPayload.generationMeta || {}),
        },
      };
    }

    // No tests in the sync payload → degrade all the way to Phase-1 fan-out.
    return await runPhase1FanOut({
      client,
      agents,
      sharedPayload,
      testsDir,
      runId,
      statusDir,
      config,
      plan,
      planMeta,
      planSliceFor,
    });
  }

  const { jobId, agentsRequested } = enqueueResp;
  const agentsRequestedList = Array.isArray(agentsRequested) && agentsRequested.length > 0
    ? agentsRequested
    : agents;

  if (statusDir) {
    try {
      updateStatus(statusDir, 'generation_async_enqueued', {
        runId,
        jobId,
        agentsRequested: agentsRequestedList,
      });
    } catch { /* status writes are best-effort */ }
  }

  // Compute poll timeout: bounded by remaining stage budget. If no runBudget
  // is threaded (e.g. from a direct test invocation), fall back to a 15-min
  // ceiling — still short enough that a stuck job can't black-hole the run.
  const stageCap = runBudget?.stageCaps?.generation ?? 15 * 60 * 1000;
  const remaining = runBudget ? getBudgetRemainingMs(runBudget) : stageCap;
  const pollTimeoutMs = Math.max(60_000, Math.min(remaining, stageCap));

  // Hook an AbortController so outer orchestration (e.g. withStageBudget) can
  // cancel an in-flight poll. We expose the controller via runBudget if the
  // budget struct carries an `abortSignals` registry (future-proofing —
  // today's runBudget doesn't, so this is a no-op).
  const abortController = new AbortController();
  if (runBudget && Array.isArray(runBudget.abortSignals)) {
    try { runBudget.abortSignals.push(abortController); } catch { /* noop */ }
  }

  const used = new Set();
  const files = [];
  const seenFilenames = new Set();

  const writeNewTests = (incoming, sourceTag) => {
    let newlyWritten = 0;
    for (const t of incoming || []) {
      if (!t?.filename || seenFilenames.has(t.filename)) continue;
      seenFilenames.add(t.filename);
      try {
        const written = safeWriteGeneratedTest(
          testsDir,
          t,
          files.length,
          sourceTag,
          used,
        );
        files.push({ ...written, type: t.type || 'generated', agent: t.agent || null });
        newlyWritten += 1;
      } catch (writeErr) {
        Logger.warn('PipelineWorker', 'safeWriteGeneratedTest failed (async path)', {
          filename: t?.filename,
          reason: writeErr?.message,
        });
      }
    }
    return newlyWritten;
  };

  const finalResp = await client.pollGenerationJob({
    jobId,
    pollIntervalMs: 3_000,
    timeoutMs: pollTimeoutMs,
    signal: abortController.signal,
    onProgress: ({ status, agentsCompleted, tests }) => {
      const newlyWritten = writeNewTests(tests, 'saas-async');
      if (statusDir) {
        try {
          const completedCount = Array.isArray(agentsCompleted)
            ? agentsCompleted.length
            : (Number.isFinite(agentsCompleted) ? agentsCompleted : 0);
          updateStatus(statusDir, 'generation_async_progress', {
            runId,
            jobId,
            status,
            agentsCompleted: completedCount,
            agentsRequested: agentsRequestedList.length,
            generatedCount: files.length,
            newlyWritten,
          });
        } catch { /* status writes are best-effort */ }
      }
    },
  });

  // The server's final response may contain tests we haven't seen via
  // onProgress (e.g. the last tick batched a bunch). Fold them in.
  if (finalResp && Array.isArray(finalResp.tests)) {
    writeNewTests(finalResp.tests, 'saas-async');
  }

  const agentFailures = Array.isArray(finalResp?.errors)
    ? finalResp.errors.map((e) => ({
        agent: e?.agent || 'unknown',
        code: e?.code || e?.errorCode || 'AGENT_FAILED',
        message: e?.message || '',
      }))
    : [];

  const agentsCompletedList = Array.isArray(finalResp?.agentsCompleted)
    ? finalResp.agentsCompleted
        .map((a) => (typeof a === 'string' ? a : a?.agent))
        .filter(Boolean)
    : [];

  const agentHealth = buildAgentHealth({
    agents: agentsRequestedList,
    agentsCompleted: agentsCompletedList,
    agentFailures,
    files,
  });

  if (agentHealth.missingAgents.length > 0) {
    const err = new Error(`Async agent accounting incomplete: ${agentHealth.missingAgents.join(', ')} did not complete or fail`);
    err.code = 'AGENT_ACCOUNTING_INCOMPLETE';
    err.agentFailures = agentFailures;
    err.agentHealth = agentHealth;
    err.jobId = jobId;
    throw err;
  }

  // Hard fail only if the orchestrator says failed AND nothing landed on
  // disk. Matches Phase-1 behavior: any partial survives; only an empty
  // total-failure throws.
  if ((finalResp?.status === 'failed' && files.length === 0) || agentHealth.allAgentsFailed) {
    const firstFailure = agentFailures[0];
    const err = new Error(
      `Async generation job failed (jobId=${jobId})` +
        (firstFailure ? `: ${firstFailure.agent}=${firstFailure.code}` : ''),
    );
    err.code = 'ALL_AGENTS_FAILED';
    err.agentFailures = agentFailures.length > 0
      ? agentFailures
      : [{ agent: 'unknown', code: 'ALL_AGENTS_FAILED', message: err.message }];
    err.agentHealth = agentHealth;
    err.jobId = jobId;
    throw err;
  }

  // Deps install once after all writes (dedupes axios/etc. across agents).
  installMissingDependencies(config.projectPath, testsDir);

  return {
    generated: files.length,
    files,
    provider: 'saas',
    generationMeta: {
      chunkingStrategy: 'async_inngest',
      jobId,
      status: finalResp?.status || 'unknown',
      agentsRequested: agentsRequestedList,
      agentsCompleted: agentsCompletedList,
      agentFailures,
      agentHealth,
      filesByAgent: agentHealth.filesByAgent,
      partialsWrittenCount: files.length,
      plannedTests: plan?.totalPlannedTests ?? 0,
      planStatus: planMeta?.status || null,
      ...(finalResp?.generationMeta || {}),
    },
  };
}

async function generateWithFallbackChain({ config, context, prdContent, runBudget, projectInfo, parsedPRD, explorationArtifact, roles, statusDir = null, runId = null }) {
  const generationMeta = {
    provider: null,
    selectedGenerator: null,
    fallbackUsed: false,
    aiOnlyEnforced: true,
    templateFallbackEnabled: false,
    attempts: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const validateGeneratedTests = config.validateGeneratedTests !== false;

  const runValidation = async (generator) => withStageBudget(runBudget, 'validation', async () => {
    const validation = await validateGeneratedTestsWithList({
      projectPath: config.projectPath,
      validateGeneratedTests,
      timeoutMs: Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.validation),
    });

    if (!validation.valid) {
      const error = new Error(`${generator} generation failed validation: ${validation.reason || 'unknown'}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = validation;
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'validation',
        reason: validation.reason,
        stderr: validation.stderr,
        stdout: validation.stdout,
      });
      throw error;
    }

    const qualityAudit = auditGeneratedTestQuality({
      projectPath: config.projectPath,
      testType: config.testType,
      context,
    });

    Logger.info('PipelineWorker', '[QUALITY GATE] auditGeneratedTestQuality result', {
      valid: qualityAudit.valid,
      errors: qualityAudit.errors,
      warnings: qualityAudit.warnings,
      apiFiles: qualityAudit.apiFiles,
      uiFiles: qualityAudit.uiFiles,
      hasApiBurstCoverage: qualityAudit.hasApiBurstCoverage,
      selectorCoverageRatio: qualityAudit.selectorCoverageRatio,
      totalFiles: qualityAudit.totalFiles,
    });

    if (!qualityAudit.valid) {
      Logger.error('PipelineWorker', `[QUALITY GATE] ❌ Quality audit FAILED for generator="${generator}" — errors: ${qualityAudit.errors.join(', ')}`, null, {
        generator,
        errors: qualityAudit.errors,
        apiFiles: qualityAudit.apiFiles,
        hasApiBurstCoverage: qualityAudit.hasApiBurstCoverage,
        hint: 'If missing_api_burst_coverage: the generated API spec files need at least one burst/stress test using Promise.all, burst, p95, or percentile patterns.',
      });
      const error = new Error(`${generator} generation failed quality audit: ${qualityAudit.errors.join(',')}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = {
        ...validation,
        qualityAudit,
      };
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'quality_audit',
        reason: qualityAudit.errors.join(',') || 'quality_audit_failed',
        stderr: null,
        stdout: null,
        qualityAudit,
      });
      throw error;
    }

    return {
      ...validation,
      qualityAudit,
    };
  });

  // Rewrites bare @playwright/test imports to the Healix fixture and emits the
  // fixture file next to the specs. Runs unconditionally — the cursor overlay
  // flag no longer gates fixture wiring. Without this, auth-gated SPAs never
  // get storageState + splash bypass and every UI test redirects to '/'.
  const applyFixtureWiring = (generatorName) => {
    if (!config.generateTests) return null;
    try {
      const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);
      const fixtureResult = ensureHealixFixtureImports({ projectPath: config.projectPath, roles: verifiedRoles });
      if (fixtureResult.applied && fixtureResult.patchedFiles > 0) {
        Logger.info('PipelineWorker', 'Rewrote @playwright/test imports to __healix-fixture', {
          generator: generatorName,
          patched: fixtureResult.patchedFiles,
          total: fixtureResult.totalFiles,
        });
      }
      return fixtureResult;
    } catch (fixtureError) {
      Logger.warn('PipelineWorker', 'Failed to wire Healix fixture into generated specs', {
        generator: generatorName,
        reason: fixtureError.message,
      });
      return { applied: false, reason: 'patch_failed', error: fixtureError.message };
    }
  };

  const tryGenerator = async (generatorName, runFn) => {
    const startedAt = Date.now();

    try {
      const result = await withStageBudget(runBudget, 'generation', runFn);
      const fixtureWiring = applyFixtureWiring(generatorName);
      let cursorOverlay = null;
      if (config.generateTests) {
        try {
          cursorOverlay = applyMouseCursorOverlayToGeneratedTests({
            projectPath: config.projectPath,
            enabled: isVideoCursorEnabled(config),
          });
        } catch (cursorError) {
          cursorOverlay = {
            enabled: false,
            reason: 'patch_failed',
            error: cursorError.message,
          };
          Logger.warn('PipelineWorker', 'Failed to apply cursor overlay patch', {
            generator: generatorName,
            reason: cursorError.message,
          });
        }
      }
      const validation = await runValidation(generatorName);
      generationMeta.fixtureWiring = fixtureWiring;

      generationMeta.provider = generatorName;
      generationMeta.selectedGenerator = generatorName;
      generationMeta.fallbackUsed = false;
      generationMeta.videoCursor = cursorOverlay;
      generationMeta.attempts.push({
        generator: generatorName,
        status: 'success',
        generated: result.generated || result.files?.length || 0,
        durationMs: Date.now() - startedAt,
        validation,
        videoCursor: cursorOverlay,
      });

      return result;
    } catch (error) {
      const summarizedReason = summarizeGenerationAttemptError(error);
      const errorCode = error?.code ? String(error.code) : classifyErrorCode(error);

      // Partial-survival path: when withStageBudget trips TIME_BUDGET_EXCEEDED
      // mid-run, the per-agent Promise.allSettled inside maybeGenerateViaSaaS
      // may have already landed some agents' tests on disk. Rescue those
      // partials so validation + execution still run, rather than hard-failing
      // the run and throwing away completed work.
      //
      // Why only TIME_BUDGET_EXCEEDED: other errors (GENERATION_VALIDATION_FAILED,
      // OPENAI_KEY_MISSING, etc.) are semantically "this generator is broken,
      // try the next" and should fall through to the fallback chain. Budget
      // exhaustion is the one case where a correctly-behaving generator
      // simply ran out of clock.
      if (errorCode === 'TIME_BUDGET_EXCEEDED') {
        const rescued = rescuePartialGeneration({
          projectPath: config.projectPath,
          generatorName,
          error,
          startedAt,
          summarizedReason,
        });
        if (rescued) {
          // Run validation on the partial suite — if the written tests don't
          // compile, we still want the fallback chain to take over. If they
          // do, we continue to execution with whatever landed.
          try {
            // Apply fixture wiring BEFORE validation so rescued partials don't
            // compile-fail on missing fixture imports. Without this, a TIME_BUDGET
            // rescue followed by UI tests hitting auth gates loses storageState.
            const rescueFixtureWiring = applyFixtureWiring(`${generatorName}-partial`);
            generationMeta.fixtureWiring = rescueFixtureWiring;
            const validation = await runValidation(`${generatorName}-partial`);
            generationMeta.provider = generatorName;
            generationMeta.selectedGenerator = generatorName;
            generationMeta.fallbackUsed = false;
            generationMeta.partialGenerationWarning = {
              reason: 'budget_exceeded',
              generator: generatorName,
              partialsWrittenCount: rescued.generated,
              message: `Generation stage ran out of budget; proceeding with ${rescued.generated} test(s) that completed in time.`,
            };
            generationMeta.attempts.push({
              generator: generatorName,
              status: 'partial',
              reason: summarizedReason,
              rawReason: normalizeErrorText(error?.message),
              errorCode,
              generated: rescued.generated,
              validation,
              durationMs: Date.now() - startedAt,
            });
            return { ...rescued, generationMeta: { ...(rescued?.generationMeta || {}), ...generationMeta } };
          } catch (validationErr) {
            Logger.warn(
              'PipelineWorker',
              'Partial-rescue validation failed — falling through to full-failure path',
              {
                generator: generatorName,
                reason: validationErr?.message,
              },
            );
            // fall through to the normal failure path below
          }
        }
      }

      generationMeta.attempts.push({
        generator: generatorName,
        status: 'failed',
        reason: summarizedReason,
        rawReason: normalizeErrorText(error?.message),
        errorCode,
        validation: error.validation,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  };

  const result = await tryGenerator('saas', async () => {
    const testsDir = resetGeneratedTestsDir(config.projectPath);
    const saasResult = await maybeGenerateViaSaaS({
      config,
      context,
      prdContent,
      testsDir,
      projectInfo,
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
      statusDir,
      runId,
      runBudget,
    });

    if (!saasResult.generated) {
      throw new Error(`Backend test generation produced no files (${saasResult.reason || 'unknown'})`);
    }

    return saasResult;
  });

  generationMeta.finishedAt = new Date().toISOString();

  if (!result) {
    const primaryFailure = generationMeta.attempts[generationMeta.attempts.length - 1] || null;
    const errorCode = primaryFailure?.errorCode || 'GENERATION_FAILED';
    const reason = primaryFailure?.reason || null;
    const message = reason
      ? `Backend test generation failed: ${reason}`
      : 'Backend test generation failed. Ensure HEALIX_API_KEY is correctly configured and the backend is reachable.';

    const error = new Error(message);
    error.code = errorCode;
    error.generationMeta = generationMeta;
    error.primaryFailure = primaryFailure;
    throw error;
  }

  return {
    ...result,
    generationMeta: { ...(result?.generationMeta || {}), ...generationMeta },
  };
}

async function maybeRunFailureTriage({ config, testResults, runBudget, runId }) {
  if (config.aiFailureAnalysis === false) {
    return { analysis: null, evidenceBundles: [], verdicts: [], clusters: [] };
  }

  if (!testResults?.failures?.length) {
    return { analysis: null, evidenceBundles: [], verdicts: [], clusters: [] };
  }

  const limit = toFiniteNumber(config.aiFailureLimit || process.env.HEALIX_AI_TRIAGE_LIMIT, 8);
  const cappedFailures = testResults.failures.slice(0, limit);

  // Build evidence bundles before handing off to classifier + AI.
  let bundleResult = { bundles: [], skipped: 0 };
  try {
    const { bundleFailures } = require('./failure-triage/evidence-bundler');
    bundleResult = await bundleFailures({
      failures: cappedFailures,
      tests: testResults.tests || [],
      projectPath: config.projectPath,
      runId,
    });
  } catch (err) {
    Logger.warn('PipelineWorker', 'Evidence bundler failed — falling back to raw failures', { error: err?.message });
  }

  // Run deterministic classifier first — high-confidence verdicts skip AI
  // entirely, saving tokens and reducing the "blame the test" bias.
  let classifierResult = { verdicts: [], clusters: [], aiEligibleIndexes: [] };
  try {
    const { classifyFailures } = require('./failure-triage/classifier');
    classifierResult = classifyFailures(bundleResult.bundles);
    Logger.info('PipelineWorker', 'Classifier completed', {
      totalFailures: bundleResult.bundles.length,
      aiEligible: classifierResult.aiEligibleIndexes.length,
      clusters: classifierResult.clusters.length,
    });
  } catch (err) {
    Logger.warn('PipelineWorker', 'Classifier failed — all failures will go to AI', { error: err?.message });
    classifierResult.aiEligibleIndexes = bundleResult.bundles.map((_, i) => i);
  }

  // Annotate bundles with verdicts in-place so downstream consumers (report,
  // ingest, dashboard) have them.
  bundleResult.bundles.forEach((bundle, idx) => {
    const verdict = classifierResult.verdicts[idx];
    if (verdict) {
      bundle.classifierVerdict = verdict;
    }
  });

  const providerConfig = resolveFailureAnalysisProvider(config);
  if (providerConfig.reason) {
    Logger.info('PipelineWorker', 'Skipping AI failure triage', {
      reason: providerConfig.reason,
      provider: providerConfig.provider,
    });
    return {
      analysis: null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
    };
  }

  // Only send ambiguous / low-confidence failures to AI. If none remain, skip.
  const aiPayload = classifierResult.aiEligibleIndexes.length > 0
    ? classifierResult.aiEligibleIndexes.map((i) => bundleResult.bundles[i])
    : [];

  if (aiPayload.length === 0) {
    Logger.info('PipelineWorker', 'All failures resolved deterministically — skipping AI call');
    return {
      analysis: null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
    };
  }

  // Fallback: if bundler failed, ship raw failures so the old v1 path keeps working.
  const payload = bundleResult.bundles.length > 0 ? aiPayload : cappedFailures;

  return withStageBudget(runBudget, 'aiTriage', async () => {
    const analyzer = AIAnalyzer.create(providerConfig.provider, providerConfig.apiKey);
    const { analyses, tokenUsage: analyzeTokenUsage } = await analyzer.analyzeFailures(payload);
    if (analyzeTokenUsage && analyzeTokenUsage.totalTokens > 0) {
      Logger.info('PipelineWorker', '[TOKEN USAGE] analyze-failures', {
        prompt: analyzeTokenUsage.promptTokens,
        completion: analyzeTokenUsage.completionTokens,
        total: analyzeTokenUsage.totalTokens,
        model: analyzeTokenUsage.modelUsed,
      });
    }
    return {
      analysis: Array.isArray(analyses) ? analyses : null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
    };
  });
}

/**
 * Main pipeline function.
 */
async function runPipeline(config, runId) {
  const statusDir = path.join(config.projectPath, 'healix-reports', '.runs', runId);
  ensureDir(statusDir);
  const telemetryReporter = new MCPTelemetryReporter();

  // Localhost + HEALIX_GEN_ASYNC is off-path. The async route was added to
  // escape Vercel's 60s cap; for local dev the sync path is faster and doesn't
  // require Inngest. Warn once instead of silently going down the async fork.
  if (process.env.HEALIX_GEN_ASYNC === 'true') {
    const dashUrl = String(config.dashboardUrl || '');
    const webUrl = String(config.webappUrl || '');
    if (/localhost|127\.0\.0\.1/.test(dashUrl) || /localhost|127\.0\.0\.1/.test(webUrl)) {
      process.stderr.write('[HEALIX] HEALIX_GEN_ASYNC=true detected with localhost webapp — sync path is supported; async is off-path for local dev.\n');
    }
  }

  // Install durable-state + stage-budget reporters (fire-and-forget). Both are
  // best-effort: if the webapp is unreachable the pipeline keeps running.
  const durableClient = process.env.HEALIX_API_KEY
    ? new WebappClient({ apiKey: process.env.HEALIX_API_KEY })
    : null;
  if (durableClient) {
    setDurablePhaseReporter((payload) => {
      durableClient.reportPhase({
        runId,
        phase: payload.phase,
        metadata: { message: payload.message, errorCode: payload.errorCode || null },
      }).catch(() => undefined);
    });
    setStageBudgetReporter(({ stage, consumedMs, capMs, success }) => {
      durableClient.reportPhase({
        runId,
        phase: `stage:${stage}`,
        stageBudget: { stage, consumedMs, capMs },
        metadata: { success },
      }).catch(() => undefined);
    });
  } else {
    setDurablePhaseReporter(null);
    setStageBudgetReporter(null);
  }

  // Kill any leftover Healix-started dev server from a previous run.
  // We only kill what Healix wrote into this PID file — nothing else.
  const healixReportsDir = path.join(config.projectPath, 'healix-reports');
  const serverPidFile = path.join(healixReportsDir, HEALIX_SERVER_PID_FILENAME);
  killOrphanedHealixProcess(serverPidFile, 'dev-server');

  const runBudget = createRunBudget(config);
  let generationMeta = null;
  let fallbackUsed = false;
  let generationQuality = null;
  let playwright = null; // declared here so catch can call stopServer() on budget timeout
  let preStartedProc = null; // declared here so catch can kill it on pipeline failure
  let requirementsCoverage = null;
  let phaseResults = null;
  const aiOnlyEnforced = strictAIEnabled(config);

  updateStatus(statusDir, 'started', {
    runId,
    message: 'Healix started',
    project: config.projectName,
    budgetMs: runBudget.totalMs,
    aiOnlyEnforced,
  }, telemetryReporter);
  Logger.info('PipelineWorker', 'Pipeline started', {
    runId,
    project: config.projectName,
    budgetMs: runBudget.totalMs,
  });

  try {
    // -------------------------------------------------------
    // 0. Port pre-flight check (must run before test generation)
    // -------------------------------------------------------
    // If another process is already listening on the configured port, find a
    // free one NOW — before AI generates tests — so that test files are written
    // with the correct baseURL from the start.
    if (config.startCommand) {
      const configuredPort = Number(config.port || 0);
      if (configuredPort > 0) {
        const _tempPI = new PlaywrightIntegration(config);
        const portInUse = await _tempPI.probeTcpPort('127.0.0.1', configuredPort, 500)
          || await _tempPI.probeTcpPort('localhost', configuredPort, 500);
        if (portInUse) {
          const freePort = await _tempPI.findFreePort(configuredPort + 1);
          Logger.warn('PipelineWorker', `Port ${configuredPort} is already in use — switching dev server to port ${freePort}`, {
            originalPort: configuredPort,
            newPort: freePort,
          });
          // Clean up Next.js dev lock file — the existing server holds it and
          // SIGKILL won't release it, so the new instance would fail to start.
          const nextDevLock = path.join(config.projectPath, '.next', 'dev', 'lock');
          try {
            if (fs.existsSync(nextDevLock)) {
              fs.unlinkSync(nextDevLock);
              Logger.info('PipelineWorker', 'Removed stale Next.js dev lock file', { lockFile: nextDevLock });
            }
          } catch {
            // non-fatal — best effort
          }
          try {
            const parsedBase = new URL(config.baseURL);
            parsedBase.port = String(freePort);
            config = { ...config, port: freePort, baseURL: parsedBase.toString().replace(/\/$/, '') };
          } catch {
            config = { ...config, port: freePort, baseURL: `http://localhost:${freePort}` };
          }
          updateStatus(statusDir, 'port_conflict', {
            runId,
            message: `Port ${configuredPort} is already in use. Dev server will start on port ${freePort} instead.`,
            project: config.projectName,
            originalPort: configuredPort,
            newPort: freePort,
            aiOnlyEnforced,
          }, telemetryReporter);
        }
      }
    }

    // -------------------------------------------------------
    // 1. Jira integration (optional)
    // -------------------------------------------------------
    let jiraStories = null;
    if (config.jira?.enabled && JiraClient) {
      updateStatus(statusDir, 'jira', {
        runId,
        message: 'Fetching Jira stories...',
        aiOnlyEnforced,
      }, telemetryReporter);

      jiraStories = await withStageBudget(runBudget, 'jira', async () => {
        const jiraClient = new JiraClient(config.jira);
        const stories = await jiraClient.fetchActiveStories();
        Logger.info('PipelineWorker', 'Fetched Jira stories', { count: stories.length });
        return stories;
      });
    } else if (config.jira?.enabled && !JiraClient) {
      Logger.warn('PipelineWorker', 'Jira integration requested but jira/client module not available');
    }

    // -------------------------------------------------------
    // 2. Gather codebase context
    // -------------------------------------------------------
    let codebaseContext = config.codebaseContext;
    if (config.generateTests && !codebaseContext) {
      updateStatus(statusDir, 'context', {
        runId,
        message: 'Gathering codebase context...',
        aiOnlyEnforced,
      }, telemetryReporter);

      codebaseContext = await withStageBudget(runBudget, 'context', async () => {
        const contextGatherer = new ContextGatherer({
          projectPath: config.projectPath,
          language: config.language,
        });
        return contextGatherer.gatherRichContext();
      });

      Logger.info('PipelineWorker', 'Codebase context gathered', {
        pages: codebaseContext.pages?.length || 0,
        endpoints: codebaseContext.apiEndpoints?.length || 0,
        workflows: codebaseContext.workflows?.length || 0,
      });

      if (config.ideContextMode !== 'off') {
        updateStatus(statusDir, 'context_enrichment', {
          runId,
          message: 'Requesting optional IDE context enrichment...',
          aiOnlyEnforced,
        }, telemetryReporter);

        try {
          const requester = new AgentContextRequester({
            projectPath: config.projectPath,
            responseTimeout: toFiniteNumber(config.ideContextTimeoutMs, 2500),
          });

          const agentContext = await withStageBudget(runBudget, 'context', async () =>
            requester.requestContext(codebaseContext, toFiniteNumber(config.ideContextTimeoutMs, 2500))
          );

          if (agentContext && typeof agentContext === 'object' && Object.keys(agentContext).length > 0) {
            codebaseContext = requester.mergeContexts(codebaseContext, agentContext);
            const summary = requester.summarizeContext(codebaseContext);
            Logger.info('PipelineWorker', 'IDE context enrichment applied', summary);
          } else {
            Logger.info('PipelineWorker', 'IDE context enrichment not provided; continuing with auto-gathered context');
          }
        } catch (error) {
          Logger.warn('PipelineWorker', 'IDE context enrichment failed (best-effort)', { reason: error.message });
        }
      }
    }

    // -------------------------------------------------------
    // 3. Read PRD file(s) if specified
    // -------------------------------------------------------
    let prdContent = null;
    const prdContents = [];
    const prdErrors = [];

    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        prdContents.push(prdContent);
        Logger.info('PipelineWorker', 'Read PRD file', { path: config.prdFile, length: prdContent.length });
      } catch (error) {
        Logger.error('PipelineWorker', 'Could not read PRD file', { path: config.prdFile, reason: error.message });
        prdErrors.push({ path: config.prdFile, reason: error.message });
      }
    }

    if (Array.isArray(config.prdFiles) && config.prdFiles.length > 0) {
      for (const prdFilePath of config.prdFiles) {
        if (prdFilePath === config.prdFile) continue;
        try {
          const content = fs.readFileSync(prdFilePath, 'utf-8');
          prdContents.push(content);
          Logger.info('PipelineWorker', 'Read additional PRD file', { path: prdFilePath, length: content.length });
        } catch (error) {
          Logger.error('PipelineWorker', 'Could not read PRD file', { path: prdFilePath, reason: error.message });
          prdErrors.push({ path: prdFilePath, reason: error.message });
        }
      }
    }

    if (prdErrors.length > 0) {
      // Surface PRD-read failures as a run-level warning event instead of silently dropping them.
      updateStatus(statusDir, 'warning', {
        runId,
        message: `Some PRD file(s) could not be read and were skipped (${prdErrors.length}).`,
        prdErrors,
      }, telemetryReporter);
      process.stderr.write(`[HEALIX] PRD read failures for run ${runId}: ${JSON.stringify(prdErrors)}\n`);
    }

    // Auto-ingest: if the user didn't hand us any PRD at all, sniff the project
    // root for obvious candidates (README, PRD.md, docs/*.md). This is the
    // silent fallback that lets Healix still benefit from whatever the repo
    // ships — previously an empty prdFiles list just skipped this stage.
    const userSuppliedPrd = Boolean(
      config.prdFile || (Array.isArray(config.prdFiles) && config.prdFiles.length > 0)
    );
    if (!userSuppliedPrd && prdContents.length === 0 && config.projectPath) {
      try {
        const discovered = autoDiscoverPrdDocs(config.projectPath);
        if (discovered.paths.length > 0 && discovered.content) {
          prdContents.push(discovered.content);
          Logger.info('PipelineWorker', 'Auto-ingested PRD candidates', {
            paths: discovered.paths,
            totalBytes: discovered.totalBytes,
          });
          updateStatus(statusDir, 'auto_ingested_prd', {
            runId,
            paths: discovered.paths,
            totalBytes: discovered.totalBytes,
          }, telemetryReporter);
        }
      } catch (error) {
        // Silent-on-failure: autoscan must never break a run.
        Logger.warn('PipelineWorker', 'PRD auto-ingest failed (best-effort)', { reason: error.message });
      }
    }

    // Webapp Zod schema caps `prd` at MAX_PROMPT_CHARS (default 40 000). Truncate
    // here so both /api/parse-prd and /api/generate-tests accept the payload.
    // 38 000 gives a 2 000-char safety margin for multi-file join separators.
    const PRD_CHAR_CAP = 38_000;
    const rawCombinedPrdContent = prdContents.length > 0 ? prdContents.join('\n\n---\n\n') : null;
    const combinedPrdContent = rawCombinedPrdContent && rawCombinedPrdContent.length > PRD_CHAR_CAP
      ? rawCombinedPrdContent.slice(0, PRD_CHAR_CAP)
      : rawCombinedPrdContent;
    if (rawCombinedPrdContent && rawCombinedPrdContent.length > PRD_CHAR_CAP) {
      Logger.warn('PipelineWorker', `PRD truncated from ${rawCombinedPrdContent.length} to ${PRD_CHAR_CAP} chars to stay under webapp limit`);
    }

    // -------------------------------------------------------
    // 3a. Parse PRD into structured acceptance criteria (Phase B).
    //
    // Three paths converge here:
    //   (1) User uploaded a PRD file      → config.prdFile / config.prdFiles → combinedPrdContent
    //   (2) Cursor agent synthesised a PRD → submitted as prd text → persisted to disk upstream → same
    //   (3) No PRD at all                  → combinedPrdContent === null → skip entirely, generator
    //                                        falls back to context + exploration artifacts alone.
    //
    // If the /api/parse-prd call fails we don't kill the run — the raw PRD string is still
    // passed down and the generator degrades to free-form PRD mode.
    // -------------------------------------------------------
    let parsedPRD = null;
    if (combinedPrdContent && config.generateTests) {
      updateStatus(statusDir, 'parsing_prd', {
        runId,
        message: 'Parsing PRD into structured acceptance criteria...',
      }, telemetryReporter);
      try {
        const client = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
        const parseResponse = await withStageBudget(runBudget, 'prdParse', () =>
          client.parsePRD({ prdContent: combinedPrdContent })
        );
        parsedPRD = parseResponse?.parsedPRD || null;
        const prdTokens = parseResponse?.tokenUsage;
        if (prdTokens && prdTokens.totalTokens > 0) {
          Logger.info('PipelineWorker', '[TOKEN USAGE] parse-prd prompt=' + prdTokens.promptTokens + ' completion=' + prdTokens.completionTokens + ' total=' + prdTokens.totalTokens);
        } else if (parseResponse?.cached) {
          Logger.info('PipelineWorker', '[TOKEN USAGE] parse-prd — cached (no tokens charged)');
        }
        if (parsedPRD) {
          try {
            fs.writeFileSync(
              path.join(statusDir, 'parsed-prd.json'),
              JSON.stringify(parsedPRD, null, 2),
              'utf-8'
            );
          } catch (writeErr) {
            Logger.warn('PipelineWorker', 'Failed to cache parsed-prd.json', { reason: writeErr.message });
          }
          const featureCount = Array.isArray(parsedPRD.features) ? parsedPRD.features.length : 0;
          const acCount = Array.isArray(parsedPRD.features)
            ? parsedPRD.features.reduce((sum, f) =>
                sum + (Array.isArray(f.userStories)
                  ? f.userStories.reduce((s, st) =>
                      s + (Array.isArray(st.acceptanceCriteria) ? st.acceptanceCriteria.length : 0), 0)
                  : 0), 0)
            : 0;
          Logger.info('PipelineWorker', 'PRD parsed', { featureCount, acCount, cached: !!parseResponse?.cached });
          updateStatus(statusDir, 'prd_parsed', {
            runId,
            message: `Parsed PRD: ${featureCount} feature(s), ${acCount} acceptance criteria`,
            featureCount,
            acCount,
            cached: !!parseResponse?.cached,
          }, telemetryReporter);
        }
      } catch (parseErr) {
        Logger.warn('PipelineWorker', 'PRD parse failed — falling back to raw PRD text', {
          reason: parseErr.message,
          code: parseErr.code,
        });
        updateStatus(statusDir, 'warning', {
          runId,
          message: `PRD parsing failed — continuing with raw PRD text. (${parseErr.message})`,
        }, telemetryReporter);
        // parsedPRD stays null; generator will fall back to raw prd.
      }
    }

    const projectInfo = {
      name: config.projectName,
      framework: codebaseContext?.projectStructure?.framework || 'Unknown',
      baseURL: config.baseURL,
      startCommand: config.startCommand,
      testCredentials: config.testCredentials,
      services: Array.isArray(config.services) ? config.services : undefined,
      apiOnly: !!config.apiOnly,
    };

    // -------------------------------------------------------
    // 3b-pre. Start primary app before exploration.
    // Browser-use and the Playwright heuristic explorer both need a live server
    // to navigate. If the user supplied a startCommand and the app is not yet
    // responding at baseURL, spawn it here and wait for HTTP readiness before
    // handing off to the exploration phase.  The same process will serve the
    // Playwright execution phase — PlaywrightIntegration.runTests() checks
    // config._primaryAppPreStarted and skips its own startServer() call so a
    // second instance is never spawned.
    // -------------------------------------------------------
    const explorationSkipped =
      config.skipExploration === true
      || process.env.HEALIX_SKIP_EXPLORATION === '1';

    const sequentialStrategy = String(config.testStrategy || process.env.HEALIX_TEST_STRATEGY || 'sequential').toLowerCase() === 'sequential';
    if ((sequentialStrategy || !explorationSkipped) && config.startCommand && config.baseURL) {
      const alreadyUp = await probeHttpReady(config.baseURL);
      if (alreadyUp) {
        Logger.info('PipelineWorker', 'Primary app already running — reusing for exploration', { url: config.baseURL });
        config = { ...config, _primaryAppPreStarted: true };
      } else {
        updateStatus(statusDir, 'starting_app', {
          runId,
          message: `Starting app before exploration: ${config.startCommand}`,
        }, telemetryReporter);
        try {
          const detached = process.platform !== 'win32';
          preStartedProc = spawn(config.startCommand, {
            cwd: config.projectPath,
            shell: true,
            detached,
            env: { ...process.env, PORT: String(config.port || '') },
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          if (preStartedProc.pid) {
            const ready = await waitForServiceReady({
              baseURL: config.baseURL,
              totalTimeoutMs: toFiniteNumber(config.serverStartTimeoutMs, 60_000),
              label: 'primary app',
              onReady: ({ elapsedMs, url }) => updateStatus(statusDir, 'dev_server_ready', {
                runId,
                message: `App ready at ${url} (${elapsedMs}ms)`,
                elapsedMs,
                url,
              }, telemetryReporter),
            });
            if (ready) {
              config = { ...config, _primaryAppPreStarted: true };
              Logger.info('PipelineWorker', 'Primary app pre-started for exploration', { url: config.baseURL, pid: preStartedProc.pid });
            } else {
              Logger.warn('PipelineWorker', 'Primary app did not become ready within timeout — exploration will attempt anyway', { url: config.baseURL });
            }
          }
        } catch (startErr) {
          Logger.warn('PipelineWorker', 'Failed to pre-start primary app for exploration', { reason: startErr.message });
          preStartedProc = null;
        }
      }
    }

    // -------------------------------------------------------
    // 3b. Browser-use exploration (Phase C). Opt-in via config.enableExploration
    // or HEALIX_ENABLE_EXPLORATION=1. Degrades gracefully: if browser-use isn't
    // installed, or exploration fails, we continue with an empty artifact and
    // the generator falls back to PRD + static context alone.
    // -------------------------------------------------------
    let explorationArtifact = { ...EMPTY_ARTIFACT };
    // Exploration is ON by default now that we have a Playwright heuristic
    // fallback — the user can still opt out via config.skipExploration or
    // HEALIX_SKIP_EXPLORATION=1 if, e.g., the dev server doesn't come up.
    if (!explorationSkipped) {
      updateStatus(statusDir, 'exploring', {
        runId,
        message: 'Exploring app with browser-use...',
      }, telemetryReporter);
      try {
        const result = await runExplorationPhase({
          statusDir,
          baseURL: config.baseURL,
          credentials: config.testCredentials,
          projectPath: config.projectPath,
          skipExploration: explorationSkipped,
          totalTimeoutMs: 120_000,
        });
        explorationArtifact = result.artifact;
        // preAuthRoles carries the storageState files written during the
        // exploration pre-auth pass — used in step 3c to skip redundant logins.
        if (Array.isArray(result.preAuthRoles)) {
          config = { ...config, _preAuthRoles: result.preAuthRoles };
        }
        updateStatus(statusDir, 'explored', {
          runId,
          message: `Exploration ${result.source}${result.reason ? ` (${result.reason})` : ''}`,
          source: result.source,
          reason: result.reason || null,
          routeCount: (result.artifact?.routes || []).length,
          keyFlowCount: (result.artifact?.keyFlows || []).length,
        }, telemetryReporter);
      } catch (explErr) {
        Logger.warn('PipelineWorker', 'Exploration phase failed (best-effort)', { reason: explErr.message });
      }
    }

    // -------------------------------------------------------
    // 3c. Credential injection (Phase D). For each testCredentials entry,
    // drive a headless login, persist storageState to .healix/auth-state-<role>.json,
    // and expose the role list to the generator so Tier B tests can run under
    // the right role. Graceful degradation: if login fails for a role, that
    // role is excluded from Tier B (but Tier A + Tier C continue).
    //
    // Optimisation: if exploration's pre-auth already verified all roles AND
    // exploration found no authFlow (nothing to improve on), we reuse the
    // pre-auth storageStates rather than running another headless login round-trip.
    // If a better authFlow was discovered, we re-inject so Playwright gets the
    // most accurate selectors / success indicator.
    // -------------------------------------------------------
    let roles = [];
    if (Array.isArray(config.testCredentials) && config.testCredentials.length > 0) {
      const preAuthRoles = Array.isArray(config._preAuthRoles) ? config._preAuthRoles : [];
      const allPreAuthVerified = preAuthRoles.length > 0
        && config.testCredentials.every((cred) => {
          const role = cred.role || 'user';
          return preAuthRoles.some((r) => r.role === role && r.loginVerified);
        });
      const hasAuthFlow = !!(explorationArtifact?.authFlow);

      if (allPreAuthVerified && !hasAuthFlow) {
        // Pre-auth storageStates are sufficient and there is no better authFlow
        // from exploration — skip the redundant login round-trip.
        roles = preAuthRoles;
        Logger.info('PipelineWorker', 'Reusing pre-auth storageStates — skipping duplicate credential injection', {
          roles: roles.map((r) => r.role),
        });
        updateStatus(statusDir, 'auth_injected', {
          runId,
          message: `${roles.filter((r) => r.loginVerified).length}/${roles.length} role login(s) verified (reused from pre-auth)`,
          roles: roles.map((r) => ({ role: r.role, loginVerified: !!r.loginVerified, reason: r.reason || null })),
        }, telemetryReporter);
      } else {
        // Either pre-auth failed for some roles OR exploration found a richer
        // authFlow — run a fresh injection so storageStates use the best available selectors.
        updateStatus(statusDir, 'auth_injecting', {
          runId,
          message: hasAuthFlow
            ? `Re-injecting credentials with discovered authFlow for ${config.testCredentials.length} role(s)...`
            : `Verifying credentials for ${config.testCredentials.length} role(s)...`,
        }, telemetryReporter);
        try {
          roles = await injectCredentials({
            projectPath: config.projectPath,
            baseURL: config.baseURL,
            credentials: config.testCredentials,
            authFlow: explorationArtifact?.authFlow || null,
          });
          const verifiedCount = roles.filter((r) => r.loginVerified).length;
          updateStatus(statusDir, 'auth_injected', {
            runId,
            message: `${verifiedCount}/${roles.length} role login(s) verified`,
            roles: roles.map((r) => ({ role: r.role, loginVerified: !!r.loginVerified, reason: r.reason || null })),
          }, telemetryReporter);
        } catch (credErr) {
          Logger.warn('PipelineWorker', 'Credential injection failed (best-effort)', { reason: credErr.message });
          // Fall back to whatever pre-auth gave us rather than leaving roles empty.
          roles = preAuthRoles.length > 0 ? preAuthRoles : [];
        }
      }
    }

    // -------------------------------------------------------
    // 4. Generate tests
    // -------------------------------------------------------
    if (config.generateTests) {
      updateStatus(statusDir, 'generating', {
        runId,
        message: sequentialStrategy
          ? 'Running sequential tester and synthesizing tests...'
          : 'Generating tests...',
        aiOnlyEnforced,
        testStrategy: sequentialStrategy ? 'sequential' : 'script',
      }, telemetryReporter);

      const generationResult = sequentialStrategy
        ? await withStageBudget(runBudget, 'generation', async () => {
            const testsDir = resetGeneratedTestsDir(config.projectPath);
            const client = process.env.HEALIX_API_KEY
              ? new WebappClient({ apiKey: process.env.HEALIX_API_KEY })
              : null;
            return runSequentialGeneration({
              config,
              context: codebaseContext,
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
            });
          })
        : await generateWithFallbackChain({
            config,
            context: codebaseContext,
            prdContent: combinedPrdContent,
            parsedPRD,
            explorationArtifact,
            roles,
            runBudget,
            projectInfo,
            statusDir,
            runId,
          });

      generationMeta = generationResult.generationMeta;
      fallbackUsed = !!generationMeta?.fallbackUsed;

      // Ensure playwright.config.ts exists after test generation
      const playwrightConfigResult = ensurePlaywrightConfig(config.projectPath, projectInfo, roles, {
        videoMode: config.videoMode,
      });
      if (generationMeta && playwrightConfigResult) {
        generationMeta.playwrightConfig = playwrightConfigResult;
      }

      const qualityScan = collectGenerationQuality(config.projectPath);
      // Build requirements coverage FIRST so the gate can feed the BRD-trace
      // signal into the quality score + suggestions block.
      requirementsCoverage = buildRequirementsCoverage({
        prdContent: combinedPrdContent,
        prdContents,
        projectPath: config.projectPath,
      });
      const qualityGateConfig = sequentialStrategy
        ? {
            ...config,
            minGeneratedTests: Math.max(1, Math.min(toFiniteNumber(config.minGeneratedTests, 50), generationResult.generated || 1)),
            coverageProfile: config.coverageProfile === 'exhaustive' ? 'qa-max' : (config.coverageProfile || 'balanced'),
          }
        : config;
      const qualityGate = evaluateGenerationQualityGates({
        config: qualityGateConfig,
        context: codebaseContext || {},
        quality: qualityScan,
        prdContent: combinedPrdContent,
        parsedPRD,
        requirementsCoverage,
      });
      if (!qualityGate.ok) {
        qualityGate.error.generationMeta = generationMeta;
        throw qualityGate.error;
      }
      generationQuality = qualityGate.result;

      // Plumb a non-fatal qualityWarning onto generationMeta so the dashboard
      // can render a yellow "quality = X%, add PRD/testids to improve by Y%"
      // banner instead of a red failure. Only attached when there's something
      // actionable to say — full-score suites stay quiet.
      if (
        generationMeta &&
        generationQuality &&
        Array.isArray(generationQuality.improvementSuggestions) &&
        generationQuality.improvementSuggestions.length > 0
      ) {
        generationMeta.qualityWarning = {
          qualityScore: generationQuality.qualityScore,
          potentialImprovement: generationQuality.potentialImprovement,
          suggestions: generationQuality.improvementSuggestions,
          totalTests: generationQuality.totalTests,
          selectorQuality: generationQuality.selectorQuality,
          coverageProfile: generationQuality.coverageProfile,
          missingCategories: generationQuality.missingCategories,
        };
      }

      if (aiOnlyEnforced && requirementsCoverage.totalRequirements > 0 && requirementsCoverage.mappedRequirements === 0) {
        // Warn-and-continue: the suite may still exercise real behavior even
        // without explicit [REQ-###] tags. Blocking execution here means the
        // user gets nothing; letting Playwright run gives them a real verdict.
        Logger.warn(
          'PipelineWorker',
          `BRD requirement trace coverage is zero (0/${requirementsCoverage.totalRequirements}) — continuing to execution anyway`
        );
      }

      Logger.info('PipelineWorker', 'Generated tests', {
        selectedGenerator: generationMeta?.selectedGenerator,
        generated: generationResult.generated || generationResult.files?.length || 0,
        fallbackUsed,
        totalTests: generationQuality.totalTests,
        categories: generationQuality.categories,
      });

      if (telemetryReporter && telemetryReporter.isEnabled()) {
        const generatedTestFiles = listGeneratedTestFiles(config.projectPath);

        for (const filePath of generatedTestFiles) {
          telemetryReporter.emitBackground({
            toolName: 'healix_test_my_app',
            eventType: 'test_file_generated',
            runId,
            phase: 'generating',
            status: 'info',
            success: true,
            message: path.basename(filePath),
            metadata: {
              project: config.projectName,
              file: path.basename(filePath),
              fileCount: generatedTestFiles.length,
            },
          });
        }

        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'tests_generated',
          runId,
          phase: 'generating',
          status: 'info',
          success: true,
          message: `Generated ${generationQuality.totalTests} tests across ${generatedTestFiles.length} file(s)`,
          metadata: {
            project: config.projectName,
            files: generatedTestFiles.map(f => path.basename(f)),
            fileCount: generatedTestFiles.length,
            totalTests: generationQuality.totalTests,
            categories: generationQuality.categories,
          },
        });
      }

      if (jiraStories?.length) {
        await withStageBudget(runBudget, 'generation', async () => {
          const playwright = new PlaywrightIntegration(config);
          await playwright.generateTests({
            prdFile: config.prdFile,
            jiraStories,
            testType: config.testType,
          });
        });
      }
    }

    // -------------------------------------------------------
    // 5. Run tests
    // -------------------------------------------------------
    updateStatus(statusDir, 'running', {
      runId,
      message: 'Running tests...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
    }, telemetryReporter);

    const executionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));

    // Throttled real-time test progress: buffer results and flush every 1.5s
    // so each completed test emits a telemetry event without flooding the API.
    const pendingProgress = [];
    let progressFlushTimer = null;
    const flushProgress = () => {
      progressFlushTimer = null;
      const batch = pendingProgress.splice(0);
      if (!batch.length || !telemetryReporter || !telemetryReporter.isEnabled()) return;
      for (const t of batch) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'test_result',
          runId,
          phase: 'running',
          status: t.status === 'failed' ? 'error' : 'info',
          success: t.status !== 'failed',
          message: t.name,
          metadata: { test: { n: t.name, su: '', f: '', s: t.status, d: t.durationMs } },
        });
      }
    };
    const onTestProgress = (t) => {
      pendingProgress.push(t);
      if (!progressFlushTimer) {
        progressFlushTimer = setTimeout(flushProgress, 1500);
      }
    };

    // Monorepo multi-service startup: if the detector found both a frontend and
    // a backend, start the backend here BEFORE Playwright launches the primary
    // (frontend) server. Secondary service PIDs are tracked in
    // healix-reports/.healix-services.pids and cleaned up on error or on the
    // next pipeline run's boot.
    if (Array.isArray(config.services) && config.services.length > 1) {
      try {
        const started = await startSecondaryServices({
          projectPath: config.projectPath,
          services: config.services,
          // 30 s cap matches the HTTP readiness-probe budget. Beyond that we
          // don't want to burn wall-clock on a dead service — emit a warning
          // and let Playwright probe routes directly.
          waitMs: toFiniteNumber(config.serverStartTimeoutMs, 30_000),
          // Telemetry: when a secondary becomes HTTP-ready, emit
          // `dev_server_ready` so the dashboard / MCP client can distinguish
          // cold-start latency from genuine Playwright flakes.
          onReady: ({ elapsedMs, url, service }) => {
            updateStatus(statusDir, 'dev_server_ready', {
              runId,
              message: `${service?.role || 'secondary'} service ready at ${url} (${elapsedMs}ms)`,
              elapsedMs,
              url,
              role: service?.role || null,
              port: service?.port || null,
            }, telemetryReporter);
          },
        });
        if (started.length > 0) {
          updateStatus(statusDir, 'secondary_services_started', {
            runId,
            message: `Started ${started.length} secondary service(s)`,
            services: started.map((s) => ({
              role: s.service.role,
              port: s.service.port,
              ready: s.ready,
            })),
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', 'Failed to start secondary services — continuing with primary only', { reason: err.message });
      }
    }

    // Guard: before we spin up the user's dev server + Playwright, verify
    // that there's actually something to run. Otherwise Playwright exits 1
    // and its stderr gets polluted by benign webServer warnings (e.g.
    // Next.js's `baseline-browser-mapping` line), which then surface as the
    // pipeline error and drown out the real cause (nothing to execute).
    try {
      const generatedSpecFiles = listGeneratedTestFiles(config.projectPath);
      if (!Array.isArray(generatedSpecFiles) || generatedSpecFiles.length === 0) {
        const err = new Error(
          `No Playwright spec files found in ${path.join(config.projectPath, 'tests', 'generated')}. ` +
          'Re-run with test generation enabled, or point Healix at a project that already has specs.'
        );
        err.code = 'NO_TESTS_TO_RUN';
        throw err;
      }

      // Guard: when the user ran with `generateTests: false` but the only
      // specs on disk are Healix fallback stubs from a previous generation
      // attempt (filenames start with `fallback-`), running is almost never
      // what the user wants — they get 8 generic smoke tests against an
      // arbitrary root route. Fail fast with an actionable message.
      if (config.generateTests === false) {
        const nonFallbackCount = generatedSpecFiles.filter((f) => !path.basename(f).startsWith('fallback-')).length;
        const fallbackCount = generatedSpecFiles.length - nonFallbackCount;
        if (nonFallbackCount === 0 && fallbackCount > 0) {
          const err = new Error(
            `Test generation was disabled for this run, but the only specs in ${path.join(config.projectPath, 'tests', 'generated')} are Healix fallback stubs ` +
            `(${fallbackCount} file${fallbackCount === 1 ? '' : 's'} matching fallback-*.spec.*) from a prior generation attempt. ` +
            'These are generic probes, not AC-traced tests. Re-run with "Generate tests" enabled in the config form to get real tests, ' +
            'or manually delete the fallback-*.spec.* files and point Healix at your own specs.'
          );
          err.code = 'ONLY_FALLBACK_SPECS_EXIST';
          throw err;
        }
      }
    } catch (preCheckErr) {
      if (preCheckErr && (preCheckErr.code === 'NO_TESTS_TO_RUN' || preCheckErr.code === 'ONLY_FALLBACK_SPECS_EXIST')) throw preCheckErr;
      // filesystem read errors are non-fatal here — fall through to Playwright
    }

    // Guard: Playwright's built-in `webServer` block races Healix's own dev
    // server manager. If the user has `webServer: { url, command, ... }` in
    // playwright.config and Healix is also starting a server (config.startCommand
    // is set), the two ports typically disagree — Playwright's webServer waits
    // 120s for its URL to respond, never does, and we get a cryptic
    // "Timed out waiting 120000ms from config.webServer". Detect the mismatch
    // upfront and throw an actionable error instead of burning 2 minutes.
    try {
      if (config.startCommand && config.baseURL && config.generateTests === false) {
        const conflict = detectPlaywrightWebServerConflict(config.projectPath, config.baseURL);
        if (conflict) {
          const err = new Error(
            `playwright.config.${conflict.ext} has a \`webServer\` block whose URL (${conflict.configuredUrl}) ` +
            `does not match the Healix-configured baseURL (${config.baseURL}). ` +
            `Playwright would try to start a second dev server and time out after 120s. ` +
            `Fix: either delete the \`webServer\` block from playwright.config.${conflict.ext} so Healix owns the dev server, ` +
            `or change its \`url\` to match ${config.baseURL} (and ensure \`reuseExistingServer: true\`).`
          );
          err.code = 'PLAYWRIGHT_WEBSERVER_TIMEOUT';
          throw err;
        }
      }
    } catch (preCheckErr) {
      if (preCheckErr && preCheckErr.code === 'PLAYWRIGHT_WEBSERVER_TIMEOUT') throw preCheckErr;
      // other errors here are diagnostic — don't block the run
    }

    playwright = new PlaywrightIntegration({
      ...config,
      timeout: executionTimeout,
      serverPidFile,
      useHealixPlaywrightConfig: config.generateTests !== false,
      onTestProgress: telemetryReporter && telemetryReporter.isEnabled() ? onTestProgress : undefined,
      // Emit a `dev_server_ready` telemetry event once the primary dev server
      // responds (HTTP 2xx/3xx/4xx or TCP fallback). Downstream consumers use
      // this to distinguish cold-start latency from genuine Playwright flakes.
      onServerReady: ({ elapsedMs, url }) => {
        updateStatus(statusDir, 'dev_server_ready', {
          runId,
          message: `Primary dev server ready at ${url} (${elapsedMs}ms)`,
          elapsedMs,
          url,
          role: 'primary',
        }, telemetryReporter);
      },
    });

    const mcpParallelEnabled =
      process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' ||
      process.env.PLAYWRIGHT_MCP_ENABLED === 'true';

    // Re-inject credentials just before execution so storageState tokens are
    // always fresh. Generation can take >13 min and Supabase access tokens
    // expire in 1h — stale tokens cause middleware to reject the session and
    // redirect tests to /login or /signup.
    if (Array.isArray(config.testCredentials) && config.testCredentials.length > 0) {
      try {
        updateStatus(statusDir, 'auth_refreshing', {
          runId,
          message: `Refreshing auth tokens before execution for ${config.testCredentials.length} role(s)...`,
        }, telemetryReporter);
        const freshRoles = await injectCredentials({
          projectPath: config.projectPath,
          baseURL: config.baseURL,
          credentials: config.testCredentials,
          authFlow: explorationArtifact?.authFlow || null,
        });
        const verifiedFresh = freshRoles.filter((r) => r.loginVerified);
        if (verifiedFresh.length > 0) {
          roles = freshRoles;
          // Rewrite the fixture file so it embeds the freshest storageState paths
          // (paths don't change but this ensures the file exists post-generation).
          ensureHealixFixtureImports({ projectPath: config.projectPath, roles: verifiedFresh });
        }
        Logger.info('PipelineWorker', 'Pre-execution auth refresh complete', {
          verified: verifiedFresh.length,
          total: freshRoles.length,
        });
      } catch (refreshErr) {
        Logger.warn('PipelineWorker', 'Pre-execution auth refresh failed — using existing storageState', {
          reason: refreshErr.message,
        });
      }
    }

    let testResults;

    testResults = await withStageBudget(runBudget, 'execution', async () => {
      if (!mcpParallelEnabled) {
        return playwright.runTests();
      }

      Logger.info('PipelineWorker', 'Parallel execution enabled: direct + Playwright MCP');
      const playwrightMCPIntegration = new PlaywrightMCPIntegration({
        projectPath: config.projectPath,
        baseURL: config.baseURL,
        mcpPackageName: config.playwrightMcp?.mcpPackageName,
        mcpVersion: config.playwrightMcp?.mcpVersion,
        noInstall: config.playwrightMcp?.noInstall,
      });

      const [directOutcome, mcpOutcome] = await Promise.allSettled([
        playwright.runTests(),
        playwrightMCPIntegration.runTests(),
      ]);

      if (directOutcome.status === 'rejected' && mcpOutcome.status === 'rejected') {
        throw new Error(`Both test runners failed: direct=${directOutcome.reason?.message} mcp=${mcpOutcome.reason?.message}`);
      }

      if (directOutcome.status === 'fulfilled' && mcpOutcome.status === 'fulfilled') {
        const merger = new ResultsMerger({
          projectPath: config.projectPath,
          dedupeStrategy: config.resultMerge?.dedupeStrategy,
        });
        return merger.mergeResults(directOutcome.value, mcpOutcome.value);
      }

      if (directOutcome.status === 'fulfilled') {
        Logger.warn('PipelineWorker', 'Playwright MCP execution failed; using direct results only', {
          reason: mcpOutcome.reason?.message,
        });
        return directOutcome.value;
      }

      Logger.warn('PipelineWorker', 'Direct execution failed; using Playwright MCP results only', {
        reason: directOutcome.reason?.message,
      });
      return mcpOutcome.value;
    });

    Logger.info('PipelineWorker', 'Tests completed', {
      total: testResults.total,
      passed: testResults.passed,
      failed: testResults.failed,
    });
    phaseResults = testResults.phaseResults || null;

    let tierResults = null;
    try {
      const tierMerger = new ResultsMerger({ projectPath: config.projectPath });
      tierResults = tierMerger.computeTierResults(testResults.tests || []);
      testResults.tierResults = tierResults;
    } catch (tierErr) {
      Logger.warn('PipelineWorker', 'Failed to compute tier results', { reason: tierErr.message });
    }

    const effectiveVideoMode = resolveVideoMode(config.videoMode);
    let videoValidation = null;
    try {
      const artifactValidator = new ArtifactUploader({
        projectPath: config.projectPath,
        artifactMode: config.artifactMode,
        videoMode: effectiveVideoMode,
      });
      videoValidation = artifactValidator.validateVideoArtifacts(testResults, {
        requireForAllExecuted: effectiveVideoMode === 'on',
      });
      testResults.videoValidation = videoValidation;
      if (generationMeta) {
        generationMeta.videoValidation = videoValidation;
        generationMeta.videoMode = effectiveVideoMode;
      }
      if (!videoValidation.ok) {
        Logger.warn('PipelineWorker', 'Playwright video artifact validation found issues', videoValidation);
      }
    } catch (videoErr) {
      videoValidation = {
        ok: false,
        requiredForAllExecuted: effectiveVideoMode === 'on',
        error: videoErr.message,
      };
      testResults.videoValidation = videoValidation;
      if (generationMeta) {
        generationMeta.videoValidation = videoValidation;
        generationMeta.videoMode = effectiveVideoMode;
      }
      Logger.warn('PipelineWorker', 'Failed to validate Playwright video artifacts', { reason: videoErr.message });
    }

    updateStatus(statusDir, 'tests_complete', {
      runId,
      message: `Tests completed: ${testResults.passed}/${testResults.total} passed`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: testResults.duration,
      },
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      videoValidation,
    }, telemetryReporter);

    if (telemetryReporter && telemetryReporter.isEnabled() && Array.isArray(testResults.tests) && testResults.tests.length > 0) {
      const simplifiedTests = testResults.tests.slice(0, 300).map(t => ({
        n: String(t.title || t.name || ''),
        su: String(t.suite || ''),
        f: String(t.file || ''),
        s: String(t.status || 'unknown'),
        d: Number(t.duration || 0),
      }));

      for (const t of simplifiedTests) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'test_result',
          runId,
          phase: 'tests_complete',
          status: t.s === 'failed' ? 'error' : 'info',
          success: t.s !== 'failed',
          message: t.n,
          metadata: {
            project: config.projectName,
            test: t,
            total: testResults.total,
            passed: testResults.passed,
            failed: testResults.failed,
            skipped: testResults.skipped,
          },
        });
      }

      telemetryReporter.emitBackground({
        toolName: 'healix_test_my_app',
        eventType: 'test_results',
        runId,
        phase: 'tests_complete',
        status: 'info',
        success: true,
        message: `Test results: ${testResults.passed}/${testResults.total} passed`,
        metadata: {
          project: config.projectName,
          tests: simplifiedTests,
          total: testResults.total,
          passed: testResults.passed,
          failed: testResults.failed,
          skipped: testResults.skipped,
          videoValidation,
        },
      });
    }

    // -------------------------------------------------------
    // 6. Optional AI failure triage
    // -------------------------------------------------------
    let aiAnalysis = null;
    let evidenceBundles = [];
    let classifierVerdicts = [];
    let failureClusters = [];
    try {
      const triage = await maybeRunFailureTriage({
        config,
        testResults,
        runBudget,
        runId,
      });
      aiAnalysis = triage?.analysis ?? null;
      evidenceBundles = triage?.evidenceBundles ?? [];
      classifierVerdicts = triage?.verdicts ?? [];
      failureClusters = triage?.clusters ?? [];
    } catch (triageError) {
      Logger.warn('PipelineWorker', 'AI failure triage failed', { reason: triageError.message });
      aiAnalysis = null;
      evidenceBundles = [];
      classifierVerdicts = [];
      failureClusters = [];
    }

    // -------------------------------------------------------
    // 7. Generate report
    // -------------------------------------------------------
    updateStatus(statusDir, 'reporting', {
      runId,
      message: 'Generating report...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      videoValidation,
    }, telemetryReporter);

    const report = await withStageBudget(runBudget, 'reporting', async () => {
      const reportGen = new ReportGenerator();
      const healixApiKey = process.env.HEALIX_API_KEY;
      const healixDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';

      return reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        runId,
        testResults,
        aiAnalysis,
        jiraData: jiraStories,
        generationMeta,
        generationQuality,
        requirementsCoverage,
        phaseResults,
        tierResults,
        fallbackUsed,
        failures: evidenceBundles,
        flakyCount: testResults.flaky || 0,
        classifierVerdicts,
        failureClusters,
        api_key: healixApiKey,
        dashboard_url: healixDashboardUrl,
      });
    });

    // Use the actual run ID returned from the server (if available)
    const actualRunId = report.actualRunId || runId;
    Logger.info('PipelineWorker', `Using run ID for artifact upload: ${actualRunId}`);

    // -------------------------------------------------------
    // 7. Upload artifacts to Supabase Storage
    // -------------------------------------------------------
    // NOTE: This runs AFTER report generation so artifacts are copied to healix-reports/artifacts
    let artifactUploadResult = null;
    const shouldUploadArtifacts = testResults.failed > 0 || effectiveVideoMode === 'on';
    if (shouldUploadArtifacts) {
      try {
        updateStatus(statusDir, 'uploading_artifacts', {
          runId,
          message: effectiveVideoMode === 'on'
            ? 'Uploading test video artifacts to storage...'
            : 'Uploading failure artifacts to storage...',
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
          videoValidation,
        }, telemetryReporter);

        updateStatus(statusDir, 'uploading_artifacts', {
          runId,
          message: 'Uploading test artifacts to storage...',
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
          videoValidation,
        }, telemetryReporter);

        const artifactUploader = new ArtifactUploader({
          projectPath: config.projectPath,
          dashboardUrl: process.env.HEALIX_DASHBOARD_URL,
          apiKey: process.env.HEALIX_API_KEY,
          artifactMode: config.artifactMode,
          videoMode: effectiveVideoMode,
        });

        artifactUploadResult = await artifactUploader.processAndUpload(actualRunId, testResults);
        
        if (artifactUploadResult.success) {
          const uploadMsg = artifactUploadResult.failed 
            ? `Uploaded ${artifactUploadResult.uploaded || 0} artifacts (${artifactUploadResult.failed} failed)`
            : `Uploaded ${artifactUploadResult.uploaded || 0} artifacts to storage`;
          
          Logger.info('PipelineWorker', uploadMsg);
          updateStatus(statusDir, 'artifacts_uploaded', {
            runId,
            message: uploadMsg,
            artifactsUploaded: artifactUploadResult.uploaded || 0,
            artifactsFailed: artifactUploadResult.failed || 0,
            generationMeta,
            fallbackUsed,
            aiOnlyEnforced,
            generationQuality,
            requirementsCoverage,
            phaseResults,
            videoValidation,
          }, telemetryReporter);
        } else {
          Logger.warn('PipelineWorker', 'Artifact upload failed', { reason: artifactUploadResult.reason });
          updateStatus(statusDir, 'artifacts_upload_failed', {
            runId,
            message: `Artifact upload failed: ${artifactUploadResult.reason || 'unknown'}`,
            reason: artifactUploadResult.reason,
            error: artifactUploadResult.error,
            generationMeta,
            fallbackUsed,
            aiOnlyEnforced,
            generationQuality,
            requirementsCoverage,
            phaseResults,
            videoValidation,
          }, telemetryReporter);
        }
      } catch (uploadError) {
        Logger.warn('PipelineWorker', 'Artifact upload error', { error: uploadError.message });
        updateStatus(statusDir, 'artifacts_upload_error', {
          runId,
          message: `Artifact upload error: ${uploadError.message}`,
          error: uploadError.message,
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
          videoValidation,
        }, telemetryReporter);
      }
    } else {
      Logger.info('PipelineWorker', 'No failed tests and videoMode is not on - skipping artifact upload');
    }

    // -------------------------------------------------------
    // 8. Open dashboard
    // -------------------------------------------------------
    let dashboardUrl = null;
    if (config.openDashboard) {
      try {
        dashboardUrl = await withStageBudget(runBudget, 'dashboard', async () => DashboardLauncher.open(report.path, {
          headless: config.headless,
          openBrowser: config.autoOpenBrowser,
        }));
      } catch (error) {
        Logger.warn('PipelineWorker', 'Dashboard open failed', { reason: error.message });
        dashboardUrl = report.url || `file://${report.path}`;
      }
    }

    // -------------------------------------------------------
    // 9. Final status
    // -------------------------------------------------------
    const passRate = testResults.total > 0
      ? `${Math.round((testResults.passed / testResults.total) * 100)}%`
      : '0%';

    updateStatus(statusDir, 'completed', {
      runId,
      message: `Pipeline complete — ${passRate} pass rate`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: `${testResults.duration}ms`,
        passRate,
      },
      reportPath: report.path,
      dashboardUrl: dashboardUrl || report.url,
      artifactUploadResult: artifactUploadResult ? {
        success: artifactUploadResult.success,
        uploaded: artifactUploadResult.uploaded || 0,
        reason: artifactUploadResult.reason,
      } : null,
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      videoValidation,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    }, telemetryReporter);

    Logger.info('PipelineWorker', 'Pipeline complete', {
      report: report.path,
      dashboard: dashboardUrl || report.url,
      runId,
    });

    // Stop any secondary (monorepo) services we started — primary server is
    // handled by playwright.runTests()'s own teardown (or by our pre-start
    // cleanup below when _primaryAppPreStarted is set).
    try { stopSecondaryServices(config.projectPath); } catch { /* ignore */ }
    killPreStartedProc(preStartedProc);

    // Give fire-and-forget reportPhase('completed') time to reach the webapp
    // before process.exit(0) kills in-flight HTTP requests. Without this the
    // SSE stream never receives the terminal event and the live page stays
    // stuck on the last non-terminal phase (e.g. stage:reporting) indefinitely.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch (error) {
    // Ensure the dev server is killed immediately even when the budget timeout
    // races ahead of playwright.runTests()'s own finally{stopServer()} block.
    if (playwright) {
      try { playwright.stopServer(); } catch { /* ignore */ }
    }
    try { stopSecondaryServices(config.projectPath); } catch { /* ignore */ }
    killPreStartedProc(preStartedProc);

    const errorCode = classifyErrorCode(error);
    const userFacingError = buildUserFacingPipelineError(errorCode, error);
    const technicalError = normalizeErrorText(error?.message);
    Logger.error('PipelineWorker', 'Pipeline error', error, { errorCode, runId });
    const errorGenerationMeta = error.generationMeta || generationMeta || {
      provider: null,
      selectedGenerator: null,
      fallbackUsed: false,
      aiOnlyEnforced,
      attempts: [],
      startedAt: null,
      finishedAt: new Date().toISOString(),
      reason: config.generateTests === false ? 'generation_skipped_use_existing_tests' : 'generation_not_started',
    };
    const errorGenerationQuality = error.generationQuality || generationQuality;

    updateStatus(statusDir, 'error', {
      runId,
      message: `Pipeline failed: ${userFacingError}`,
      error: userFacingError,
      errorDetail: technicalError,
      stack: error.stack,
      errorCode,
      generationMeta: errorGenerationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality: errorGenerationQuality,
      requirementsCoverage,
      phaseResults,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    }, telemetryReporter);

    try {
      const reportGen = new ReportGenerator();
      const syntheticFailure = {
        testName: `[HEALIX_ERROR:${errorCode}] Healix run failed before/while execution`,
        file: 'pipeline-worker.js',
        status: 'failed',
        duration: 0,
        error: {
          message: userFacingError,
          detail: technicalError,
        },
        artifacts: {
          screenshots: [],
          videos: [],
          traces: [],
          other: [],
        },
      };

      const syntheticTestResults = {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 0,
        tests: [
          {
            id: `pipeline-error-${runId}`,
            title: syntheticFailure.testName,
            suite: 'pipeline',
            file: syntheticFailure.file,
            status: 'failed',
            duration: 0,
            retries: 0,
            error: syntheticFailure.error,
            artifacts: syntheticFailure.artifacts,
          },
        ],
        failures: [syntheticFailure],
      };

      const healixApiKey = process.env.HEALIX_API_KEY;
      const healixDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';

      // Fall back to stderr-pattern classification when the upstream thrower
      // didn't attach diagnostics (e.g. PlaywrightIntegration.runTests throws
      // a plain Error on exit-code !=0 with no diagnostics). Without this the
      // banner used to render `stage: unknown / reason: unknown_reason` — see
      // pm-app regression 2026-04-18.
      const { classifyPipelineErrorFromStderr } = require('./failure-triage/pipeline-error-classifier');
      const stderrForClassifier = error.diagnostics?.stderr || error.message || '';
      const classification = classifyPipelineErrorFromStderr({
        stderr: stderrForClassifier,
        stdout: error.diagnostics?.stdout || '',
        hintedStage: error.diagnostics?.stage
          || (errorCode === 'GENERATION_VALIDATION_FAILED' ? 'validation' : null),
      });

      const pipelineError = {
        errorCode,
        stage: error.diagnostics?.stage && error.diagnostics.stage !== 'unknown'
          ? error.diagnostics.stage
          : classification.stage,
        reason: error.diagnostics?.reason || classification.reason,
        userFacingMessage: userFacingError || classification.userFacingMessage,
        technicalMessage: technicalError,
        stderr: error.diagnostics?.stderr || (typeof error.message === 'string' ? error.message.slice(0, 4000) : null),
        stdout: error.diagnostics?.stdout || null,
        firstSpecPreview: error.diagnostics?.firstSpecPreview || null,
        generatedSpecCount: error.diagnostics?.generatedSpecCount || 0,
        qualityAuditErrors: error.diagnostics?.qualityAuditErrors || null,
      };
      // Mark the synthetic row so the dashboard can hide it when the banner
      // carries full diagnostics — otherwise stats strip double-counts it as
      // a failed test (Total 1 / Failed 1 with zero real runs).
      syntheticFailure.isPipelineSynthetic = true;
      syntheticTestResults.tests[0].isPipelineSynthetic = true;

      const errorReport = await reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        runId,
        testResults: syntheticTestResults,
        aiAnalysis: null,
        jiraData: null,
        generationMeta: errorGenerationMeta,
        generationQuality: errorGenerationQuality,
        requirementsCoverage,
        phaseResults,
        fallbackUsed,
        pipelineError,
        api_key: healixApiKey,
        dashboard_url: healixDashboardUrl,
      });

      updateStatus(statusDir, 'error_reported', {
        runId,
        message: 'Pipeline failed and error report was generated.',
        errorCode,
        reportPath: errorReport.path,
        dashboardUrl: errorReport.url,
        generationMeta: errorGenerationMeta,
        generationQuality: errorGenerationQuality,
        requirementsCoverage,
        phaseResults,
      }, telemetryReporter);
      // Same flush grace as the success path — let fire-and-forget phase
      // report reach the webapp before process exit kills the socket.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (reportError) {
      Logger.warn('PipelineWorker', 'Failed to generate/sync error report', {
        runId,
        reason: reportError.message,
      });
    }
  }
}

// -------------------------------------------------------
// Entry point: receive config via IPC from parent
// -------------------------------------------------------
if (require.main === module) {
  process.on('message', (msg) => {
    // Disconnect IPC so parent is free
    try {
      process.disconnect();
    } catch (e) {
      // already disconnected
    }

    let config;
    let runId;

    // Config may be passed via a temp file (to avoid large IPC pipe-buffer deadlock on Windows)
    if (msg.configFile) {
      try {
        const raw = fs.readFileSync(msg.configFile, 'utf-8');
        const parsed = JSON.parse(raw);
        config = parsed.config;
        runId = parsed.runId || msg.runId;
      } catch (readErr) {
        Logger.error('PipelineWorker', 'Failed to read config temp file', readErr, { configFile: msg.configFile });
        process.exit(1);
        return;
      }
    } else {
      config = msg.config;
      runId = msg.runId;
    }

    // Run pipeline
    runPipeline(config, runId)
      .then(() => process.exit(0))
      .catch((err) => {
        Logger.error('PipelineWorker', 'Fatal error', err);
        process.exit(1);
      });
  });
}

module.exports = {
  runPipeline,
  generateWithFallbackChain,
  collectGenerationQuality,
  evaluateGenerationQualityGates,
  buildRequirementsCoverage,
  auditGeneratedTestQuality,
  strictAIEnabled,
  classifyErrorCode,
  buildUserFacingPipelineError,
  detectProjectModuleType,
  getCursorFixtureContent,
  ensureCursorFixtureFiles,
  ensureHealixFixtureImports,
  applyMouseCursorOverlayToGeneratedTests,
  ensurePlaywrightConfig,
  writeSupplementalAuthConfig,
  buildAgentHealth,
  createRunBudget,
  DEFAULT_STAGE_CAPS_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  maybeGenerateViaSaaS,
  pickAgentsForRun,
  rescuePartialGeneration,
};
