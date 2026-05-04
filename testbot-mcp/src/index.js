/**
 * Healix MCP Server
 * One-command testing with AI-powered analysis for any project
 *
 * Usage: User says "test my app using healix mcp" in Cursor/Windsurf
 */

// Load environment variables - try multiple paths since CWD varies when launched from IDE
const path = require('path');
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
  path.join(process.cwd(), '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) { break; } // stop at first working .env
}

const { fork } = require('child_process');
const fs = require('fs');
const { URL } = require('url');
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require('zod');

const fetch = global.fetch || require('node-fetch');
const Logger = require('./logger');
const AutoDetector = require('./auto-detector');
const PlaywrightIntegration = require('./playwright-integration');
const AIAnalyzer = require('./ai-providers/index');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');
const ConfigUILauncher = require('./config-ui-launcher');
const MCPTelemetryReporter = require('./mcp-telemetry');

const CREDENTIAL_SCHEMA = z.object({
  role: z.string().max(100).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
});

const TEST_STRATEGY_SCHEMA = z.enum(['sequential', 'script']);
const VIDEO_MODE_SCHEMA = z.enum(['on', 'retain-on-failure']);

const PRD_FILE_SCHEMA = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128).optional(),
  textContent: z.string().min(1).max(500000),
});

const UI_SUBMISSION_SCHEMA = z.object({
  testType: z.enum(['frontend', 'backend', 'both']),
  scope: z.enum(['codebase', 'diff']).optional(),
  baseURL: z.string().url(),
  startCommand: z.string().min(1).max(500),
  generateTests: z.boolean(),
  openDashboard: z.boolean(),
  videoMode: VIDEO_MODE_SCHEMA.optional(),
  credentials: z.union([
    CREDENTIAL_SCHEMA,
    z.array(CREDENTIAL_SCHEMA).max(10),
  ]).optional(),
  prd: PRD_FILE_SCHEMA.optional().nullable(),
  prdFiles: z.array(PRD_FILE_SCHEMA).max(5).optional().nullable(),
});

const WORKFLOW_OBJECT_SCHEMA = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  steps: z.array(z.string().min(1).max(500)).max(100).optional(),
  criticalAssertions: z.array(z.string().min(1).max(500)).max(100).optional(),
}).passthrough();

const CODEBASE_CONTEXT_SCHEMA = z.object({
  pages: z.array(z.any()).optional(),
  apiEndpoints: z.array(z.any()).optional(),
  workflows: z.array(z.union([z.string().min(1).max(500), WORKFLOW_OBJECT_SCHEMA])).optional(),
}).passthrough();

const PLAYWRIGHT_MCP_OPTIONS_SCHEMA = z.object({
  enabled: z.boolean().optional(),
  mcpPackageName: z.literal('@playwright/mcp').optional(),
  mcpVersion: z.string().regex(/^(?!latest$)[0-9A-Za-z._-]+$/).optional(),
  noInstall: z.boolean().optional(),
}).optional();

const RESULT_MERGE_OPTIONS_SCHEMA = z.object({
  dedupeStrategy: z.enum(['legacy', 'strict']).optional(),
}).optional();

const LOG_REDACTION_OPTIONS_SCHEMA = z.object({
  enabled: z.boolean().optional(),
  level: z.enum(['balanced', 'strict']).optional(),
}).optional();

function resolveBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

class HealixMCPServer {
  constructor() {
    Logger.initialize();
    console.error('[DEBUG] Healix MCP Server starting - VERSION WITH ZOD SCHEMAS');
    this.server = new McpServer({
      name: "healix-mcp",
      version: "1.1.0"
    });
    this.telemetryReporter = this.createTelemetryReporter();

    this.registerTools();
    this.setupErrorHandling();
  }

  createAutoDetector() {
    return new AutoDetector();
  }

  createConfigUILauncher(config = {}) {
    // Cancel any previously active launcher so its server frees the port before the new one starts
    if (this._activeConfigUILauncher) {
      try { this._activeConfigUILauncher.cancel(); } catch (_) {}
      this._activeConfigUILauncher = null;
    }
    const launcher = new ConfigUILauncher(config);
    this._activeConfigUILauncher = launcher;
    return launcher;
  }

  createTelemetryReporter(config = {}) {
    return new MCPTelemetryReporter(config);
  }

  emitTelemetry(event) {
    if (!this.telemetryReporter || !this.telemetryReporter.isEnabled()) {
      return;
    }
    this.telemetryReporter.emitBackground(event);
  }

  trackToolInvocation(toolName, args) {
    const startedAt = Date.now();
    this.emitTelemetry({
      toolName,
      eventType: 'tool_invocation',
      status: 'info',
      success: true,
      metadata: {
        hasArgs: !!args && typeof args === 'object' && Object.keys(args).length > 0,
      },
    });
    return startedAt;
  }

  trackToolResult(toolName, startedAt, error = null) {
    this.emitTelemetry({
      toolName,
      eventType: 'tool_result',
      status: error ? 'error' : 'success',
      success: !error,
      durationMs: Date.now() - startedAt,
      errorCode: error?.code || undefined,
      reason: error?.message || undefined,
      message: error ? `Tool ${toolName} failed` : `Tool ${toolName} completed`,
    });
  }

  // Return the most-recently-updated run for this project (or null). Used by
  // handleTestMyApp to short-circuit agent retry loops on transient pipeline
  // failure — so the user isn't forced to re-enter the same config each time.
  findRecentRunForProject(projectPath) {
    try {
      const runsDir = path.join(projectPath, 'healix-reports', '.runs');
      if (!fs.existsSync(runsDir)) return null;
      const entries = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
          const statusFile = path.join(runsDir, e.name, 'status.json');
          try {
            const stat = fs.statSync(statusFile);
            const data = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
            return { runId: e.name, mtimeMs: stat.mtimeMs, data };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return entries[0] || null;
    } catch (err) {
      Logger.warn('Index', 'findRecentRunForProject failed', { reason: err.message });
      return null;
    }
  }

  emitRunStatusTelemetry(statusPayload) {
    const runId = statusPayload?.runId;
    if (!runId) {
      return;
    }

    const phase = String(statusPayload?.phase || '').toLowerCase();
    const status = phase === 'completed'
      ? 'success'
      : (phase === 'error' || phase === 'error_reported' ? 'error' : 'info');

    this.emitTelemetry({
      toolName: 'healix_test_my_app',
      eventType: 'run_status',
      runId,
      phase: statusPayload.phase,
      status,
      success: status === 'success',
      errorCode: statusPayload.errorCode,
      reason: statusPayload.error || null,
      message: statusPayload.message,
      durationMs: Number(statusPayload?.results?.duration || 0) || undefined,
      metadata: {
        project: statusPayload.project,
        aiOnlyEnforced: statusPayload.aiOnlyEnforced,
        fallbackUsed: statusPayload.fallbackUsed,
        dashboardUrl: statusPayload.dashboardUrl,
        reportPath: statusPayload.reportPath,
        generationProvider: statusPayload.generationMeta?.selectedGenerator || statusPayload.generationMeta?.provider || null,
      },
    });
  }

  writeRunStatus(statusFile, data) {
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        ...data,
      };
      fs.writeFileSync(
        statusFile,
        JSON.stringify(payload, null, 2)
      );
      this.emitRunStatusTelemetry(payload);
    } catch (error) {
      Logger.error('Index', 'Failed to write run status', error, { statusFile });
    }
  }

  extractPortFromBaseURL(baseURL, fallbackPort) {
    try {
      const parsed = new URL(baseURL);
      return parsed.port ? parseInt(parsed.port, 10) : fallbackPort;
    } catch {
      return fallbackPort;
    }
  }

  /**
   * Read the project's package.json to classify its web framework. Used by the
   * port-autocorrection pass so we can inject the right port flag (`--port` vs
   * `-p` vs `PORT=`) into the user's startCommand. Returns null when unknown.
   */
  detectProjectFramework(projectPath) {
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (!fs.existsSync(pkgPath)) return null;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.expo || deps['expo-router']) return { kind: 'expo', defaultPort: 8081 };
      if (deps.next) return { kind: 'next', defaultPort: 3000 };
      if (deps.vite) return { kind: 'vite', defaultPort: 5173 };
      if (deps['react-scripts']) return { kind: 'cra', defaultPort: 3000 };
      if (deps['@remix-run/dev']) return { kind: 'remix', defaultPort: 3000 };
      if (deps.nuxt || deps.nuxt3) return { kind: 'nuxt', defaultPort: 3000 };
      if (deps['@sveltejs/kit']) return { kind: 'sveltekit', defaultPort: 5173 };
      return { kind: 'unknown', defaultPort: null };
    } catch {
      return null;
    }
  }

  /**
   * Align the user's startCommand + port + baseURL before the pipeline runs.
   *
   * The form lets users override the auto-detected values, which is great in
   * theory but leads to preventable failures in practice: a Vite project with
   * port field = 8000 and startCommand = "npm run dev" will have the dev
   * server bind to 5173 (Vite's default, since `npm run dev` has no `--port`
   * flag), leaving Playwright testing nothing on 8000.
   *
   * This method rewrites startCommand so whatever port the user ended up with
   * is the port the dev server actually binds to. Framework-aware: Vite uses
   * `--port N`, Next uses `-p N`, CRA uses `PORT=N`, Expo delegates to the
   * existing normalizer. Returns `{ startCommand, port, baseURL, appliedFixes }`.
   */
  autoCorrectPortConfig({ projectPath, startCommand, port, baseURL }) {
    const appliedFixes = [];
    let cmd = String(startCommand || '').trim();
    let finalPort = Number(port) || 0;
    let finalBaseURL = String(baseURL || '').trim();

    if (!cmd || !finalPort) return { startCommand: cmd, port: finalPort, baseURL: finalBaseURL, appliedFixes };

    const framework = this.detectProjectFramework(projectPath);

    // Step 1: if baseURL port differs from port field, align them (port field wins —
    // it's the explicit form input).
    try {
      const parsed = new URL(finalBaseURL);
      if (parsed.port && parseInt(parsed.port, 10) !== finalPort) {
        parsed.port = String(finalPort);
        const aligned = parsed.toString();
        appliedFixes.push({
          kind: 'baseURL_port_aligned',
          detail: `baseURL port realigned to match the Port field: ${finalBaseURL} → ${aligned}`,
        });
        finalBaseURL = aligned;
      }
    } catch { /* malformed baseURL — leave it */ }

    // Step 2: inject the port flag into startCommand so the dev server binds
    // where Playwright expects. Only act when the command has no explicit
    // port override already.
    const hasExplicitPort = /--port[=\s]\d+/i.test(cmd)
      || /\s-p\s+\d+/i.test(cmd)
      || /\bPORT\s*=\s*\d+/i.test(cmd);

    if (!hasExplicitPort && framework && framework.kind !== 'unknown') {
      const usesNpmScript = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+\S+/i.test(cmd);
      const scriptArgSep = usesNpmScript ? ' -- ' : ' ';
      const alreadyHasSeparator = usesNpmScript && / -- /.test(cmd);

      let inject = null;
      switch (framework.kind) {
        case 'vite':
        case 'expo':
        case 'sveltekit':
        case 'nuxt':
          inject = `--port ${finalPort}`;
          break;
        case 'next':
        case 'remix':
          inject = `-p ${finalPort}`;
          break;
        case 'cra':
          cmd = `PORT=${finalPort} ${cmd}`;
          appliedFixes.push({
            kind: 'startCommand_port_injected',
            detail: `Prefixed startCommand with PORT=${finalPort} (CRA reads PORT env var): ${startCommand} → ${cmd}`,
          });
          inject = null; // already handled
          break;
      }

      if (inject) {
        const original = cmd;
        if (alreadyHasSeparator) {
          cmd += ` ${inject}`;
        } else if (usesNpmScript) {
          cmd += `${scriptArgSep}${inject}`;
        } else {
          cmd += ` ${inject}`;
        }
        appliedFixes.push({
          kind: 'startCommand_port_injected',
          detail: `Injected port flag into startCommand so the dev server binds to ${finalPort}: "${original}" → "${cmd}"`,
        });
      }
    }

    // Step 3: if port is the framework's default and the user didn't explicitly
    // pick something else in the form, log a confirmation (no change). Helps
    // debug when autodetection was correct all along.
    if (framework && framework.defaultPort && finalPort === framework.defaultPort && appliedFixes.length === 0) {
      appliedFixes.push({
        kind: 'port_matches_framework_default',
        detail: `Port ${finalPort} matches the ${framework.kind} default — no changes needed.`,
      });
    }

    return { startCommand: cmd, port: finalPort, baseURL: finalBaseURL, appliedFixes };
  }

  persistUploadedPrd(statusDir, prdPayload) {
    if (!prdPayload?.textContent) {
      return undefined;
    }

    const allowedExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
    const originalName = path.basename(prdPayload.name || 'uploaded-prd.md');
    const ext = path.extname(originalName).toLowerCase();
    const safeExt = allowedExtensions.has(ext) ? ext : '.md';
    const fileName = `uploaded-prd${safeExt}`;
    const filePath = path.join(statusDir, fileName);

    fs.writeFileSync(filePath, prdPayload.textContent, 'utf-8');
    return filePath;
  }

  persistUploadedPrdFiles(statusDir, prdFiles) {
    if (!Array.isArray(prdFiles) || prdFiles.length === 0) {
      return [];
    }

    const allowedExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
    const savedPaths = [];

    prdFiles.forEach((prdPayload, index) => {
      if (!prdPayload?.textContent) return;

      const originalName = path.basename(prdPayload.name || `uploaded-prd-${index}.md`);
      const ext = path.extname(originalName).toLowerCase();
      const safeExt = allowedExtensions.has(ext) ? ext : '.md';
      const baseName = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `uploaded-prd-${index}-${baseName}${safeExt}`;
      const filePath = path.join(statusDir, fileName);

      fs.writeFileSync(filePath, prdPayload.textContent, 'utf-8');
      savedPaths.push(filePath);
    });

    return savedPaths;
  }

  normalizeCredentials(credentials) {
    if (!credentials) return undefined;
    
    if (Array.isArray(credentials)) {
      const validCreds = credentials.filter(c => c.username || c.password);
      return validCreds.length > 0 ? validCreds : undefined;
    }
    
    if (credentials.username || credentials.password) {
      return [credentials];
    }
    
    return undefined;
  }

  validateUISubmission(rawConfig) {
    const parsed = UI_SUBMISSION_SCHEMA.safeParse(rawConfig);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const error = new Error(`Invalid configuration payload: ${firstIssue?.message || 'unknown error'}`);
      error.code = 'CONFIG_INVALID';
      throw error;
    }
    return parsed.data;
  }

  normalizeCodebaseContext(input) {
    if (!input) {
      return null;
    }

    const normalized = { ...input };
    if (Array.isArray(input.workflows)) {
      normalized.workflows = input.workflows
        .map((workflow) => {
          if (typeof workflow === 'string') {
            const name = workflow.trim();
            if (!name) return null;
            return {
              name,
              description: name,
              steps: [],
            };
          }

          if (!workflow || typeof workflow !== 'object') {
            return null;
          }

          const name = String(workflow.name || workflow.description || '').trim();
          if (!name) {
            return null;
          }

          return {
            ...workflow,
            name,
            steps: Array.isArray(workflow.steps)
              ? workflow.steps.map((step) => String(step))
              : [],
            criticalAssertions: Array.isArray(workflow.criticalAssertions)
              ? workflow.criticalAssertions.map((item) => String(item))
              : [],
          };
        })
        .filter(Boolean);
    }

    return normalized;
  }

  looksLikeLocalProjectPath(projectPath) {
    if (!projectPath || typeof projectPath !== 'string') return false;
    const trimmed = projectPath.trim();
    if (!trimmed) return false;
    if (/^https?:\/\//i.test(trimmed)) return false;
    // POSIX absolute path or Windows drive-letter path. Relative paths are not
    // considered "local project" here because they're too ambiguous to trust
    // for auto-upgrading the generation profile.
    return /^\//.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed);
  }

  resolveHeadlessPreference(params = {}) {
    const envHeadless = resolveBoolean(process.env.HEALIX_HEADLESS, true);
    return resolveBoolean(params.headless, envHeadless);
  }

  resolveAutoOpenBrowserPreference(params = {}, headless = this.resolveHeadlessPreference(params)) {
    if (headless) {
      return false;
    }
    const envAutoOpen = resolveBoolean(process.env.HEALIX_AUTO_OPEN_BROWSER, false);
    return resolveBoolean(params.autoOpenBrowser, envAutoOpen);
  }

  resolveTestStrategy(value) {
    const raw = String(value || process.env.HEALIX_TEST_STRATEGY || 'sequential').trim().toLowerCase();
    return raw === 'script' ? 'script' : 'sequential';
  }

  resolveVideoMode(value) {
    const raw = String(value || process.env.HEALIX_VIDEO_MODE || 'on').trim().toLowerCase();
    return raw === 'retain-on-failure' ? 'retain-on-failure' : 'on';
  }

  hasDirectRunConfig(params = {}) {
    return Boolean(
      params &&
      typeof params.baseURL === 'string' &&
      params.baseURL.trim() &&
      typeof params.startCommand === 'string' &&
      params.startCommand.trim()
    );
  }

  buildDirectUISubmission(baseConfig, params = {}) {
    return {
      testType: params.testType || baseConfig.testType || 'both',
      scope: params.scope,
      baseURL: params.baseURL || baseConfig.baseURL,
      startCommand: params.startCommand || baseConfig.startCommand,
      generateTests: params.generateTests !== false,
      openDashboard: params.openDashboard !== false,
      videoMode: this.resolveVideoMode(params.videoMode || baseConfig.videoMode),
      credentials: params.credentials,
      prd: null,
      prdFiles: null,
    };
  }

  createBasePipelineConfig(context, params) {
    const normalizedCodebase = this.normalizeCodebaseContext(params.codebaseContext);
    const hasLocalProject = this.looksLikeLocalProjectPath(context.projectPath);
    const pageCount = Array.isArray(normalizedCodebase?.pages) ? normalizedCodebase.pages.length : 0;
    const workflowCount = Array.isArray(normalizedCodebase?.workflows) ? normalizedCodebase.workflows.length : 0;
    const shouldAutoUpgrade = hasLocalProject && (pageCount > 0 || workflowCount > 0);

    // configAutoUpgrades tracks every upgrade we apply here so the user can see
    // why we overrode their weak profile. Downstream merges these into
    // finalConfig.configAutoFixes alongside the port/startCommand corrections.
    const configAutoUpgrades = [];

    // strictAIGeneration normalization. The canonical default is TRUE. If we're
    // auto-upgrading (local project with pages), we also force this true even
    // if the caller passed false, because template-only generation on local
    // codebases reliably produces low-quality suites (the l9ptet incident).
    let strictAIGeneration = params.strictAIGeneration !== false;
    if (shouldAutoUpgrade && params.strictAIGeneration === false) {
      strictAIGeneration = true;
      configAutoUpgrades.push({
        kind: 'config_auto_upgraded',
        detail: 'Promoted strictAIGeneration=false → true for local project with detected pages/workflows',
        field: 'strictAIGeneration',
        from: false,
        to: true,
      });
    }

    // Initial generationMode resolution (before auto-upgrade).
    let resolvedGenerationMode = strictAIGeneration
      ? 'openai-only'
      : (params.generationMode || 'openai-first');
    if (shouldAutoUpgrade && (params.generationMode === 'template-only' || params.generationMode === 'saas-only')) {
      const previous = params.generationMode;
      resolvedGenerationMode = 'openai-only';
      configAutoUpgrades.push({
        kind: 'config_auto_upgraded',
        detail: `Promoted generationMode=${previous} → openai-only for local project with detected pages/workflows`,
        field: 'generationMode',
        from: previous,
        to: 'openai-only',
      });
    }

    const parsedMinGeneratedTests = Number(params.minGeneratedTests);
    let minGeneratedTests = Number.isFinite(parsedMinGeneratedTests) && parsedMinGeneratedTests > 0
      ? Math.floor(parsedMinGeneratedTests)
      : 50;
    if (shouldAutoUpgrade && minGeneratedTests < 50) {
      const previous = minGeneratedTests;
      minGeneratedTests = 50;
      configAutoUpgrades.push({
        kind: 'config_auto_upgraded',
        detail: `Promoted minGeneratedTests=${previous} → 50 for local project with detected pages/workflows`,
        field: 'minGeneratedTests',
        from: previous,
        to: 50,
      });
    }

    // coverageProfile upgrade — 'balanced' on a local project with pages
    // produced the zapminds l9ptet 42% pass rate; 'qa-max' is the new floor.
    let coverageProfile = params.coverageProfile || 'qa-max';
    if (shouldAutoUpgrade && params.coverageProfile === 'balanced') {
      coverageProfile = 'qa-max';
      configAutoUpgrades.push({
        kind: 'config_auto_upgraded',
        detail: 'Promoted coverageProfile=balanced → qa-max for local project with detected pages/workflows',
        field: 'coverageProfile',
        from: 'balanced',
        to: 'qa-max',
      });
    }

    if (configAutoUpgrades.length > 0) {
      Logger.info('Index', `Auto-upgraded ${configAutoUpgrades.length} generation config field(s) for local project`, {
        projectPath: context.projectPath,
        pageCount,
        workflowCount,
        upgrades: configAutoUpgrades.map((u) => `${u.field}:${u.from}→${u.to}`),
      });
    }

    // P0-3c: Even after auto-upgrade, reject template-only at normalization so
    // the caller gets a fast, clear error rather than waiting for the worker
    // to spin up and throw INCOMPATIBLE_GENERATION_MODE. The worker keeps its
    // own guard as defense-in-depth.
    if (resolvedGenerationMode === 'template-only') {
      const err = new Error(
        'generationMode=template-only is no longer supported — the worker only runs AI-backed per-agent parallel generation. ' +
        'Use strictAIGeneration=true (the default) or explicitly set generationMode=openai-only.'
      );
      err.code = 'INCOMPATIBLE_GENERATION_MODE';
      throw err;
    }

    const headless = this.resolveHeadlessPreference(params);
    const autoOpenBrowser = this.resolveAutoOpenBrowserPreference(params, headless);

    // Prefer explicit user override; otherwise fall back to detection. Monorepo repos
    // that split frontend + backend surface `context.services` with two entries, and
    // api-only repos flag `context.apiOnly`. These propagate to the pipeline worker so
    // server startup can launch both services and the generator can branch into
    // multi-step API flow mode when only a backend is present.
    const detectedApiOnly = !!context.apiOnly;
    const defaultTestType = detectedApiOnly ? 'backend' : 'both';

    return {
      projectPath: context.projectPath,
      projectName: context.projectName,
      language: context.language,
      ecosystem: context.ecosystem,
      testType: params.testType || defaultTestType,
      generateTests: params.generateTests !== false,
      prdFile: params.prdFile,
      codebaseContext: normalizedCodebase,
      baseURL: params.baseURL || context.baseURL,
      port: params.port || context.port,
      startCommand: params.startCommand || context.startCommand,
      services: Array.isArray(params.services) && params.services.length > 0
        ? params.services
        : (Array.isArray(context.services) ? context.services : undefined),
      apiOnly: typeof params.apiOnly === 'boolean' ? params.apiOnly : detectedApiOnly,
      jira: params.jira,
      openDashboard: params.openDashboard !== false,
      testStrategy: this.resolveTestStrategy(params.testStrategy),
      generationMode: resolvedGenerationMode,
      artifactMode: params.artifactMode || 'hybrid',
      videoMode: this.resolveVideoMode(params.videoMode),
      browserMode: params.browserMode || 'chromium',
      validateGeneratedTests: params.validateGeneratedTests !== false,
      aiFailureAnalysis: params.aiFailureAnalysis !== false,
      showMouseCursorInVideo: params.showMouseCursorInVideo !== false,
      strictAIGeneration,
      aiOnlyEnforced: strictAIGeneration,
      minGeneratedTests,
      coverageProfile,
      configAutoFixes: configAutoUpgrades,
      phaseMode: params.phaseMode || 'two-phase',
      serverStartTimeoutMs: params.serverStartTimeoutMs,
      serverHealthCheckIntervalMs: params.serverHealthCheckIntervalMs,
      playwrightMcp: params.playwrightMcp || {},
      resultMerge: params.resultMerge || {},
      logRedaction: params.logRedaction || {},
      headless,
      autoOpenBrowser,
    };
  }

  async continuePipelineAfterConfig({
    waitForConfig,
    runId,
    statusFile,
    statusDir,
    baseConfig,
  }) {
    try {
      const uiSubmission = await waitForConfig;
      const validatedConfig = this.validateUISubmission(uiSubmission);

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'config_received',
        message: 'Configuration received from UI.',
        project: baseConfig.projectName,
        aiOnlyEnforced: baseConfig.strictAIGeneration !== false,
      });
      this.emitTelemetry({
        toolName: 'healix_test_my_app',
        eventType: 'config_ui',
        runId,
        phase: 'config_received',
        status: 'success',
        success: true,
        message: 'Configuration submitted via UI',
      });

      const prdFile = this.persistUploadedPrd(statusDir, validatedConfig.prd);
      const prdFiles = this.persistUploadedPrdFiles(statusDir, validatedConfig.prdFiles);
      const normalizedCredentials = this.normalizeCredentials(validatedConfig.credentials);

      // Auto-correct port/startCommand alignment BEFORE the pipeline starts.
      // Without this, a Vite project with submitted port 8000 + startCommand
      // "npm run dev" runs the dev server on Vite's default 5173, leaves 8000
      // empty, and every Playwright test fails with ECONNREFUSED or invalid
      // URL. See autoCorrectPortConfig for the framework-aware logic.
      const corrected = this.autoCorrectPortConfig({
        projectPath: baseConfig.projectPath,
        startCommand: validatedConfig.startCommand,
        port: this.extractPortFromBaseURL(validatedConfig.baseURL, baseConfig.port),
        baseURL: validatedConfig.baseURL,
      });
      if (corrected.appliedFixes && corrected.appliedFixes.length > 0) {
        for (const fix of corrected.appliedFixes) {
          Logger.info('Index', `Config auto-correction [${fix.kind}]: ${fix.detail}`);
        }
      }

      // Merge the generation-profile auto-upgrades (set in createBasePipelineConfig)
      // with the port/startCommand auto-corrections from autoCorrectPortConfig so
      // every applied fix is visible in status + telemetry together.
      const allAutoFixes = [
        ...(Array.isArray(baseConfig.configAutoFixes) ? baseConfig.configAutoFixes : []),
        ...(corrected.appliedFixes || []),
      ];

      const finalConfig = {
        ...baseConfig,
        testType: validatedConfig.testType,
        generateTests: validatedConfig.generateTests,
        openDashboard: validatedConfig.openDashboard,
        videoMode: this.resolveVideoMode(validatedConfig.videoMode || baseConfig.videoMode),
        startCommand: corrected.startCommand,
        baseURL: corrected.baseURL,
        port: corrected.port,
        configAutoFixes: allAutoFixes,
        prdFile: prdFile || (prdFiles.length > 0 ? prdFiles[0] : undefined),
        prdFiles: prdFiles.length > 0 ? prdFiles : (prdFile ? [prdFile] : []),
      };

      if (normalizedCredentials && normalizedCredentials.length > 0) {
        finalConfig.testCredentials = normalizedCredentials;
      }

      const appliedFixSummaries = allAutoFixes
        .filter((fix) => fix.kind !== 'port_matches_framework_default')
        .map((fix) => fix.detail);

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'starting_pipeline',
        message: appliedFixSummaries.length > 0
          ? `Validated configuration (auto-corrected ${appliedFixSummaries.length} item${appliedFixSummaries.length === 1 ? '' : 's'}). Starting Healix worker...`
          : 'Validated configuration. Starting Healix worker...',
        project: baseConfig.projectName,
        aiOnlyEnforced: finalConfig.strictAIGeneration !== false,
        configAutoFixes: allAutoFixes,
      });

      if (appliedFixSummaries.length > 0) {
        this.emitTelemetry({
          toolName: 'healix_test_my_app',
          eventType: 'config_auto_fixed',
          runId,
          phase: 'starting_pipeline',
          status: 'info',
          success: true,
          message: `Auto-corrected ${appliedFixSummaries.length} config item${appliedFixSummaries.length === 1 ? '' : 's'}`,
          metadata: { fixes: allAutoFixes },
        });
      }

      // Write 'started' BEFORE forking so the status is never permanently stuck at
      // 'starting_pipeline' even if the fork takes a moment on Windows.
      this.writeRunStatus(statusFile, {
        runId,
        phase: 'started',
        message: 'Healix starting...',
        project: baseConfig.projectName,
        aiOnlyEnforced: finalConfig.strictAIGeneration !== false,
      });

      this.runPipelineInBackground(finalConfig, runId, statusDir);
    } catch (error) {
      const errorCode = error.code === 'CONFIG_INVALID'
        ? 'CONFIG_INVALID'
        : (String(error.message).toLowerCase().includes('timeout') ? 'CONFIG_TIMEOUT' : 'CONFIG_ERROR');

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'error',
        message: `Configuration failed: ${error.message}`,
        error: error.message,
        errorCode,
        project: baseConfig.projectName,
        aiOnlyEnforced: baseConfig.strictAIGeneration !== false,
      });
      this.emitTelemetry({
        toolName: 'healix_test_my_app',
        eventType: 'config_ui',
        runId,
        phase: 'error',
        status: 'error',
        success: false,
        errorCode,
        reason: error.message,
        message: 'Configuration UI flow failed',
      });
      Logger.error('Index', 'Configuration UI flow failed', error, { runId, errorCode });
    }
  }


  /**
   * Fork a background worker to run the full test pipeline.
   * Returns immediately so the MCP request handler can respond fast.
   */
  runPipelineInBackground(config, runId, statusDir) {
    const workerPath = path.join(__dirname, 'pipeline-worker.js');
    Logger.info('Index', `Forking pipeline worker in background`, { runId, projectPath: config.projectPath });

    // ── Kill any previous Healix pipeline worker ────────────────────────────
    // The worker is unref()'d so it survives Windsurf closure. If a previous run
    // is still in-flight (e.g. stuck in AI generation), kill it before starting
    // a new one. We ONLY kill what we wrote into this PID file — nothing else.
    const healixReportsDir = path.join(config.projectPath, 'healix-reports');
    const workerPidFile = path.join(healixReportsDir, '.healix-worker.pid');
    const _killWorkerPid = (pidFile) => {
      if (!fs.existsSync(pidFile)) return;
      let pid;
      try { pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10); } catch { /* ignore */ }
      if (pid > 0) {
        try {
          if (process.platform === 'win32') {
            require('child_process').spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
          } else {
            try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
          }
          Logger.info('Index', 'Killed leftover Healix pipeline worker', { pid });
        } catch { /* already gone */ }
      }
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    };
    try { fs.mkdirSync(healixReportsDir, { recursive: true }); } catch { /* ignore */ }
    _killWorkerPid(workerPidFile);
    // ────────────────────────────────────────────────────────────────────────

    // Write config to a temp file so we send only a tiny file-path string via IPC.
    // On Windows, named-pipe IPC buffers are ~4 KB; a large codebaseContext will
    // overflow the buffer and block child.send() until the child drains it —
    // but the child hasn't started reading yet — causing a permanent deadlock.
    const resolvedStatusDir = statusDir || path.join(
      config.projectPath, 'healix-reports', '.runs', runId
    );
    const configTempFile = path.join(resolvedStatusDir, 'pipeline-config.json');
    let useTempFile = false;
    let sendError = null;
    try {
      fs.mkdirSync(resolvedStatusDir, { recursive: true });
      fs.writeFileSync(configTempFile, JSON.stringify({ config, runId }));
      useTempFile = true;
    } catch (writeErr) {
      Logger.warn('Index', 'Could not write config temp file; falling back to IPC send', { error: writeErr.message });
    }

    // stderr → 'inherit': lets the worker's Logger output flow to the same
    // terminal as the MCP server so token-gating and quality-audit logs are
    // visible in real time. 'inherit' passes the parent's fd directly — it
    // does NOT create a pipe, so there is no back-pressure or event-loop
    // blocking risk (unlike 'pipe' which requires active draining).
    // stdout stays 'ignore'; all important output goes through Logger/stderr.
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env },
    });

    // Send config to worker via IPC — tiny message (file path) or full payload fallback
    try {
      if (useTempFile) {
        child.send({ configFile: configTempFile, runId });
      } else {
        child.send({ config, runId });
      }
    } catch (sendErr) {
      sendError = sendErr;
      process.stderr.write(`[HEALIX] Failed to send config to worker: ${sendErr.message}\n`);
    }

    // Disconnect IPC and unref so MCP server is not blocked
    child.on('message', () => {}); // drain any messages
    setTimeout(() => {
      try { child.disconnect(); } catch (e) { /* already disconnected */ }
    }, 1000);

    // Crash detection: if worker exits before writing a terminal status (regardless of
    // exit code), write an error immediately so waitForPipelineCompletion returns fast
    // instead of hanging for 30 minutes.
    const WORKER_TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported', 'failed']);
    const crashStatusFile = path.join(
      config.projectPath, 'healix-reports', '.runs', runId, 'status.json'
    );
    child.on('exit', (code, signal) => {
      // Always clean up the PID file so it never lingers as a stale kill-target.
      try { fs.unlinkSync(workerPidFile); } catch { /* already deleted or never written */ }

      // Intentional stops (SIGKILL/SIGTERM): skip crash-status write.
      if (code === null && (signal === 'SIGKILL' || signal === 'SIGTERM')) return;
      try {
        let existingPhase = null;
        if (fs.existsSync(crashStatusFile)) {
          try {
            existingPhase = JSON.parse(fs.readFileSync(crashStatusFile, 'utf-8')).phase;
          } catch { /* ignore parse errors */ }
        }
        if (!existingPhase || !WORKER_TERMINAL_PHASES.has(existingPhase)) {
          const isCleanButUnfinished = code === 0;
          const message = isCleanButUnfinished
            ? `Pipeline worker exited before completing (no error code). Last phase: ${existingPhase || 'unknown'}.`
            : `Pipeline worker crashed (exit code ${code}${signal ? ', signal ' + signal : ''}). Last phase: ${existingPhase || 'unknown'}.`;
          const errorCode = isCleanButUnfinished ? 'WORKER_SILENT_EXIT' : 'WORKER_CRASH';
          process.stderr.write(`[HEALIX] ${message}\n`);
          fs.writeFileSync(crashStatusFile, JSON.stringify({
            runId,
            phase: 'error',
            message,
            errorCode,
            timestamp: new Date().toISOString(),
          }));
        }
      } catch (e) {
        process.stderr.write(`[HEALIX] Could not write crash status: ${e.message}\n`);
      }
    });

    if (sendError) {
      // IPC send failed — write error status directly so the pipeline doesn't hang.
      try {
        fs.writeFileSync(crashStatusFile, JSON.stringify({
          runId,
          phase: 'error',
          message: `Failed to start pipeline worker: ${sendError.message}`,
          errorCode: 'WORKER_IPC_SEND_FAILED',
          timestamp: new Date().toISOString(),
        }));
      } catch (e) {
        process.stderr.write(`[HEALIX] Could not write IPC-send error status: ${e.message}\n`);
      }
    }

    // Track this worker's PID so the next run can kill it if still running.
    if (child.pid) {
      try { fs.writeFileSync(workerPidFile, String(child.pid)); } catch { /* non-fatal */ }
    }

    child.unref();

    Logger.info('Index', `Pipeline worker forked`, { pid: child.pid, runId });
    this.emitTelemetry({
      toolName: 'healix_test_my_app',
      eventType: 'worker_spawned',
      runId,
      status: 'info',
      success: true,
      metadata: {
        pid: child.pid,
        projectPath: config.projectPath,
      },
    });
  }

  /**
   * Poll the run status file until the pipeline reaches a terminal phase.
   * Keeps the MCP tool call open so the Windsurf chat stays active and
   * the AI can show the user real results once testing completes.
   */
  async waitForPipelineCompletion(statusFile, maxWaitMs = 1800000) {
    const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported', 'failed']);
    const POLL_INTERVAL_MS = 4000;
    const startedAt = Date.now();

    let lastPhase = '';
    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        if (!fs.existsSync(statusFile)) continue;
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
        if (status.phase && status.phase !== lastPhase) {
          lastPhase = status.phase;
          // Keep stderr writes small to avoid Windows pipe-blocking
          process.stderr.write(`[HEALIX] phase=${status.phase}\n`);
        }
        if (TERMINAL_PHASES.has(status.phase)) {
          return status;
        }
      } catch (_) {
        // File mid-write or not yet created — try again on next poll
      }
    }
    return { phase: 'timeout', message: 'Healix test run monitoring timed out after 30 minutes.' };
  }

  registerTools() {
    this.server.registerTool(
      'healix_configure',
      {
        description: 'Analyze a project and return configuration options before testing. Use this first to understand the project structure, then use the returned configuration with healix_test_my_app. Returns detected settings and questions for the user to answer.',
        inputSchema: z.object({
          projectPath: z.string().optional().describe('Path to the project to analyze (defaults to current workspace)'),
        }),
      },
      async (args, extra) => {
        const telemetryStartedAt = this.trackToolInvocation('healix_configure', args);
        console.error('[DEBUG] healix_configure called, projectPath:', args?.projectPath);
        Logger.mcp('Index', `Tool called: healix_configure`, { projectPath: args?.projectPath });
        try {
          await this.validateApiKey();
          const result = await this.handleConfigure(args);
          this.trackToolResult('healix_configure', telemetryStartedAt);
          console.error('[DEBUG] healix_configure returning result');
          return result;
        } catch (error) {
          this.trackToolResult('healix_configure', telemetryStartedAt, error);
          console.error('[DEBUG] healix_configure error:', error.message);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'healix_test_my_app',
      {
        description: 'Run Healix AI testing on your application end-to-end. Healix opens a browser configuration form, generates tests, executes them against your running app, analyzes any failures with AI, and delivers a results dashboard. Returns immediately with a run ID and configuration URL. When reporting back to the user, refer to this as a "Healix test run" (not a "pipeline"), show the configUrl as a clickable link, and keep the summary concise and branded.',
        inputSchema: z.object({
          projectPath: z.string().optional().describe('Path to the project to test (defaults to current workspace)'),
          testType: z.enum(['frontend', 'backend', 'both']).optional().describe('Type of tests to run'),
          testStrategy: TEST_STRATEGY_SCHEMA.optional().describe('Testing strategy: sequential runs live turn-by-turn tests before synthesizing specs; script uses legacy full-spec generation. Default: sequential.'),
          generateTests: z.boolean().optional().describe('Whether to generate new tests (true) or use existing tests (false)'),
          prdFile: z.string().optional().describe('Path to PRD/requirements document for test generation (optional)'),
          codebaseContext: CODEBASE_CONTEXT_SCHEMA.optional().describe('Structured codebase context from AI agent analysis (pages, apiEndpoints, workflows)'),
          baseURL: z.string().optional().describe('Base URL for the application under test'),
          port: z.number().optional().describe('Port number the app runs on'),
          startCommand: z.string().optional().describe('Command to start the app server (e.g., "npm start")'),
          credentials: z.union([
            CREDENTIAL_SCHEMA,
            z.array(CREDENTIAL_SCHEMA).max(10),
          ]).optional().describe('Optional role credentials used for auth setup and authenticated tests'),
          jira: z.object({
            enabled: z.boolean().optional(),
            baseUrl: z.string().optional(),
            email: z.string().optional(),
            apiToken: z.string().optional(),
            projectKey: z.string().optional(),
          }).optional().describe('Jira integration configuration'),
          openDashboard: z.boolean().optional().describe('Whether to prepare/open dashboard output after tests (default: true)'),
          headless: z.boolean().optional().describe('Run in headless mode (default: true). Prevents auto-opening browser windows from MCP.'),
          autoOpenBrowser: z.boolean().optional().describe('Allow browser auto-open for config/dashboard pages (default: false, ignored when headless=true).'),
          generationMode: z.enum(['openai-first', 'openai-only', 'template-only', 'saas-only']).optional().describe('Generation strategy'),
          strictAIGeneration: z.boolean().optional().describe('Enforce AI-only generation with no template fallback (default: true)'),
          minGeneratedTests: z.number().int().min(1).max(500).optional().describe('Minimum generated tests required before execution (default: 50)'),
          coverageProfile: z.enum(['balanced', 'qa-max', 'exhaustive']).optional().describe('Generation depth and coverage profile (default: qa-max)'),
          phaseMode: z.enum(['single', 'two-phase']).optional().describe('Execution mode: single pass or gate+deep two-phase (default: two-phase)'),
          serverStartTimeoutMs: z.number().int().min(10000).max(300000).optional().describe('Server startup timeout in ms before failing readiness checks (default: 90000)'),
          serverHealthCheckIntervalMs: z.number().int().min(250).max(5000).optional().describe('Interval in ms between server readiness probes (default: 1000)'),
          artifactMode: z.enum(['hybrid', 'full']).optional().describe('Artifact capture mode'),
          videoMode: VIDEO_MODE_SCHEMA.optional().describe('Playwright video capture mode for Healix runs. Default: on.'),
          browserMode: z.enum(['chromium', 'smoke-matrix', 'full-matrix']).optional().describe('Browser execution mode'),
          validateGeneratedTests: z.boolean().optional().describe('Validate generated tests before execution'),
          aiFailureAnalysis: z.boolean().optional().describe('Enable AI analysis for failed tests'),
          showMouseCursorInVideo: z.boolean().optional().describe('Render synthetic mouse cursor overlay in generated Playwright video output (default: true)'),
          playwrightMcp: PLAYWRIGHT_MCP_OPTIONS_SCHEMA.describe('Playwright MCP execution options'),
          resultMerge: RESULT_MERGE_OPTIONS_SCHEMA.describe('Result merge options'),
          logRedaction: LOG_REDACTION_OPTIONS_SCHEMA.describe('Log redaction controls'),
          force: z.boolean().optional().describe('Start a fresh run even if a very recent run for this project is still in-flight or just failed. Default false — without this flag, a repeat invocation within 10 minutes returns the prior run\'s status/error instead of re-opening the configurator, so an agent retry loop does not force the user to re-enter the same settings.'),
        }),
      },
      async (args, extra) => {
        const telemetryStartedAt = this.trackToolInvocation('healix_test_my_app', args);
        // NOTE: Do NOT JSON.stringify full args here — on Windows stderr is a synchronous
        // pipe write; writing 10-50KB of codebaseContext JSON blocks the event loop (4KB pipe buffer).
        console.error('[DEBUG] healix_test_my_app called, projectPath:', args?.projectPath);
        Logger.mcp('Index', `Tool called: healix_test_my_app`, { projectPath: args?.projectPath, testType: args?.testType });
        try {
          await this.validateApiKey();
          const result = await this.handleTestMyApp(args);
          this.trackToolResult('healix_test_my_app', telemetryStartedAt);
          console.error('[DEBUG] healix_test_my_app returning result');
          return result;
        } catch (error) {
          this.trackToolResult('healix_test_my_app', telemetryStartedAt, error);
          console.error('[DEBUG] healix_test_my_app error:', error.message);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'healix_check_run_status',
      {
        description: 'Poll the status of a Healix test run started by healix_test_my_app. You MUST call this repeatedly (every ~15 seconds) until the returned isTerminal flag is true. Do not conclude the user\'s task, do not summarize results, and do not hand control back to the user while isTerminal is false — the pipeline is still running in the background and has not yet produced verdicts. When isTerminal is true, the response contains the final phase, dashboardUrl, and (for runs with failures) a structured actionPlan telling you exactly which patches to auto-apply, which to surface for user approval, which are app regressions you must NOT auto-edit, and any pipeline_error banner details. If the terminal response includes a `remediation` block with `fixable: true`, you MUST attempt the listed remediationSteps yourself (install deps, start webapp, etc.) and then call this tool (or healix_test_my_app) again per the `retry` hint — do NOT return the error to the user when remediation.fixable is true.',
        inputSchema: z.object({
          runId: z.string().describe('The runId returned by healix_test_my_app'),
          projectPath: z.string().optional().describe('Path to the project (defaults to current workspace)'),
        }),
      },
      async (args, extra) => {
        const telemetryStartedAt = this.trackToolInvocation('healix_check_run_status', args);
        Logger.mcp('Index', `Tool called: healix_check_run_status`, { runId: args?.runId });
        try {
          await this.validateApiKey();
          const result = await this.handleCheckRunStatus(args);
          this.trackToolResult('healix_check_run_status', telemetryStartedAt);
          return result;
        } catch (error) {
          this.trackToolResult('healix_check_run_status', telemetryStartedAt, error);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'healix_analyze_failures',
      {
        description: 'Analyze existing test failures with AI without running new tests',
        inputSchema: z.object({
          projectPath: z.string().describe('Path to the project'),
          testResultsPath: z.string().optional().describe('Path to test-results.json file'),
          // aiProvider is deprecated — all AI calls now proxy through the Healix webapp using HEALIX_API_KEY.
          aiProvider: z.enum(['saas']).optional().describe('Deprecated. Only "saas" is supported; all AI proxies through the Healix webapp.'),
        }),
      },
      async (args, extra) => {
        const telemetryStartedAt = this.trackToolInvocation('healix_analyze_failures', args);
        Logger.mcp('Index', `Tool called: healix_analyze_failures`, { projectPath: args?.projectPath });
        try {
          await this.validateApiKey();
          const result = await this.handleAnalyzeFailures(args);
          this.trackToolResult('healix_analyze_failures', telemetryStartedAt);
          return result;
        } catch (error) {
          this.trackToolResult('healix_analyze_failures', telemetryStartedAt, error);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      'healix_generate_report',
      {
        description: 'Generate a dashboard report from existing test results',
        inputSchema: z.object({
          projectPath: z.string().describe('Path to the project'),
          testResultsPath: z.string().optional().describe('Path to test-results.json file'),
          openDashboard: z.boolean().optional().describe('Whether to automatically open the dashboard'),
        }),
      },
      async (args, extra) => {
        const telemetryStartedAt = this.trackToolInvocation('healix_generate_report', args);
        Logger.mcp('Index', `Tool called: healix_generate_report`, { projectPath: args?.projectPath });
        try {
          await this.validateApiKey();
          const result = await this.handleGenerateReport(args);
          this.trackToolResult('healix_generate_report', telemetryStartedAt);
          return result;
        } catch (error) {
          this.trackToolResult('healix_generate_report', telemetryStartedAt, error);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}\n${error.stack}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  /**
   * Validate the HEALIX_API_KEY before executing any tool.
   * Throws a descriptive error if the key is missing, invalid, expired, or credits are exhausted.
   */
  async validateApiKey() {
    const apiKey = process.env.HEALIX_API_KEY;
    const dashboardUrl = process.env.HEALIX_DASHBOARD_URL;

    if (!apiKey) {
      const err = new Error(
        '❌ Healix API key not configured.\n\n' +
        'Add HEALIX_API_KEY to your IDE\'s MCP server configuration:\n\n' +
        '  Cursor  → Edit ~/.cursor/mcp.json\n' +
        '  Windsurf → Edit ~/.codeium/windsurf/mcp_config.json\n\n' +
        'In that file, under your healix-mcp server entry, add an "env" block:\n\n' +
        '  {\n' +
        '    "mcpServers": {\n' +
        '      "healix-mcp": {\n' +
        '        "command": "npx",\n' +
        '        "args": ["-y", "@healix/mcp"],\n' +
        '        "env": {\n' +
        '          "HEALIX_API_KEY": "tb_your_key_here",\n' +
        '          "HEALIX_DASHBOARD_URL": "https://your-dashboard-url"\n' +
        '        }\n' +
        '      }\n' +
        '    }\n' +
        '  }\n\n' +
        'Get your API key from the Healix dashboard → API Keys.\n' +
        'Then restart your IDE for the changes to take effect.'
      );
      err.code = 'KEY_MISSING';
      throw err;
    }

    // If HEALIX_DASHBOARD_URL is unset, the rest of the stack silently falls
    // back to http://localhost:3000 (see webapp-client.js). That default almost
    // never points at a real Healix webapp — it's usually the user's own dev
    // server (or nothing), which makes every downstream fetch fail late with
    // WEBAPP_UNREACHABLE. Probe once up-front and fail fast with an actionable
    // message pointing at the MCP config.
    const effectiveDashboardUrl = dashboardUrl || 'http://localhost:3000';
    if (!dashboardUrl) {
      const { defaultProbeWebappHealth } = require('./port-preflight');
      const webappAlive = await defaultProbeWebappHealth(effectiveDashboardUrl, 2000);
      if (!webappAlive) {
        const err = new Error(
          '❌ HEALIX_DASHBOARD_URL is not set and no Healix webapp is reachable at the default (http://localhost:3000).\n\n' +
          'Healix cannot validate your API key or ingest results without a dashboard URL.\n\n' +
          'Fix one of the following:\n' +
          '  1) Set HEALIX_DASHBOARD_URL in your MCP config to your deployed Healix instance, e.g.\n' +
          '       "HEALIX_DASHBOARD_URL": "https://app.healix.dev"\n' +
          '     Cursor   → ~/.cursor/mcp.json\n' +
          '     Windsurf → ~/.codeium/windsurf/mcp_config.json\n' +
          '  2) Or run the Healix webapp locally:  cd webapp && npm run dev\n\n' +
          'Then restart your IDE for the MCP server to pick up the change.'
        );
        err.code = 'WEBAPP_UNREACHABLE';
        throw err;
      }
      // Local webapp is up; fall through and validate against it.
    }

    // Retry on transient network errors and 5xx responses (e.g. Next.js dev-mode
    // first-request compilation returns 500 before the route is ready).
    const VALIDATE_RETRY_DELAYS_MS = [0, 1500, 3000];
    let response;
    let lastNetworkErr = null;
    for (let attempt = 0; attempt < VALIDATE_RETRY_DELAYS_MS.length; attempt++) {
      if (VALIDATE_RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, VALIDATE_RETRY_DELAYS_MS[attempt]));
        Logger.warn('Index', `Retrying API key validation (attempt ${attempt + 1}/${VALIDATE_RETRY_DELAYS_MS.length})`, {
          prevError: lastNetworkErr?.message,
        });
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        response = await fetch(`${effectiveDashboardUrl}/api/mcp-auth/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.status < 500) break; // success or client error — stop retrying
        lastNetworkErr = new Error(`HTTP ${response.status}`);
      } catch (networkErr) {
        clearTimeout(timeout);
        lastNetworkErr = networkErr;
      }
    }
    if (!response && lastNetworkErr) {
      Logger.error('Index', 'API key validation request failed (network/timeout)', { error: lastNetworkErr.message });
      const err = new Error(
        '❌ Cannot reach the Healix dashboard to validate your API key.\n\n' +
        `Tried: ${effectiveDashboardUrl}/api/mcp-auth/validate\n` +
        `Error: ${lastNetworkErr.message}\n\n` +
        'Check your internet connection, the HEALIX_DASHBOARD_URL value in your MCP config,\n' +
        'and that the Healix webapp is reachable. We won\'t run tests against an un-validated key.'
      );
      err.code = 'KEY_VALIDATION_NETWORK_ERROR';
      throw err;
    }

    if (response.ok) {
      return;
    }

    let data = {};
    try { data = await response.json(); } catch (_) {}

    const errorCode = data.error || 'KEY_INVALID';
    const serverMessage = data.message || 'API key validation failed';

    const USER_MESSAGES = {
      KEY_INVALID: '❌ Invalid Healix API key.\n\nVerify that HEALIX_API_KEY in your IDE MCP config matches the key shown in the Healix dashboard.\n\n  Cursor   → ~/.cursor/mcp.json\n  Windsurf → ~/.codeium/windsurf/mcp_config.json\n',
      KEY_INACTIVE: '❌ Your Healix API key has been deactivated.\n\nGenerate a new key in the Healix dashboard → API Keys, then update the "env" section of your IDE MCP config file.',
      KEY_EXPIRED: '❌ Your Healix API key has expired.\n\nGenerate a new key in the Healix dashboard → API Keys, then update the "env" section of your IDE MCP config file.',
      NO_CREDITS: '❌ No Healix credits remaining.\n\nPlease upgrade your plan or purchase more credits in the Healix dashboard.',
    };

    const message = USER_MESSAGES[errorCode] || `❌ Healix API key rejected: ${serverMessage}`;
    const err = new Error(message);
    err.code = errorCode;
    throw err;
  }

  setupErrorHandling() {
    process.on('uncaughtException', (error) => {
      Logger.error('Index', `[Healix MCP Uncaught Exception]`, error);
    });

    process.on('unhandledRejection', (reason, promise) => {
      Logger.error('Index', `[Healix MCP Unhandled Rejection]`, { reason, promise });
    });

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Configure tool: Analyze project and return configuration options
   */
  async handleConfigure(params) {
    Logger.mcp('Index', 'handleConfigure called', { projectPath: params?.projectPath });

    try {
      const projectPath = params.projectPath || process.cwd();

      Logger.info('Index', 'Analyzing project for configuration...');

      // 1. Auto-detect project settings
      const detector = new AutoDetector();
      const context = await detector.detect(projectPath);

      Logger.info('Index', `Detected project: ${context.projectName} (${context.language})`);
      Logger.info('Index', `Framework detection: ${context.hasPlaywright ? 'Playwright found' : 'No Playwright config'}`);

      // 2. Scan for existing tests
      const existingTests = this.scanExistingTests(projectPath);
      Logger.info('Index', `Found ${existingTests.count} existing test files`);

      // 3. Check for PRD/requirements files
      const prdFiles = this.findPRDFiles(projectPath);
      Logger.info('Index', `Found ${prdFiles.length} potential PRD files`);

      // 4. Check for Jira configuration
      const hasJiraConfig = context.hasJira || !!(
        process.env.JIRA_BASE_URL &&
        process.env.JIRA_API_TOKEN &&
        process.env.JIRA_PROJECT_KEY
      );

      // 5. Build configuration response with questions
      const config = {
        projectInfo: {
          name: context.projectName,
          path: context.projectPath,
          language: context.language,
          ecosystem: context.ecosystem,
          framework: this.detectFramework(context),
          port: context.port,
          baseURL: context.baseURL,
          startCommand: context.startCommand,
          hasPlaywrightConfig: context.hasPlaywright,
          hasExistingTests: existingTests.count > 0,
          existingTestFiles: existingTests.files.slice(0, 10),
          totalTestFiles: existingTests.count,
          testDirectories: context.testDirs,
          // Monorepo / multi-service detection. `services` always has at least one entry.
          // When the repo splits frontend + backend, there will be two entries with
          // distinct roles, ports, baseURLs, and startCommands. `apiOnly` is true when
          // every detected service is a backend — downstream generator branches into
          // deep multi-step API flow mode.
          services: context.services,
          apiOnly: !!context.apiOnly,
        },
        prdFiles: prdFiles,
        jiraAvailable: hasJiraConfig,
        aiProviderAvailable: !!process.env.HEALIX_API_KEY,

        // Questions for the user to answer
        questions: [
          {
            id: 'testScope',
            prompt: 'What would you like to test?',
            options: ['frontend', 'backend', 'both'],
            default: 'both',
            description: 'Choose frontend for UI tests, backend for API tests, or both for full coverage'
          },
          {
            id: 'generateTests',
            prompt: existingTests.count > 0
              ? `Found ${existingTests.count} existing tests. Generate new tests or use existing?`
              : 'No existing tests found. Should I generate tests?',
            options: existingTests.count > 0
              ? ['generate_new', 'use_existing', 'both']
              : ['generate_new', 'skip'],
            default: existingTests.count > 0 ? 'use_existing' : 'generate_new',
            description: 'generate_new creates tests from codebase analysis, use_existing runs your current tests'
          },
        ],

        // Context prompt for the AI agent to analyze codebase
        contextPrompt: this.buildContextPrompt(projectPath, context),

        // Recommended configuration based on detection
        recommendedConfig: {
          projectPath: context.projectPath,
          services: context.services,
          apiOnly: !!context.apiOnly,
          testType: context.apiOnly ? 'backend' : 'both',
          baseURL: context.baseURL,
          port: context.port,
          startCommand: context.startCommand,
          generateTests: existingTests.count === 0,
          prdFile: prdFiles.length > 0 ? prdFiles[0] : null,
          aiProvider: 'saas',
          openDashboard: true,
        }
      };

      // Add PRD question if files found
      if (prdFiles.length > 0) {
        config.questions.push({
          id: 'usePRD',
          prompt: `Found potential PRD file(s): ${prdFiles.join(', ')}. Use for test generation?`,
          options: ['yes', 'no', 'specify_other'],
          default: 'yes',
          description: 'PRD files help generate more accurate tests based on requirements'
        });
      }

      // Add Jira question if available
      if (hasJiraConfig) {
        config.questions.push({
          id: 'useJira',
          prompt: 'Jira integration is configured. Fetch stories for test generation?',
          options: ['yes', 'no'],
          default: 'no',
          description: 'Fetch active Jira stories and generate tests from acceptance criteria'
        });
      }

      // Add AI analysis question
      if (config.aiProviderAvailable) {
        config.questions.push({
          id: 'enableAI',
          prompt: 'Enable AI-powered failure analysis?',
          options: ['yes', 'no'],
          default: 'yes',
          description: 'AI will analyze any test failures and suggest fixes'
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(config, null, 2),
          },
        ],
      };
    } catch (error) {
      Logger.error('Index', `Configuration error`, error);
      throw error;
    }
  }

  /**
   * Scan for existing test files
   */
  scanExistingTests(projectPath) {
    const fs = require('fs');
    const path = require('path');
    const testDirs = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'cypress', 'playwright'];
    const testPatterns = ['.spec.js', '.spec.ts', '.test.js', '.test.ts', '.e2e.js', '.e2e.ts'];
    const files = [];

    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.includes('node_modules')) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            if (testPatterns.some(pattern => entry.name.endsWith(pattern))) {
              files.push(path.relative(projectPath, fullPath));
            }
          }
        }
      } catch (error) {
        // Ignore permission errors
      }
    };

    // Scan test directories
    for (const testDir of testDirs) {
      scanDir(path.join(projectPath, testDir));
    }

    // Also check root for test files
    scanDir(projectPath);

    return {
      count: files.length,
      files: files
    };
  }

  /**
   * Find PRD/requirements files
   */
  findPRDFiles(projectPath) {
    const fs = require('fs');
    const path = require('path');
    const prdPatterns = [
      'prd.md', 'PRD.md', 'plan.md', 'Plan.md',
      'requirements.md', 'Requirements.md', 'REQUIREMENTS.md',
      'spec.md', 'specs.md', 'specification.md',
      'docs/prd.md', 'docs/requirements.md', 'docs/plan.md',
      'documentation/prd.md', 'documentation/requirements.md',
    ];

    const found = [];

    for (const pattern of prdPatterns) {
      const filePath = path.join(projectPath, pattern);
      if (fs.existsSync(filePath)) {
        found.push(pattern);
      }
    }

    // Also check for README if nothing else found
    if (found.length === 0) {
      const readmePath = path.join(projectPath, 'README.md');
      if (fs.existsSync(readmePath)) {
        try {
          const content = fs.readFileSync(readmePath, 'utf-8').toLowerCase();
          if (content.includes('requirements') || content.includes('features') || content.includes('user stories')) {
            found.push('README.md (contains requirements section)');
          }
        } catch (error) {
          // Ignore read errors
        }
      }
    }

    return found;
  }

  /**
   * Detect framework from context
   */
  detectFramework(context) {
    const packageJson = context.packageJson;
    if (!packageJson?.dependencies && !packageJson?.devDependencies) {
      // For non-Node.js projects, return language-based framework
      if (context.language && context.language !== 'javascript') {
        return context.language.charAt(0).toUpperCase() + context.language.slice(1);
      }
      return 'Unknown';
    }

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    if (allDeps.next) return 'Next.js';
    if (allDeps.nuxt) return 'Nuxt.js';
    if (allDeps['@angular/core']) return 'Angular';
    if (allDeps.vue) return 'Vue.js';
    if (allDeps.react) return 'React';
    if (allDeps.svelte) return 'Svelte';
    if (allDeps.express) return 'Express.js';
    if (allDeps.fastify) return 'Fastify';
    if (allDeps.koa) return 'Koa';
    if (allDeps.nest) return 'NestJS';

    return 'Node.js';
  }

  /**
   * Build context prompt for AI agent to analyze codebase
   */
  buildContextPrompt(projectPath, context) {
    return `
Please analyze the codebase at ${projectPath} and provide structured information for test generation.

**Project Info:**
- Name: ${context.projectName}
- Language: ${context.language || 'Unknown'}
- Framework: ${this.detectFramework(context)}
- Port: ${context.port}
- Base URL: ${context.baseURL}

**Please analyze and return JSON with this structure:**

\`\`\`json
{
  "pages": [
    {
      "path": "/login",
      "description": "User login page",
      "components": ["LoginForm", "ForgotPasswordLink"],
      "interactions": ["email input", "password input", "submit button", "forgot password link"]
    }
  ],
  "apiEndpoints": [
    {
      "method": "POST",
      "path": "/api/auth/login",
      "description": "User authentication",
      "requiresAuth": false,
      "requestBody": { "email": "string", "password": "string" },
      "responseSchema": { "token": "string", "user": "object" }
    }
  ],
  "workflows": [
    {
      "name": "User registration flow",
      "description": "New user can create an account",
      "steps": ["Navigate to register", "Fill form", "Submit", "Verify success state"]
    },
    {
      "name": "User login flow",
      "description": "Existing user signs in",
      "steps": ["Navigate to login", "Enter credentials", "Submit", "Verify redirect to dashboard"]
    },
    {
      "name": "Main feature workflow",
      "description": "Core value path for primary feature",
      "steps": ["Open feature page", "Perform action", "Verify persisted result"]
    }
  ],
  "testPriorities": [
    { "feature": "Authentication", "priority": "high", "reason": "Core functionality" },
    { "feature": "Main dashboard", "priority": "high", "reason": "Primary user interface" }
  ]
}
\`\`\`

Look for:
1. Route definitions (pages, API routes)
2. Component files
3. Form handlers
4. API endpoint definitions
5. Authentication logic
6. Main user workflows

Return the JSON structure above based on what you find in the codebase.
`;
  }

  /**
   * Main tool: Test the app end-to-end
   * Returns immediately and runs the pipeline in a background worker.
   */
  async handleTestMyApp(params) {
    if (params?.logRedaction) {
      Logger.setRedaction(params.logRedaction);
    }

    Logger.mcp('Index', 'handleTestMyApp called', { projectPath: params?.projectPath });

    // 1. Fast auto-detection (~100ms)
    Logger.info('Index', 'Detecting project settings...');
    const detector = this.createAutoDetector();
    const context = await detector.detect(params.projectPath || process.cwd());

    Logger.info('Index', `Project: ${context.projectName} (${context.language})`, { path: context.projectPath });

    // 2. Merge params with detected context
    const baseConfig = this.createBasePipelineConfig(context, params);

    // Short-circuit: if the previous run for this project is very recent, surface it
    // instead of launching a new config UI. This prevents agent retry loops where
    // Cursor re-invokes the tool after a failure and the user is forced to re-enter
    // the same settings instead of fixing the underlying error in code.
    const recent = this.findRecentRunForProject(baseConfig.projectPath);
    if (recent && !params.force) {
      const ageMs = Date.now() - recent.mtimeMs;
      const ageSec = Math.round(ageMs / 1000);
      if (recent.data.phase === 'error' && ageMs < 10 * 60 * 1000) {
        const errMsg = recent.data.error || recent.data.message || 'Pipeline failed';
        const errCode = recent.data.errorCode || 'PIPELINE_FAILED';
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Your previous Healix run (${recent.runId}) failed ${ageSec}s ago:\n\n  ${errCode}: ${errMsg}\n\nDO NOT retry this tool blindly — investigate and fix the root cause in the codebase (e.g. failing dependency, misconfigured dev server, broken selector). Once fixed, re-run with { force: true } to start a fresh Healix run.\n\nPrevious run status: ${path.join(baseConfig.projectPath, 'healix-reports', '.runs', recent.runId, 'status.json')}`,
            },
          ],
        };
      }
      if (recent.data.phase === 'awaiting_config_ui' && recent.data.configUrl && ageMs < 10 * 60 * 1000) {
        return {
          content: [
            {
              type: 'text',
              text: `A Healix configuration form is already open for run ${recent.runId} (${ageSec}s ago):\n\n  ${recent.data.configUrl}\n\nOpen and submit it to start testing. Pass { force: true } to discard and start a fresh run.`,
            },
          ],
        };
      }
      if (['queued','started','detecting','context','context_enrichment','jira','port_conflict','warning','parsing_prd','prd_parsed','plan_generated','exploring','explored','auth_injecting','auth_injected','generating','generation_partial','generation_async_enqueued','generation_async_progress','running','running_tests','secondary_services_started','tests_complete','reporting','uploading_artifacts','artifacts_uploaded'].includes(recent.data.phase) && ageMs < 30 * 60 * 1000) {
        return {
          content: [
            {
              type: 'text',
              text: `A Healix run (${recent.runId}) is already in progress for this project — phase: ${recent.data.phase} (${ageSec}s ago).\n\nWait for it to finish, or pass { force: true } to start a fresh run.`,
            },
          ],
        };
      }
    }

    // 3. Generate a unique run ID
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const statusDir = path.join(baseConfig.projectPath, 'healix-reports', '.runs', runId);
    const statusFile = path.join(statusDir, 'status.json');
    fs.mkdirSync(statusDir, { recursive: true });

    // 3a. Port pre-flight: catch dashboard↔target port collisions BEFORE the
    // config UI is served, so the form shows the corrected port and the
    // pipeline doesn't fight the webapp for localhost:3000 later.
    try {
      const { checkDashboardPortConflict, describePreflight } = require('./port-preflight');
      const preflightDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';
      const preflight = await checkDashboardPortConflict({
        dashboardUrl: preflightDashboardUrl,
        targetBaseUrl: baseConfig.baseURL,
        targetPort: baseConfig.port,
      });
      if (preflight.conflict && preflight.newPort) {
        Logger.warn('Index', 'Port pre-flight bumped target dev-server port before config UI', {
          originalPort: preflight.originalPort,
          newPort: preflight.newPort,
          detectedAs: preflight.detectedAs,
        });
        baseConfig.port = preflight.newPort;
        baseConfig.baseURL = preflight.newBaseUrl || `http://localhost:${preflight.newPort}`;
        this.writeRunStatus(statusFile, {
          runId,
          phase: 'port_preflight_fixed',
          message: describePreflight(preflight),
          project: baseConfig.projectName,
          originalPort: preflight.originalPort,
          newPort: preflight.newPort,
          detectedAs: preflight.detectedAs,
          newBaseUrl: baseConfig.baseURL,
        });
        this.emitTelemetry({
          toolName: 'healix_test_my_app',
          eventType: 'port_preflight',
          runId,
          status: 'warning',
          success: true,
          message: describePreflight(preflight),
          metadata: {
            originalPort: preflight.originalPort,
            newPort: preflight.newPort,
            detectedAs: preflight.detectedAs,
          },
        });
      } else if (preflight.conflict) {
        // Couldn't find a free port nearby — don't block the run; the pipeline's
        // in-flight resolver will take another crack, but at least surface the
        // issue in status so the dashboard shows it.
        Logger.warn('Index', 'Port pre-flight detected a conflict but found no free port', {
          originalPort: preflight.originalPort,
          detectedAs: preflight.detectedAs,
        });
      }
    } catch (err) {
      // Pre-flight is best-effort; never block the run on it.
      Logger.warn('Index', 'Port pre-flight failed (non-fatal)', { error: err?.message });
    }

    // Write initial status
    this.writeRunStatus(statusFile, {
      runId,
      phase: 'queued',
      message: 'Healix run queued.',
      project: baseConfig.projectName,
      aiOnlyEnforced: baseConfig.strictAIGeneration !== false,
    });
    this.emitTelemetry({
      toolName: 'healix_test_my_app',
      eventType: 'run_created',
      runId,
      status: 'info',
      success: true,
      message: 'MCP run created and queued',
      metadata: {
        projectPath: baseConfig.projectPath,
        project: baseConfig.projectName,
        testType: baseConfig.testType,
        testStrategy: baseConfig.testStrategy,
        strictAIGeneration: baseConfig.strictAIGeneration !== false,
      },
    });

    const dashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';
    const headless = this.resolveHeadlessPreference(params);
    const autoOpenBrowser = this.resolveAutoOpenBrowserPreference(params, headless);
    let configUrl = null;

    if (this.hasDirectRunConfig(params)) {
      const directSubmission = this.buildDirectUISubmission(baseConfig, params);
      const waitForConfig = Promise.resolve(directSubmission);

      this.writeRunStatus(statusFile, {
        runId,
        phase: 'config_received',
        message: 'Configuration supplied by MCP arguments. Starting Healix worker...',
        project: baseConfig.projectName,
        aiOnlyEnforced: baseConfig.strictAIGeneration !== false,
        testStrategy: baseConfig.testStrategy,
      });
      this.emitTelemetry({
        toolName: 'healix_test_my_app',
        eventType: 'config_direct',
        runId,
        phase: 'config_received',
        status: 'success',
        success: true,
        message: 'Configuration supplied directly via MCP arguments',
        metadata: {
          project: baseConfig.projectName,
          testStrategy: baseConfig.testStrategy,
        },
      });

      this.continuePipelineAfterConfig({ waitForConfig, runId, statusFile, statusDir, baseConfig })
        .finally(() => { this._activeConfigUILauncher = null; })
        .catch((err) => {
          Logger.error('Index', `Pipeline failure for run ${runId}`, { error: err?.message, code: err?.code });
          try {
            this.writeRunStatus(statusFile, {
              runId,
              phase: 'error',
              message: err?.message || 'Pipeline failed',
              error: err?.message || String(err),
              errorCode: err?.code || 'PIPELINE_FAILED',
              project: baseConfig.projectName,
              testStrategy: baseConfig.testStrategy,
            });
          } catch (_) {}
          process.stderr.write(`[HEALIX] Pipeline failed for run ${runId}: ${err?.message || err}\n`);
        });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              runId,
              project: baseConfig.projectName,
              phase: 'started',
              statusFile,
              dashboardUrl: `${dashboardUrl.replace(/\/+$/, '')}/test-run/live-${runId}`,
              testStrategy: baseConfig.testStrategy,
              message: `Healix started automatically using testStrategy=${baseConfig.testStrategy}.`,
              agentInstructions: [
                `The test pipeline is running in the BACKGROUND. This tool returned immediately; no tests have completed yet.`,
                `You MUST now call healix_check_run_status with { runId: "${runId}" } every ~15 seconds until the response has isTerminal:true.`,
                `Do NOT hand control back to the user, summarize, or declare the task done while isTerminal is false.`,
              ],
            }, null, 2),
          },
        ],
      };
    }

    {
      // ── Config UI: always launched — return immediately with URL, run pipeline in background ──
      let waitForConfig;
      try {
        // Always open the browser for the config form — headless controls
        // Playwright test execution, not the config UI itself.
        const configUILauncher = this.createConfigUILauncher({ headless, autoOpenBrowser: true });
        const launchResult = await configUILauncher.launchNonBlocking({
          projectPath: baseConfig.projectPath,
          projectName: baseConfig.projectName,
          framework: this.detectFramework(context),
          baseURL: baseConfig.baseURL,
          port: String(baseConfig.port),
          startCommand: baseConfig.startCommand,
          testType: baseConfig.testType,
          testStrategy: baseConfig.testStrategy,
          generateTests: baseConfig.generateTests,
          openDashboard: baseConfig.openDashboard,
          strictAIGeneration: baseConfig.strictAIGeneration !== false,
          minGeneratedTests: Number(baseConfig.minGeneratedTests || 50),
          coverageProfile: baseConfig.coverageProfile || 'qa-max',
          phaseMode: baseConfig.phaseMode || 'two-phase',
          headless,
          autoOpenBrowser,
        });
        configUrl = launchResult.configUrl;
        waitForConfig = launchResult.waitForConfig;

        this.writeRunStatus(statusFile, {
          runId,
          phase: 'awaiting_config_ui',
          message: 'Waiting for configuration submission from UI.',
          project: baseConfig.projectName,
          configUrl,
          aiOnlyEnforced: baseConfig.strictAIGeneration !== false,
        });
        this.emitTelemetry({
          toolName: 'healix_test_my_app',
          eventType: 'config_ui',
          runId,
          phase: 'awaiting_config_ui',
          status: 'info',
          success: true,
          message: 'Configuration UI ready and awaiting submission',
        });
        process.stderr.write(`[HEALIX] Config form: ${configUrl} — open and submit to start testing.\n`);
      } catch (error) {
        this.writeRunStatus(statusFile, {
          runId,
          phase: 'error',
          message: `Failed to launch configuration UI: ${error.message}`,
          error: error.message,
          errorCode: 'CONFIG_UI_LAUNCH_FAILED',
          project: baseConfig.projectName,
          aiOnlyEnforced: baseConfig.strictAIGeneration !== false,
        });
        throw error;
      }

      // Fire pipeline continuation in the background — do NOT await it here.
      // This lets the MCP tool return immediately so the user sees the configUrl
      // in chat and can open it even if the browser didn't auto-launch.
      this.continuePipelineAfterConfig({ waitForConfig, runId, statusFile, statusDir, baseConfig })
        .finally(() => { this._activeConfigUILauncher = null; })
        .catch((err) => {
          // continuePipelineAfterConfig already writes errors to statusFile;
          // but surface them on stderr so IDEs (Cursor/Windsurf) show them in chat.
          Logger.error('Index', `Pipeline failure for run ${runId}`, { error: err?.message, code: err?.code });
          try {
            this.writeRunStatus(statusFile, {
              runId,
              phase: 'error',
              message: err?.message || 'Pipeline failed',
              error: err?.message || String(err),
              errorCode: err?.code || 'PIPELINE_FAILED',
              project: baseConfig.projectName,
            });
          } catch (_) {}
          process.stderr.write(`[HEALIX] Pipeline failed for run ${runId}: ${err?.message || err}\n`);
        });

      // Return immediately — the tool description says "Returns immediately with a
      // run ID and config URL while awaiting configuration."
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              runId,
              project: baseConfig.projectName,
              phase: 'awaiting_config_ui',
              configUrl,
              statusFile,
              message: `Healix is ready to test your app!\n\nOpen the configuration form, review the detected settings, and click "Start Testing":\n\n${configUrl}\n\nHealix will automatically begin testing once the form is submitted.`,
              agentInstructions: [
                `The test pipeline is running in the BACKGROUND. This tool returned immediately; no tests have completed yet.`,
                `You MUST now call healix_check_run_status with { runId: "${runId}" } every ~15 seconds until the response has isTerminal:true.`,
                `Do NOT hand control back to the user, summarize, or declare the task done while isTerminal is false.`,
                `When isTerminal is true, the poll response carries an actionPlan telling you which patches are safe to auto-apply (high-confidence test bugs), which to surface for user approval, and which are app regressions you must NOT auto-edit.`,
                `If the run ends with a pipeline_error, the poll response carries the stderr + stage + reason — relay them to the user with the dashboard link.`,
              ].join(' '),
            }, null, 2),
          },
        ],
      };
    }
  }

  /**
   * Read the current status of a background pipeline run and return a
   * structured response the Cursor agent can act on.
   *
   * Non-terminal phases return `isTerminal: false` and explicit instructions
   * to poll again. Terminal phases (`completed`, `error`, `error_reported`,
   * `failed`) return the full T7 action plan when a report is on disk, or a
   * compact summary otherwise.
   */
  async handleCheckRunStatus(params) {
    Logger.mcp('Index', 'handleCheckRunStatus called', { runId: params?.runId });

    const runId = params?.runId;
    if (!runId || typeof runId !== 'string') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'runId is required (a string returned by healix_test_my_app).' }, null, 2) }],
        isError: true,
      };
    }
    const projectPath = params.projectPath || process.cwd();
    const statusFile = path.join(projectPath, 'healix-reports', '.runs', runId, 'status.json');

    if (!fs.existsSync(statusFile)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            runId,
            isTerminal: false,
            error: 'RUN_NOT_FOUND',
            message: `No status file at ${statusFile}. Double-check the runId and projectPath you passed to healix_test_my_app.`,
          }, null, 2),
        }],
        isError: true,
      };
    }

    let status;
    try {
      status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
    } catch (err) {
      // Mid-write — tell the agent to try again shortly rather than failing.
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            runId,
            isTerminal: false,
            phase: 'transient_read_error',
            agentInstructions: 'Status file was mid-write. Wait ~5 seconds and call healix_check_run_status again.',
          }, null, 2),
        }],
      };
    }

    const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported', 'failed']);
    const isTerminal = TERMINAL_PHASES.has(status.phase);

    const base = {
      success: true,
      runId,
      phase: status.phase || 'unknown',
      isTerminal,
      message: status.message || null,
      errorCode: status.errorCode || null,
      project: status.project || null,
      configUrl: status.configUrl || null,
      dashboardUrl: status.dashboardUrl || process.env.HEALIX_DASHBOARD_URL || null,
      reportPath: status.reportPath || null,
      timestamp: status.timestamp || null,
    };

    if (!isTerminal) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...base,
            agentInstructions: `The pipeline is still at phase='${status.phase || 'unknown'}'. ${
              ['parsing_prd','generating','generation_async_enqueued','generation_async_progress','plan_generated','exploring'].includes(status.phase)
                ? 'This phase can take 1–3 minutes — call healix_check_run_status again in ~60 seconds.'
                : ['running','running_tests','secondary_services_started','tests_complete'].includes(status.phase)
                  ? 'Call healix_check_run_status again in ~30 seconds.'
                  : 'Call healix_check_run_status again in ~20 seconds.'
            } Do not call healix_test_my_app again — a run is already in progress. Do not conclude the task until isTerminal is true.`,
          }, null, 2),
        }],
      };
    }

    // Terminal — try to build the T7 action plan from the latest report.
    const report = this.loadLatestHealixReport(projectPath);
    if (report) {
      try {
        const { buildAgentResponse } = require('./failure-triage/agent-response');
        const agentResponse = buildAgentResponse({
          report,
          projectPath,
          dashboardUrl: base.dashboardUrl,
          testRunId: runId,
        });
        return {
          content: [{
            type: 'text',
            text: `${agentResponse.actionPlan}\n\n---\n\n${JSON.stringify({
              ...base,
              summary: agentResponse.summary,
              verdicts: agentResponse.verdicts,
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        Logger.warn('Index', 'buildAgentResponse failed in check_run_status', { error: err.message });
      }
    }

    if (status.phase === 'completed') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...base,
            agentInstructions: 'Run completed. Share the dashboardUrl with the user.',
          }, null, 2),
        }],
      };
    }

    // Terminal error with no T7 report — attach a structured remediation block
    // so the Cursor agent can auto-fix instead of handing the error to the user.
    let remediationBlock = null;
    let remediationMarkdown = '';
    try {
      const { buildRemediationBlock, formatRemediationBlock } = require('./failure-triage/error-remediations');
      remediationBlock = buildRemediationBlock({
        errorCode: status.errorCode,
        fallbackMessage: status.message,
      });
      remediationMarkdown = formatRemediationBlock(remediationBlock);
    } catch (err) {
      Logger.warn('Index', 'buildRemediationBlock failed', { error: err.message });
    }

    const agentInstructions = remediationBlock
      ? (remediationBlock.fixable
        ? `Healix hit an auto-fixable error (${remediationBlock.errorCode}). Follow the remediation steps — do NOT hand this back to the user. After fixing, call ${remediationBlock.retry?.tool || 'healix_test_my_app'} again.`
        : `Healix hit an error that needs user input (${remediationBlock.errorCode}). Surface the headline + dashboardUrl, ask the user to act, then retry.`)
      : 'Run ended in error. Relay the message + errorCode + dashboardUrl to the user.';

    const payload = {
      ...base,
      agentInstructions,
      remediation: remediationBlock,
    };

    const text = remediationMarkdown
      ? `${remediationMarkdown}\n\n---\n\n${JSON.stringify(payload, null, 2)}`
      : JSON.stringify(payload, null, 2);

    return {
      content: [{ type: 'text', text }],
    };
  }

  /**
   * Analyze existing test failures
   */
  async handleAnalyzeFailures(params) {
    Logger.mcp('Index', 'handleAnalyzeFailures called', { projectPath: params?.projectPath });

    const projectPath = params.projectPath || process.cwd();
    const testResultsPath = params.testResultsPath || `${projectPath}/test-results.json`;
    Logger.info('Index', `Analyzing failures in ${testResultsPath}...`);

    const playwright = new PlaywrightIntegration({ projectPath });
    const testResults = await playwright.loadTestResults(testResultsPath);

    if (testResults.failed === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'No failures to analyze' }),
          },
        ],
      };
    }

    const analyzer = AIAnalyzer.create('saas', process.env.HEALIX_API_KEY);
    const analysis = await analyzer.analyzeFailures(testResults.failures);

    // T7 — try to load the latest Healix report and produce the structured
    // Cursor-agent handoff. Falls back to the legacy analyses[] payload when
    // no report is on disk (e.g. user ran analyze-failures standalone).
    const report = this.loadLatestHealixReport(projectPath);
    if (report) {
      const { buildAgentResponse } = require('./failure-triage/agent-response');
      const agentResponse = buildAgentResponse({
        report,
        projectPath,
        dashboardUrl: process.env.HEALIX_DASHBOARD_URL || null,
        testRunId: report.metadata?.testRunId ?? report.metadata?.runId ?? null,
        aiAnalysis: analysis,
      });
      return {
        content: [
          {
            type: 'text',
            text: `${agentResponse.actionPlan}\n\n---\n\n${JSON.stringify({
              success: true,
              summary: agentResponse.summary,
              verdicts: agentResponse.verdicts,
              dashboardUrl: agentResponse.dashboardUrl,
              analyses: analysis,
            }, null, 2)}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            analyzed: analysis.length,
            analyses: analysis,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Find and parse the most recent Healix report JSON for a project, if any.
   * Returns null when the project has never been reported on.
   */
  loadLatestHealixReport(projectPath) {
    try {
      const fs_ = require('node:fs');
      const path_ = require('node:path');
      const reportsDir = path_.join(projectPath, 'healix-reports');
      const latestPath = path_.join(reportsDir, 'latest.json');
      if (fs_.existsSync(latestPath)) {
        return JSON.parse(fs_.readFileSync(latestPath, 'utf-8'));
      }
      if (!fs_.existsSync(reportsDir)) return null;
      const files = fs_.readdirSync(reportsDir)
        .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
        .sort()
        .reverse();
      if (files.length === 0) return null;
      return JSON.parse(fs_.readFileSync(path_.join(reportsDir, files[0]), 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Generate report from existing test results
   */
  async handleGenerateReport(params) {
    Logger.mcp('Index', 'handleGenerateReport called', { params });

    const projectPath = params.projectPath || process.cwd();
    const testResultsPath = params.testResultsPath || `${projectPath}/test-results.json`;

    Logger.info('Index', `Generating report from ${testResultsPath}...`);

    const playwright = new PlaywrightIntegration({ projectPath });
    const testResults = await playwright.loadTestResults(testResultsPath);

    const reportGen = new ReportGenerator();
    const report = await reportGen.generate({
      projectPath,
      projectName: require('path').basename(projectPath),
      runId: params.runId || null,
      testResults,
      aiAnalysis: null,
      jiraData: null,
      api_key: process.env.HEALIX_API_KEY,
      dashboard_url: process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000',
    });

    let dashboardUrl = null;
    if (params.openDashboard !== false) {
      dashboardUrl = await DashboardLauncher.open(report.path, {
        headless: this.resolveHeadlessPreference(params),
        openBrowser: this.resolveAutoOpenBrowserPreference(params),
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            reportPath: report.path,
            dashboardUrl,
          }, null, 2),
        },
      ],
    };
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    Logger.info('Index', 'Healix MCP server started');
  }
}

// Start the server
if (require.main === module) {
  const server = new HealixMCPServer();
  server.start().catch(console.error);
}

module.exports = HealixMCPServer;
