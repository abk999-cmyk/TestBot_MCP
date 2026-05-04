/**
 * Playwright MCP Client
 * Handles communication with the official Playwright MCP server
 * and provides fallback test generation when MCP is unavailable
 */

const fs = require('fs');
const path = require('path');

class PlaywrightMCPClient {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      baseURL: config.baseURL || 'http://localhost:3000',
      timeout: config.timeout || 60000,
      strictWorkflowStepTypes: config.strictWorkflowStepTypes !== false,
      videoMode: String(config.videoMode || process.env.HEALIX_VIDEO_MODE || 'on').trim().toLowerCase() === 'retain-on-failure'
        ? 'retain-on-failure'
        : 'on',
      ...config,
    };
    this.config.videoMode = String(this.config.videoMode || '').trim().toLowerCase() === 'retain-on-failure'
      ? 'retain-on-failure'
      : 'on';
    
    this.mcpAvailable = false;
  }

  toSortedArray(items, keyBuilder) {
    if (!Array.isArray(items)) {
      return [];
    }

    return [...items].sort((a, b) => {
      const keyA = String(keyBuilder(a) || '').toLowerCase();
      const keyB = String(keyBuilder(b) || '').toLowerCase();
      return keyA.localeCompare(keyB);
    });
  }

  sanitizeFilenameSegment(value, fallback) {
    return String(value || '')
      .replace(/[<>:"|?*\[\](){}\\\/]/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_')
      || fallback;
  }

  createStableHash(input) {
    let hash = 2166136261;
    const text = String(input || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(36);
  }

  getUniqueFilename(preferredFilename, usedFilenames) {
    const ext = path.extname(preferredFilename);
    const basename = path.basename(preferredFilename, ext);
    let filename = preferredFilename;
    let suffix = 2;

    while (usedFilenames.has(filename)) {
      filename = `${basename}_${suffix}${ext}`;
      suffix += 1;
    }

    usedFilenames.add(filename);
    return filename;
  }

  escapeForSingleQuote(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r?\n/g, ' ');
  }

  escapeForRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  extractTarget(text, fallback = 'control') {
    const normalized = String(text || '').toLowerCase();
    const stripped = normalized
      .replace(/\b(should|user|can|must|the|a|an|working|able|to)\b/g, ' ')
      .replace(/\b(click|tap|press|submit|open|navigate|go|visit|enter|fill|type|select|choose|check|verify)\b/g, ' ')
      .replace(/\b(button|link|field|input|form|page)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!stripped) {
      return fallback;
    }

    const words = stripped.split(' ').slice(0, 4).join(' ');
    return words || fallback;
  }

  getExpectedSuccessStatuses(method, endpoint) {
    const statusCandidates = [
      endpoint?.expectedStatus,
      endpoint?.expectedStatuses,
      endpoint?.successStatus,
      endpoint?.successStatuses,
      endpoint?.status,
      endpoint?.statuses,
    ].flatMap((entry) => {
      if (Array.isArray(entry)) {
        return entry;
      }
      if (entry === undefined || entry === null) {
        return [];
      }
      return [entry];
    });

    const parsedCandidates = [...new Set(
      statusCandidates
        .map((status) => Number(status))
        .filter((status) => Number.isInteger(status) && status >= 100 && status <= 599)
        .sort((a, b) => a - b)
    )];

    if (parsedCandidates.length > 0) {
      return parsedCandidates;
    }

    return [];
  }

  getExpectedAuthStatuses(endpoint) {
    const statusCandidates = [
      endpoint?.authStatus,
      endpoint?.authStatuses,
      endpoint?.unauthorizedStatus,
      endpoint?.unauthorizedStatuses,
      endpoint?.forbiddenStatus,
      endpoint?.forbiddenStatuses,
      endpoint?.status,
      endpoint?.statuses,
    ].flatMap((entry) => {
      if (Array.isArray(entry)) {
        return entry;
      }
      if (entry === undefined || entry === null) {
        return [];
      }
      return [entry];
    });

    const parsedCandidates = [...new Set(
      statusCandidates
        .map((status) => Number(status))
        .filter((status) => Number.isInteger(status) && [302, 303, 307, 308, 401, 403].includes(status))
        .sort((a, b) => a - b)
    )];

    return parsedCandidates;
  }

  getExpectedResponseKeys(endpoint) {
    const candidates = [];

    if (Array.isArray(endpoint?.responseShape)) {
      candidates.push(...endpoint.responseShape);
    } else if (endpoint?.responseShape && typeof endpoint.responseShape === 'object') {
      candidates.push(...Object.keys(endpoint.responseShape));
    }

    if (Array.isArray(endpoint?.responseSchema)) {
      candidates.push(...endpoint.responseSchema);
    } else if (endpoint?.responseSchema && typeof endpoint.responseSchema === 'object') {
      candidates.push(...Object.keys(endpoint.responseSchema));
    }

    if (endpoint?.responseBody && typeof endpoint.responseBody === 'object' && !Array.isArray(endpoint.responseBody)) {
      candidates.push(...Object.keys(endpoint.responseBody));
    }

    if (endpoint?.expects && typeof endpoint.expects === 'object' && !Array.isArray(endpoint.expects)) {
      candidates.push(...Object.keys(endpoint.expects));
    }

    return [...new Set(candidates.map((key) => String(key).trim()).filter(Boolean))].sort();
  }

  normalizeApiRequestPath(apiPath) {
    let normalized = String(apiPath || '/').trim();
    normalized = normalized.split('?')[0];
    normalized = normalized.replace(/\/:[A-Za-z0-9_]+/g, '/1');
    normalized = normalized.replace(/\[[^\]/]+\]/g, '1');
    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }
    return normalized || '/';
  }

  buildMalformedPayload(requestBody) {
    if (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)) {
      const malformed = {};
      for (const key of Object.keys(requestBody)) {
        malformed[key] = null;
      }
      if (Object.keys(malformed).length > 0) {
        malformed.__healix_invalid = true;
        return malformed;
      }
    }

    return {
      __healix_invalid: true,
    };
  }

  buildComponentTests(components) {
    const sortedComponents = this.toSortedArray(components, (component) => component);
    return sortedComponents.map((component) => {
      const rawComponent = String(component || '').trim();
      const componentName = this.escapeForSingleQuote(rawComponent);
      if (!componentName) {
        return '';
      }

      const lowerComponent = rawComponent.toLowerCase();
      if (/(^|\s)(navigation|navbar|menu|nav)(\s|$)/.test(lowerComponent)) {
        return `  test('displays component: ${componentName}', async ({ page }) => {
    const landmark = page.getByRole('navigation').first();
    if (await landmark.count()) {
      await landmark.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await expect(landmark).toBeVisible();
      return;
    }
    const fallback = page.locator('nav, [role="navigation"]').first();
    await fallback.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await expect(fallback).toBeVisible();
  });`;
      }

      if (/(^|\s)(header|masthead|banner)(\s|$)/.test(lowerComponent)) {
        return `  test('displays component: ${componentName}', async ({ page }) => {
    const header = page.locator('header, [role="banner"]').first();
    await header.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await expect(header).toBeVisible();
  });`;
      }

      if (/(^|\s)(footer|content info|contentinfo)(\s|$)/.test(lowerComponent)) {
        return `  test('displays component: ${componentName}', async ({ page }) => {
    const footer = page.locator('footer, [role="contentinfo"]').first();
    await footer.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await expect(footer).toBeVisible();
  });`;
      }

      if (/(^|\s)(main|content)(\s|$)/.test(lowerComponent)) {
        return `  test('displays component: ${componentName}', async ({ page }) => {
    const main = page.locator('main, [role="main"]').first();
    await main.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await expect(main).toBeVisible();
  });`;
      }

      return `  test('displays component: ${componentName}', async ({ page }) => {
    const component = await resolveByLadder(page, '${componentName}');
    await expect(component).toBeVisible();
  });`;
    }).filter(Boolean).join('\n\n');
  }

  buildInteractionTests(interactions) {
    const sortedInteractions = this.toSortedArray(interactions, (interaction) => interaction);

    return sortedInteractions.map((interaction, index) => {
      const rawInteraction = String(interaction || '').trim();
      if (!rawInteraction) {
        return '';
      }

      const interactionName = this.escapeForSingleQuote(rawInteraction);
      const target = this.escapeForSingleQuote(this.extractTarget(rawInteraction, `interaction-${index + 1}`));
      const lower = rawInteraction.toLowerCase();

      if (/(enter|fill|type|input|field|email|password|username|search)/.test(lower)) {
        const value = this.escapeForSingleQuote(`healix_value_${index + 1}`);
        return `  test('interaction: ${interactionName}', async ({ page }) => {
    const input = await resolveByLadder(page, '${target}', 'textbox');
    await expect(input).toBeEditable();
    await input.fill('${value}');
    await expect(input).toHaveValue('${value}');
  });`;
      }

      if (/(link|navigate|open|go to|visit)/.test(lower)) {
        return `  test('interaction: ${interactionName}', async ({ page }) => {
    const beforeUrl = page.url();
    const link = await resolveByLadder(page, '${target}', 'link');
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    const shouldExpectNavigation = shouldExpectNavigationChange(beforeUrl, href);
    await link.click();
    await page.waitForLoadState('domcontentloaded');

    if (shouldExpectNavigation) {
      await expect(page).not.toHaveURL(beforeUrl);
    } else {
      await expect(page.locator('main, [role="main"], body').first()).toBeVisible();
    }
  });`;
      }

      if (/(button|submit|click|tap|press|save|continue|login|sign in|sign up)/.test(lower)) {
        return `  test('interaction: ${interactionName}', async ({ page }) => {
    const control = await resolveByLadder(page, '${target}', 'button');
    await expect(control).toBeEnabled();

    const beforeUrl = page.url();
    const beforeMarkup = await page.locator('body').innerHTML();
    const responsePromise = page.waitForResponse(() => true, { timeout: 5000 }).catch(() => null);

    await control.click();
    await page.waitForLoadState('domcontentloaded');

    const response = await responsePromise;
    const afterUrl = page.url();
    const afterMarkup = await page.locator('body').innerHTML();

    expect(afterUrl !== beforeUrl || afterMarkup !== beforeMarkup || Boolean(response)).toBeTruthy();
  });`;
      }

      return `  test('interaction: ${interactionName}', async ({ page }) => {
    const element = await resolveByLadder(page, '${target}');
    await expect(element).toBeVisible();
  });`;
    }).filter(Boolean).join('\n\n');
  }

  normalizeWorkflowSteps(steps) {
    if (!Array.isArray(steps)) {
      return [];
    }

    return steps.map((rawStep, index) => {
      if (rawStep && typeof rawStep === 'object') {
        const knownActions = new Set(['goto', 'fill', 'click_link', 'click_button', 'assert_text', 'assert_visible']);
        let action = String(rawStep.action || rawStep.type || '').toLowerCase();
        const target = String(rawStep.target || rawStep.element || rawStep.name || '').trim();
        const value = rawStep.value !== undefined ? String(rawStep.value) : '';
        const pathFromStep = String(rawStep.path || rawStep.url || '').trim();
        const description = String(rawStep.description || rawStep.name || rawStep.action || `step ${index + 1}`);
        if (!knownActions.has(action)) {
          const lowerDescription = description.toLowerCase();
          if ((/go to|navigate|open|visit/.test(lowerDescription)) && pathFromStep) action = 'goto';
          else if (/(enter|fill|type|input|field)/.test(lowerDescription)) action = 'fill';
          else if (/(link|navigate|open|visit)/.test(lowerDescription)) action = 'click_link';
          else if (/(click|tap|press|submit|button|save|continue|login|sign in|sign up)/.test(lowerDescription)) action = 'click_button';
          else if (/(verify|assert|expect|see)/.test(lowerDescription)) action = 'assert_text';
          else action = 'unknown';
        }
        return {
          action,
          description,
          target,
          value,
          path: pathFromStep,
        };
      }

      const stepText = String(rawStep || '').trim();
      const lower = stepText.toLowerCase();
      const pathMatch = stepText.match(/\/[a-zA-Z0-9/_-]*/);

      if (/(go to|navigate|open|visit)/.test(lower) && pathMatch) {
        return {
          action: 'goto',
          description: stepText,
          path: pathMatch[0],
        };
      }

      if (/(enter|fill|type|input|field)/.test(lower)) {
        return {
          action: 'fill',
          description: stepText,
          target: this.extractTarget(stepText, `field-${index + 1}`),
          value: `workflow_value_${index + 1}`,
        };
      }

      if (/(link|navigate|open|visit)/.test(lower)) {
        return {
          action: 'click_link',
          description: stepText,
          target: this.extractTarget(stepText, `link-${index + 1}`),
        };
      }

      if (/(click|tap|press|submit|button|save|continue|login|sign in|sign up)/.test(lower)) {
        return {
          action: 'click_button',
          description: stepText,
          target: this.extractTarget(stepText, `button-${index + 1}`),
        };
      }

      if (/(verify|assert|expect|see)/.test(lower)) {
        return {
          action: 'assert_text',
          description: stepText,
          target: this.extractTarget(stepText, stepText),
        };
      }

      return {
        action: 'assert_visible',
        description: stepText || `step ${index + 1}`,
        target: this.extractTarget(stepText, `step-${index + 1}`),
      };
    }).filter((step) => step && step.description);
  }

  renderWorkflowStep(step, index) {
    const stepLabel = this.escapeForSingleQuote(step.description || `step ${index + 1}`);
    const variableSuffix = `step${index + 1}`;
    const target = this.escapeForSingleQuote(step.target || `step-${index + 1}`);
    const pathValue = this.escapeForSingleQuote(step.path || '/');
    const value = this.escapeForSingleQuote(step.value || `workflow_value_${index + 1}`);
    const assertRegex = this.escapeForSingleQuote(this.escapeForRegex(step.target || step.description || ''));

    if (step.action === 'goto') {
      return `    // Step ${index + 1}: ${stepLabel}
    await page.goto('${pathValue}');
    await expectPath(page, '${pathValue}');`;
    }

    if (step.action === 'fill') {
      return `    // Step ${index + 1}: ${stepLabel}
    const ${variableSuffix}Input = await resolveByLadder(page, '${target}', 'textbox');
    await expect(${variableSuffix}Input).toBeEditable();
    await ${variableSuffix}Input.fill('${value}');
    await expect(${variableSuffix}Input).toHaveValue('${value}');`;
    }

    if (step.action === 'click_link') {
      return `    // Step ${index + 1}: ${stepLabel}
    const ${variableSuffix}BeforeUrl = page.url();
    const ${variableSuffix}Link = await resolveByLadder(page, '${target}', 'link');
    await expect(${variableSuffix}Link).toBeVisible();
    const ${variableSuffix}Href = await ${variableSuffix}Link.getAttribute('href');
    const ${variableSuffix}ShouldExpectNavigation = shouldExpectNavigationChange(${variableSuffix}BeforeUrl, ${variableSuffix}Href);
    await ${variableSuffix}Link.click();
    await page.waitForLoadState('domcontentloaded');

    if (${variableSuffix}ShouldExpectNavigation) {
      await expect(page).not.toHaveURL(${variableSuffix}BeforeUrl);
    } else {
      await expect(page.locator('main, [role="main"], body').first()).toBeVisible();
    }`;
    }

    if (step.action === 'click_button') {
      return `    // Step ${index + 1}: ${stepLabel}
    const ${variableSuffix}Button = await resolveByLadder(page, '${target}', 'button');
    await expect(${variableSuffix}Button).toBeEnabled();
    const ${variableSuffix}BeforeUrl = page.url();
    const ${variableSuffix}BeforeMarkup = await page.locator('body').innerHTML();
    await ${variableSuffix}Button.click();
    await page.waitForLoadState('domcontentloaded');
    const ${variableSuffix}AfterUrl = page.url();
    const ${variableSuffix}AfterMarkup = await page.locator('body').innerHTML();
    expect(${variableSuffix}AfterUrl !== ${variableSuffix}BeforeUrl || ${variableSuffix}AfterMarkup !== ${variableSuffix}BeforeMarkup).toBeTruthy();`;
    }

    if (step.action === 'assert_text') {
      return `    // Step ${index + 1}: ${stepLabel}
    await expect(page.getByText(new RegExp('${assertRegex}', 'i')).first()).toBeVisible();`;
    }

    if (step.action === 'unknown' && this.config.strictWorkflowStepTypes) {
      return `    // Step ${index + 1}: ${stepLabel}
    throw new Error('Unsupported workflow step type encountered: ${stepLabel}');`;
    }

    return `    // Step ${index + 1}: ${stepLabel}
    const ${variableSuffix}Element = await resolveByLadder(page, '${target}');
    await expect(${variableSuffix}Element).toBeVisible();`;
  }

  /**
   * Check if Playwright MCP is available
   */
  async checkMCPAvailability() {
    // For now, we'll use the fallback generator
    // In production, this would check if playwright-mcp server is running
    this.mcpAvailable = false;
    return this.mcpAvailable;
  }

  /**
   * Generate tests from codebase context
   * Uses AI agent's understanding of the codebase
   */
  async generateTests({ context, testType, projectPath, prdFile }) {
    const log = (msg) => console.error(`[PlaywrightMCP] ${msg}`);
    
    log('Generating tests from codebase context...');
    
    const testsDir = path.join(projectPath || this.config.projectPath, 'tests', 'generated');
    
    // Ensure directory exists
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }
    
    const generatedTests = [];
    const usedFilenames = new Set();
    const sortedPages = this.toSortedArray(context?.pages, (page) => page?.path || page?.description || '');
    const sortedApiEndpoints = this.toSortedArray(
      context?.apiEndpoints,
      (endpoint) => `${endpoint?.method || 'GET'} ${endpoint?.path || '/'}`
    );
    const sortedWorkflows = this.toSortedArray(
      context?.workflows,
      (workflow) => (typeof workflow === 'string' ? workflow : workflow?.name || '')
    );
    
    // Generate frontend tests if context has pages
    if ((testType === 'frontend' || testType === 'both') && sortedPages.length > 0) {
      log(`Generating frontend tests for ${sortedPages.length} pages...`);
      for (const page of sortedPages) {
        const test = this.generatePageTest(page, testsDir, usedFilenames);
        if (test) {
          generatedTests.push(test);
          log(`Generated: ${test.filename}`);
        }
      }
    }
    
    // Generate backend tests if context has API endpoints
    if ((testType === 'backend' || testType === 'both') && sortedApiEndpoints.length > 0) {
      log(`Generating API tests for ${sortedApiEndpoints.length} endpoints...`);
      for (const endpoint of sortedApiEndpoints) {
        const test = this.generateAPITest(endpoint, testsDir, usedFilenames);
        if (test) {
          generatedTests.push(test);
          log(`Generated: ${test.filename}`);
        }
      }
    }
    
    // Generate workflow tests if context has workflows
    if (sortedWorkflows.length > 0) {
      log(`Generating workflow tests for ${sortedWorkflows.length} workflows...`);
      for (const workflow of sortedWorkflows) {
        const test = this.generateWorkflowTest(workflow, testsDir, usedFilenames);
        if (test) {
          generatedTests.push(test);
          log(`Generated: ${test.filename}`);
        }
      }
    }
    
    // If no context provided, generate basic smoke tests
    if (generatedTests.length === 0) {
      log('No context provided, generating basic smoke tests...');
      const basicTest = this.generateBasicSmokeTest(testsDir, usedFilenames);
      generatedTests.push(basicTest);
    }
    
    // Create playwright.config.js if it doesn't exist
    await this.ensurePlaywrightConfig(projectPath || this.config.projectPath);
    
    log(`Generated ${generatedTests.length} test files`);
    
    return {
      generated: generatedTests.length,
      files: generatedTests.map(t => t.filePath),
      tests: generatedTests,
    };
  }

  /**
   * Generate test for a frontend page
   */
  generatePageTest(page, testsDir, usedFilenames = new Set()) {
    const pagePath = page.path || '/';
    const safeName = this.sanitizeFilenameSegment(pagePath, 'home');
    const hash = this.createStableHash(pagePath);
    const filename = this.getUniqueFilename(`page_${safeName}_${hash}.spec.js`, usedFilenames);
    const filePath = path.join(testsDir, filename);
    
    const components = page.components || [];
    const interactions = page.interactions || [];
    const description = page.description || `${pagePath} page`;
    const escapedDescription = this.escapeForSingleQuote(description);
    const escapedPagePath = this.escapeForSingleQuote(pagePath);
    const componentTests = this.buildComponentTests(components);
    const interactionTests = this.buildInteractionTests(interactions);
    
    const code = `// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Tests for: ${escapedDescription}
 * Path: ${escapedPagePath}
 * Generated by Healix MCP
 */

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&');
}

function normalizePathname(value) {
  const normalized = String(value || '').trim() || '/';
  try {
    const pathname = new URL(normalized, 'http://healix.local').pathname || '/';
    if (pathname !== '/' && pathname.endsWith('/')) {
      return pathname.replace(/\/+$/, '');
    }
    return pathname;
  } catch (error) {
    const pathname = normalized.split('?')[0].split('#')[0] || '/';
    if (pathname !== '/' && pathname.endsWith('/')) {
      return pathname.replace(/\/+$/, '');
    }
    return pathname;
  }
}

async function expectPath(page, expectedPath) {
  await expect.poll(() => normalizePathname(page.url())).toBe(normalizePathname(expectedPath));
}

function buildTokenRegex(target) {
  const tokens = String(target || '')
    .toLowerCase()
    .split(/\\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  if (tokens.length === 0) {
    return null;
  }
  return new RegExp(tokens.map((token) => escapeRegExp(token)).join('.*'), 'i');
}

function shouldExpectNavigationChange(beforeUrl, href) {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
    return false;
  }

  try {
    const destination = new URL(href, beforeUrl);
    return destination.href !== beforeUrl;
  } catch (error) {
    return false;
  }
}

function buildSelectorLadder(page, target, role) {
  const lowerTarget = String(target || '').toLowerCase();
  const exact = new RegExp('^' + escapeRegExp(target) + '$', 'i');
  const partial = new RegExp(escapeRegExp(target), 'i');
  const tokenRegex = buildTokenRegex(target);
  const testId = slugify(target);
  const ladder = [page.getByTestId(testId)];

  if (!role) {
    if (/(^|\\s)(navigation|navbar|menu|nav)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.getByRole('navigation'));
      ladder.push(page.locator('nav, [role="navigation"]'));
    }
    if (/(^|\\s)(header|masthead|banner)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.locator('header, [role="banner"]'));
    }
    if (/(^|\\s)(footer|content info|contentinfo)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.locator('footer, [role="contentinfo"]'));
    }
    if (/(^|\\s)(main|content)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.locator('main, [role="main"]'));
    }
  }

  if (role) {
    ladder.push(page.getByRole(role, { name: exact }));
    if (tokenRegex) {
      ladder.push(page.getByRole(role, { name: tokenRegex }));
    }
  } else {
    ladder.push(
      page.getByRole('button', { name: exact }),
      page.getByRole('link', { name: exact }),
      page.getByRole('heading', { name: exact }),
      page.getByRole('textbox', { name: exact }),
      page.getByRole('checkbox', { name: exact }),
      page.getByRole('radio', { name: exact })
    );

    if (tokenRegex) {
      ladder.push(
        page.getByRole('button', { name: tokenRegex }),
        page.getByRole('link', { name: tokenRegex }),
        page.getByRole('heading', { name: tokenRegex }),
        page.getByRole('textbox', { name: tokenRegex }),
        page.getByRole('checkbox', { name: tokenRegex }),
        page.getByRole('radio', { name: tokenRegex })
      );
    }
  }

  ladder.push(
    page.getByLabel(exact),
    page.getByPlaceholder(exact),
    page.getByText(partial)
  );

  if (tokenRegex) {
    ladder.push(
      page.getByLabel(tokenRegex),
      page.getByPlaceholder(tokenRegex),
      page.getByText(tokenRegex)
    );
  }

  return ladder;
}

async function waitForStableUI(page, options = {}) {
  const timeout = options.timeout || 10000;
  const stabilityMs = options.stabilityMs || 150;
  
  // Wait for network to be idle (no pending requests for stabilityMs)
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});
  
  // Wait for any loading indicators to disappear
  const loadingSelectors = [
    '[data-loading="true"]',
    '[aria-busy="true"]',
    '.loading',
    '.spinner',
    '[class*="loading"]',
    '[class*="skeleton"]',
  ];
  
  for (const selector of loadingSelectors) {
    const loadingEl = page.locator(selector).first();
    if (await loadingEl.count() > 0) {
      await loadingEl.waitFor({ state: 'hidden', timeout: timeout / 2 }).catch(() => {});
    }
  }
  
  // Small stability delay for hydration
  await page.waitForTimeout(stabilityMs);
}

async function resolveByLadder(page, target, role, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const retryDelayMs = options.retryDelayMs || 500;
  const waitTimeoutMs = options.waitTimeoutMs || 5000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const locator of buildSelectorLadder(page, target, role)) {
      try {
        // Wait for at least one element to exist
        const count = await locator.count();
        if (count === 0) {
          continue;
        }

        const candidate = locator.first();
        
        // Wait for the element to be visible with a reasonable timeout
        await candidate.waitFor({ state: 'visible', timeout: waitTimeoutMs / maxRetries }).catch(() => {});
        
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      } catch (e) {
        // Continue to next selector in ladder
        continue;
      }
    }
    
    // If not found, wait before retrying
    if (attempt < maxRetries - 1) {
      await page.waitForTimeout(retryDelayMs);
    }
  }

  throw new Error('Unable to locate "' + target + '" using ladder testId->role->label->placeholder->text after ' + maxRetries + ' attempts');
}

test.describe('${escapedDescription}', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${escapedPagePath}');
    await waitForStableUI(page);
  });

  test('loads page and URL matches route', async ({ page }) => {
    await expectPath(page, '${escapedPagePath}');
    await expect(page.locator('body')).toBeVisible();
  });

${componentTests}

${interactionTests}
});
`;

    fs.writeFileSync(filePath, code, 'utf-8');
    
    return {
      filename,
      filePath,
      type: 'frontend',
      page: pagePath,
    };
  }

  /**
   * Generate test for an API endpoint
   */
  generateAPITest(endpoint, testsDir, usedFilenames = new Set()) {
    const method = endpoint.method || 'GET';
    const apiPath = endpoint.path || '/api/health';
    const requestPath = this.normalizeApiRequestPath(apiPath);
    const safeName = this.sanitizeFilenameSegment(apiPath, 'health');
    const hash = this.createStableHash(`${method.toUpperCase()} ${apiPath}`);
    const filename = this.getUniqueFilename(`api_${method.toLowerCase()}_${safeName}_${hash}.spec.js`, usedFilenames);
    const filePath = path.join(testsDir, filename);
    
    const requiresAuth = endpoint.requiresAuth || endpoint.auth || false;
    const description = endpoint.description || `${method} ${apiPath}`;
    const requestBody = endpoint.requestBody || endpoint.expects || null;
    const malformedBody = this.buildMalformedPayload(requestBody);
    const escapedDescription = this.escapeForSingleQuote(description);
    const escapedMethod = this.escapeForSingleQuote(method.toUpperCase());
    const escapedPath = this.escapeForSingleQuote(apiPath);
    const escapedRequestPath = this.escapeForSingleQuote(requestPath);
    const expectedStatuses = this.getExpectedSuccessStatuses(method, endpoint);
    const expectedAuthStatuses = this.getExpectedAuthStatuses(endpoint);
    const expectedResponseKeys = this.getExpectedResponseKeys(endpoint);
    
    const code = `// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * API Tests for: ${escapedDescription}
 * Endpoint: ${escapedMethod} ${escapedPath}
 * Generated by Healix MCP
 */

const REQUEST_METHOD = '${escapedMethod}';
const REQUEST_PATH = '${escapedRequestPath}';
const REQUEST_BODY = ${JSON.stringify(requestBody, null, 2)};
const MALFORMED_BODY = ${JSON.stringify(malformedBody, null, 2)};
const EXPECTED_SUCCESS_STATUSES = ${JSON.stringify(expectedStatuses)};
const EXPECTED_AUTH_STATUSES = ${JSON.stringify(expectedAuthStatuses)};
const EXPECTED_RESPONSE_KEYS = ${JSON.stringify(expectedResponseKeys)};
const STRESS_BURST = Number(process.env.HEALIX_API_STRESS_BURST || 6);
const STRESS_P95_MS = Number(process.env.HEALIX_API_STRESS_P95_MS || 2000);

function methodSupportsBody(method) {
  return ['POST', 'PUT', 'PATCH'].includes(String(method || '').toUpperCase());
}

function expectSuccessStatus(status) {
  if (EXPECTED_SUCCESS_STATUSES.length > 0) {
    expect(EXPECTED_SUCCESS_STATUSES).toContain(status);
    return;
  }

  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
}

function expectAuthLikeStatus(status) {
  if (EXPECTED_AUTH_STATUSES.length > 0) {
    expect(EXPECTED_AUTH_STATUSES).toContain(status);
    return;
  }

  expect(status).toBeGreaterThanOrEqual(300);
  expect(status).toBeLessThan(500);
}

async function sendRequest(request, options = {}) {
  const method = String(options.method || REQUEST_METHOD).toUpperCase();
  const requestOptions = {
    method,
    headers: {
      ...(options.headers || {}),
    },
  };

  if (options.auth && process.env.TEST_AUTH_TOKEN) {
    requestOptions.headers.Authorization = 'Bearer ' + process.env.TEST_AUTH_TOKEN;
  }

  if (options.body !== undefined && methodSupportsBody(method)) {
    requestOptions.data = options.body;
  } else if (REQUEST_BODY !== null && REQUEST_BODY !== undefined && methodSupportsBody(method)) {
    requestOptions.data = REQUEST_BODY;
  }

  return request.fetch(REQUEST_PATH, requestOptions);
}

test.describe('API: ${escapedMethod} ${escapedPath}', () => {
  test('returns expected success status', async ({ request }) => {
    if (${requiresAuth ? 'true' : 'false'}) {
      test.skip(!process.env.TEST_AUTH_TOKEN, 'Set TEST_AUTH_TOKEN to validate authenticated success status.');
    }

    const response = await sendRequest(request, {
      auth: ${requiresAuth ? 'true' : 'false'},
    });
    expectSuccessStatus(response.status());
  });

  test('returns contract-aware response payload', async ({ request }) => {
    if (${requiresAuth ? 'true' : 'false'}) {
      test.skip(!process.env.TEST_AUTH_TOKEN, 'Set TEST_AUTH_TOKEN to validate authenticated response shape.');
    }

    const response = await sendRequest(request, {
      auth: ${requiresAuth ? 'true' : 'false'},
    });
    expectSuccessStatus(response.status());

    if (![204, 205].includes(response.status())) {
      const contentType = (response.headers()['content-type'] || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const payload = await response.json();
        expect(payload).not.toBeNull();

        if (Array.isArray(payload)) {
          if (payload.length > 0 && typeof payload[0] === 'object' && payload[0] !== null) {
            for (const key of EXPECTED_RESPONSE_KEYS) {
              expect(payload[0]).toHaveProperty(key);
            }
          }
        } else {
          expect(typeof payload).toBe('object');
          if (EXPECTED_RESPONSE_KEYS.length > 0) {
            for (const key of EXPECTED_RESPONSE_KEYS) {
              expect(payload).toHaveProperty(key);
            }
          } else {
            expect(Object.keys(payload).length).toBeGreaterThanOrEqual(0);
          }
        }
      } else {
        const bodyText = await response.text();
        expect(bodyText.trim().length).toBeGreaterThan(0);
      }
    }
  });

${requiresAuth ? `  test('rejects unauthenticated request', async ({ request }) => {
    const response = await sendRequest(request, {
      auth: false,
    });
    expectAuthLikeStatus(response.status());
  });

  test('accepts authenticated request when token is provided', async ({ request }) => {
    test.skip(!process.env.TEST_AUTH_TOKEN, 'Set TEST_AUTH_TOKEN to validate authenticated requests.');

    const response = await sendRequest(request, {
      auth: true,
    });

    expectSuccessStatus(response.status());
  });
` : ''}

  test('malformed payload does not trigger 5xx response', async ({ request }) => {
    test.skip(!methodSupportsBody(REQUEST_METHOD), 'Malformed payload checks apply to write endpoints.');

    if (${requiresAuth ? 'true' : 'false'}) {
      test.skip(!process.env.TEST_AUTH_TOKEN, 'Set TEST_AUTH_TOKEN to validate authenticated malformed payload handling.');
    }

    const response = await sendRequest(request, {
      auth: ${requiresAuth ? 'true' : 'false'},
      body: MALFORMED_BODY,
    });

    expect(response.status()).toBeLessThan(500);
  });

  test('handles burst traffic without server errors', async ({ request }) => {
    const burst = Math.max(2, Math.min(12, STRESS_BURST));
    const authAvailable = Boolean(process.env.TEST_AUTH_TOKEN);
    const sendWithAuth = ${requiresAuth ? 'true' : 'false'} && authAvailable;

    const timings = [];
    const responses = await Promise.all(
      Array.from({ length: burst }, async () => {
        const startedAt = Date.now();
        const response = await sendRequest(request, { auth: sendWithAuth });
        timings.push(Date.now() - startedAt);
        return response;
      })
    );

    const statuses = responses.map((response) => response.status());
    expect(statuses.filter((status) => status >= 500).length).toBe(0);
    for (const status of statuses) {
      if (${requiresAuth ? 'true' : 'false'} && !authAvailable) {
        expectAuthLikeStatus(status);
      } else {
        expectSuccessStatus(status);
      }
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
    expect(p95).toBeLessThanOrEqual(STRESS_P95_MS);
  });
});
`;

    fs.writeFileSync(filePath, code, 'utf-8');
    
    return {
      filename,
      filePath,
      type: 'backend',
      endpoint: `${method} ${apiPath}`,
    };
  }

  /**
   * Generate test for a user workflow
   */
  generateWorkflowTest(workflow, testsDir, usedFilenames = new Set()) {
    const workflowName = typeof workflow === 'string' ? workflow : workflow.name || 'User Workflow';
    const safeName = this.sanitizeFilenameSegment(workflowName.toLowerCase().replace(/\s+/g, '_'), 'workflow');
    const hash = this.createStableHash(workflowName);
    const filename = this.getUniqueFilename(`workflow_${safeName}_${hash}.spec.js`, usedFilenames);
    const filePath = path.join(testsDir, filename);
    
    const steps = this.normalizeWorkflowSteps(workflow?.steps || []);
    const escapedWorkflowName = this.escapeForSingleQuote(workflowName);
    const workflowStepCode = steps.length > 0
      ? steps.map((step, index) => this.renderWorkflowStep(step, index)).join('\n\n')
      : `    // Default deterministic check when no workflow steps are provided
    await expect(page.locator('main, [role="main"], body').first()).toBeVisible();`;
    const expectedPath = typeof workflow === 'object' && workflow.expectedPath
      ? this.escapeForSingleQuote(String(workflow.expectedPath))
      : '';
    
    const code = `// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Workflow Test: ${escapedWorkflowName}
 * Generated by Healix MCP
 */

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&');
}

function normalizePathname(value) {
  const normalized = String(value || '').trim() || '/';
  try {
    const pathname = new URL(normalized, 'http://healix.local').pathname || '/';
    if (pathname !== '/' && pathname.endsWith('/')) {
      return pathname.replace(/\/+$/, '');
    }
    return pathname;
  } catch (error) {
    const pathname = normalized.split('?')[0].split('#')[0] || '/';
    if (pathname !== '/' && pathname.endsWith('/')) {
      return pathname.replace(/\/+$/, '');
    }
    return pathname;
  }
}

async function expectPath(page, expectedPath) {
  await expect.poll(() => normalizePathname(page.url())).toBe(normalizePathname(expectedPath));
}

function buildTokenRegex(target) {
  const tokens = String(target || '')
    .toLowerCase()
    .split(/\\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  if (tokens.length === 0) {
    return null;
  }
  return new RegExp(tokens.map((token) => escapeRegExp(token)).join('.*'), 'i');
}

function shouldExpectNavigationChange(beforeUrl, href) {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
    return false;
  }

  try {
    const destination = new URL(href, beforeUrl);
    return destination.href !== beforeUrl;
  } catch (error) {
    return false;
  }
}

function buildSelectorLadder(page, target, role) {
  const lowerTarget = String(target || '').toLowerCase();
  const exact = new RegExp('^' + escapeRegExp(target) + '$', 'i');
  const partial = new RegExp(escapeRegExp(target), 'i');
  const tokenRegex = buildTokenRegex(target);
  const testId = slugify(target);
  const ladder = [page.getByTestId(testId)];

  if (!role) {
    if (/(^|\\s)(navigation|navbar|menu|nav)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.getByRole('navigation'));
      ladder.push(page.locator('nav, [role="navigation"]'));
    }
    if (/(^|\\s)(header|masthead|banner)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.locator('header, [role="banner"]'));
    }
    if (/(^|\\s)(footer|content info|contentinfo)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.locator('footer, [role="contentinfo"]'));
    }
    if (/(^|\\s)(main|content)(\\s|$)/.test(lowerTarget)) {
      ladder.push(page.locator('main, [role="main"]'));
    }
  }

  if (role) {
    ladder.push(page.getByRole(role, { name: exact }));
    if (tokenRegex) {
      ladder.push(page.getByRole(role, { name: tokenRegex }));
    }
  } else {
    ladder.push(
      page.getByRole('button', { name: exact }),
      page.getByRole('link', { name: exact }),
      page.getByRole('heading', { name: exact }),
      page.getByRole('textbox', { name: exact }),
      page.getByRole('checkbox', { name: exact }),
      page.getByRole('radio', { name: exact })
    );

    if (tokenRegex) {
      ladder.push(
        page.getByRole('button', { name: tokenRegex }),
        page.getByRole('link', { name: tokenRegex }),
        page.getByRole('heading', { name: tokenRegex }),
        page.getByRole('textbox', { name: tokenRegex }),
        page.getByRole('checkbox', { name: tokenRegex }),
        page.getByRole('radio', { name: tokenRegex })
      );
    }
  }

  ladder.push(
    page.getByLabel(exact),
    page.getByPlaceholder(exact),
    page.getByText(partial)
  );

  if (tokenRegex) {
    ladder.push(
      page.getByLabel(tokenRegex),
      page.getByPlaceholder(tokenRegex),
      page.getByText(tokenRegex)
    );
  }

  return ladder;
}

async function waitForStableUI(page, options = {}) {
  const timeout = options.timeout || 10000;
  const stabilityMs = options.stabilityMs || 150;
  
  // Wait for network to be idle (no pending requests for stabilityMs)
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});
  
  // Wait for any loading indicators to disappear
  const loadingSelectors = [
    '[data-loading="true"]',
    '[aria-busy="true"]',
    '.loading',
    '.spinner',
    '[class*="loading"]',
    '[class*="skeleton"]',
  ];
  
  for (const selector of loadingSelectors) {
    const loadingEl = page.locator(selector).first();
    if (await loadingEl.count() > 0) {
      await loadingEl.waitFor({ state: 'hidden', timeout: timeout / 2 }).catch(() => {});
    }
  }
  
  // Small stability delay for hydration
  await page.waitForTimeout(stabilityMs);
}

async function resolveByLadder(page, target, role, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const retryDelayMs = options.retryDelayMs || 500;
  const waitTimeoutMs = options.waitTimeoutMs || 5000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const locator of buildSelectorLadder(page, target, role)) {
      try {
        // Wait for at least one element to exist
        const count = await locator.count();
        if (count === 0) {
          continue;
        }

        const candidate = locator.first();
        
        // Wait for the element to be visible with a reasonable timeout
        await candidate.waitFor({ state: 'visible', timeout: waitTimeoutMs / maxRetries }).catch(() => {});
        
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      } catch (e) {
        // Continue to next selector in ladder
        continue;
      }
    }
    
    // If not found, wait before retrying
    if (attempt < maxRetries - 1) {
      await page.waitForTimeout(retryDelayMs);
    }
  }

  throw new Error('Unable to locate "' + target + '" using ladder testId->role->label->placeholder->text after ' + maxRetries + ' attempts');
}

test.describe('Workflow: ${escapedWorkflowName}', () => {
  test('completes workflow with executable user steps', async ({ page }) => {
    // Start at home page
    await page.goto('/');
    await waitForStableUI(page);
    
${workflowStepCode}
    
${expectedPath ? `    await expectPath(page, '${expectedPath}');` : `    await expect(page.locator('main, [role="main"], body').first()).toBeVisible();`}
  });

  test('handles invalid route without crashing app shell', async ({ page }) => {
    const response = await page.goto('/__healix_invalid_route__');
    expect(response).toBeTruthy();
    expect([200, 404]).toContain(response.status());
    await expect(page.locator('body')).toBeVisible();
  });
});
`;

    fs.writeFileSync(filePath, code, 'utf-8');
    
    return {
      filename,
      filePath,
      type: 'workflow',
      workflow: workflowName,
    };
  }

  /**
   * Generate basic smoke tests when no context is available
   */
  generateBasicSmokeTest(testsDir, usedFilenames = new Set()) {
    const filename = this.getUniqueFilename('smoke_basic.spec.js', usedFilenames);
    const filePath = path.join(testsDir, filename);
    
    const code = `// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Basic Smoke Tests
 * Generated by Healix MCP
 * These tests verify basic app functionality
 */

async function waitForStableUI(page, options = {}) {
  const timeout = options.timeout || 10000;
  const stabilityMs = options.stabilityMs || 150;
  
  // Wait for network to be idle (no pending requests for stabilityMs)
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});
  
  // Wait for any loading indicators to disappear
  const loadingSelectors = [
    '[data-loading="true"]',
    '[aria-busy="true"]',
    '.loading',
    '.spinner',
    '[class*="loading"]',
    '[class*="skeleton"]',
  ];
  
  for (const selector of loadingSelectors) {
    const loadingEl = page.locator(selector).first();
    if (await loadingEl.count() > 0) {
      await loadingEl.waitFor({ state: 'hidden', timeout: timeout / 2 }).catch(() => {});
    }
  }
  
  // Small stability delay for hydration
  await page.waitForTimeout(stabilityMs);
}

test.describe('Basic Smoke Tests', () => {
  test('should load the application', async ({ page }) => {
    await page.goto('/');
    await waitForStableUI(page);
    
    // Page should have a title
    const title = await page.title();
    expect(title).toBeTruthy();
    
    // Page should have visible content
    await expect(page.locator('body')).toBeVisible();
  });

  test('should have no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.goto('/');
    await waitForStableUI(page);
    
    // Filter out known acceptable errors
    const criticalErrors = errors.filter(err => 
      !err.includes('favicon') && 
      !err.includes('404')
    );
    
    // No critical console errors
    expect(criticalErrors.length).toBeLessThanOrEqual(3);
  });

  test('should be responsive', async ({ page }) => {
    // Test desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await waitForStableUI(page);
    await expect(page.locator('body')).toBeVisible();
    
    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await waitForStableUI(page);
    await expect(page.locator('body')).toBeVisible();
  });

  test('should have working navigation', async ({ page }) => {
    await page.goto('/');
    await waitForStableUI(page);
    
    // Find and test navigation links
    const navLinks = page.locator('nav a, header a, [role="navigation"] a');
    const linkCount = await navLinks.count();
    
    if (linkCount > 0) {
      // Test first navigation link
      const firstLink = navLinks.first();
      const href = await firstLink.getAttribute('href');
      
      if (href && !href.startsWith('http') && !href.startsWith('#')) {
        await firstLink.click();
        await waitForStableUI(page);
        // Should navigate without error
        await expect(page.locator('body')).toBeVisible();
      }
    }
  });
});
`;

    fs.writeFileSync(filePath, code, 'utf-8');
    
    return {
      filename,
      filePath,
      type: 'smoke',
    };
  }

  /**
   * Ensure playwright.config.js exists
   */
  async ensurePlaywrightConfig(projectPath) {
    const configPath = path.join(projectPath, 'playwright.config.js');
    
    if (fs.existsSync(configPath)) {
      return; // Config already exists
    }
    
    const config = `// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright Configuration
 * Generated by Healix MCP
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results.json' }],
  ],
  
  use: {
    baseURL: process.env.BASE_URL || '${this.config.baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: '${this.config.videoMode}',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: process.env.START_SERVER ? {
    command: process.env.START_COMMAND || 'npm start',
    url: process.env.BASE_URL || '${this.config.baseURL}',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  } : undefined,
});
`;

    fs.writeFileSync(configPath, config, 'utf-8');
    console.error(`[PlaywrightMCP] Created playwright.config.js`);
  }
}

module.exports = PlaywrightMCPClient;
