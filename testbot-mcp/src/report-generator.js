/**
 * Report Generator
 * Generates test reports in JSON format for the dashboard
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logger = require('./logger');

class ReportGenerator {
  stripAnsiAndNormalize(value) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return value
        .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.stripAnsiAndNormalize(item));
    }

    if (typeof value === 'object') {
      const normalized = {};
      for (const [key, innerValue] of Object.entries(value)) {
        normalized[key] = this.stripAnsiAndNormalize(innerValue);
      }
      return normalized;
    }

    return value;
  }

  normalizePathForReport(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
  }

  normalizeStatus(status) {
    if (!status) return 'unknown';
    const normalized = String(status).toLowerCase();
    if (normalized === 'expected') return 'passed';
    if (normalized === 'unexpected') return 'failed';
    if (normalized === 'pending') return 'skipped';
    return normalized;
  }

  ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  sanitizeArtifactName(name) {
    return String(name || 'artifact')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 180) || 'artifact';
  }

  createArtifactFilename(type, sourcePath, artifactName) {
    const digest = crypto.createHash('sha1').update(sourcePath).digest('hex').slice(0, 12);
    const ext = path.extname(sourcePath) || path.extname(artifactName) || '';
    const base = this.sanitizeArtifactName(path.basename(artifactName || sourcePath, ext));
    return `${type}-${digest}-${base}${ext}`;
  }

  resolveArtifactSourcePath(sourcePath, projectPath, reportsDir) {
    if (!sourcePath) {
      return null;
    }

    const reportRoot = path.resolve(reportsDir);
    const projectRoot = path.resolve(projectPath);
    const allowlistedRoots = [
      projectRoot,
      path.resolve(projectPath, 'test-results'),
      path.resolve(projectPath, 'playwright-mcp-output'),
      path.resolve(projectPath, 'tests'),
      reportRoot,
    ];

    let candidate = String(sourcePath);
    if (!path.isAbsolute(candidate)) {
      const projectRelative = path.resolve(projectPath, candidate);
      const reportRelative = path.resolve(reportsDir, candidate);
      candidate = fs.existsSync(projectRelative) ? projectRelative : reportRelative;
    }

    const resolved = path.resolve(candidate);
    const inAllowedRoot = allowlistedRoots.some((root) =>
      resolved === root || resolved.startsWith(`${root}${path.sep}`)
    );

    if (!inAllowedRoot) {
      return null;
    }

    return resolved;
  }

  isArtifactTypeAllowed(type, sourcePath) {
    const ext = path.extname(sourcePath).toLowerCase();
    const allowed = {
      screenshots: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
      videos: new Set(['.webm', '.mp4', '.mov', '.mkv']),
      traces: new Set(['.zip', '.trace']),
      other: new Set(['.txt', '.log', '.json', '.har', '.html', '.md']),
    };

    if (!allowed[type]) {
      return false;
    }

    if (allowed[type].has(ext)) {
      return true;
    }

    if (type === 'traces' && sourcePath.toLowerCase().includes('trace')) {
      return true;
    }

    return false;
  }

  copySingleArtifact({ artifact, type, artifactsDir, reportsDir, projectPath, copiedMap, maxBytes }) {
    const sourcePath = artifact.fullPath || artifact.path;
    const resolvedSource = this.resolveArtifactSourcePath(sourcePath, projectPath, reportsDir);

    if (!resolvedSource || !fs.existsSync(resolvedSource)) {
      return null;
    }

    if (!this.isArtifactTypeAllowed(type, resolvedSource)) {
      return null;
    }

    const stats = fs.statSync(resolvedSource);
    if (stats.size > maxBytes) {
      Logger.warn('ReportGenerator', 'Skipping oversized artifact', {
        type,
        file: resolvedSource,
        size: stats.size,
      });
      return null;
    }

    if (copiedMap.has(resolvedSource)) {
      return copiedMap.get(resolvedSource);
    }

    const destDir = path.join(artifactsDir, type);
    this.ensureDir(destDir);

    const filename = this.createArtifactFilename(type, resolvedSource, artifact.name);
    const destination = path.join(destDir, filename);

    const resolvedDest = path.resolve(destination);
    if (!resolvedDest.startsWith(`${path.resolve(artifactsDir)}${path.sep}`)) {
      return null;
    }

    fs.copyFileSync(resolvedSource, resolvedDest);

    const normalized = {
      name: this.stripAnsiAndNormalize(artifact.name || path.basename(resolvedSource)),
      contentType: this.stripAnsiAndNormalize(artifact.contentType || null),
      path: this.normalizePathForReport(path.relative(reportsDir, resolvedDest)),
      fullPath: resolvedDest,
      size: stats.size,
    };

    copiedMap.set(resolvedSource, normalized);
    return normalized;
  }

  normalizeArtifactCollections(collection, context) {
    const normalized = {
      screenshots: [],
      videos: [],
      traces: [],
      other: [],
    };

    for (const type of Object.keys(normalized)) {
      const artifacts = Array.isArray(collection?.[type]) ? collection[type] : [];
      for (const artifact of artifacts) {
        const copied = this.copySingleArtifact({
          artifact: this.stripAnsiAndNormalize(artifact),
          type,
          ...context,
        });

        if (copied) {
          normalized[type].push(copied);
        }
      }
    }

    return normalized;
  }

  async copyArtifacts(testResults, reportsDir, projectPath) {
    const artifactsDir = path.join(reportsDir, 'artifacts');
    this.ensureDir(artifactsDir);

    const copiedMap = new Map();
    const maxBytes = Number(process.env.HEALIX_MAX_ARTIFACT_BYTES || 50 * 1024 * 1024);
    const context = {
      artifactsDir,
      reportsDir,
      projectPath,
      copiedMap,
      maxBytes,
    };

    for (const test of testResults.tests || []) {
      test.artifacts = this.normalizeArtifactCollections(test.artifacts, context);
    }

    for (const failure of testResults.failures || []) {
      failure.artifacts = this.normalizeArtifactCollections(failure.artifacts, context);
    }

    if (testResults.artifacts) {
      testResults.artifacts = this.normalizeArtifactCollections(testResults.artifacts, context);
    }

    return copiedMap.size;
  }

  copyDirectoryRecursive(source, dest) {
    this.ensureDir(dest);
    const items = fs.readdirSync(source);

    for (const item of items) {
      const sourcePath = path.join(source, item);
      const destPath = path.join(dest, item);
      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        this.copyDirectoryRecursive(sourcePath, destPath);
      } else {
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  }

  async copyPlaywrightHTMLReport(projectPath, reportsDir) {
    try {
      const possibleLocations = [
        path.join(projectPath, 'healix-reports', 'html-report'),
        path.join(projectPath, 'healix-report'),
        path.join(projectPath, 'playwright-report'),
        path.join(projectPath, 'test-results', 'playwright-report'),
      ];

      const sourceReportDir = possibleLocations.find((location) =>
        fs.existsSync(path.join(location, 'index.html'))
      );

      if (!sourceReportDir) {
        return;
      }

      const destReportDir = path.join(reportsDir, 'html-report');

      if (path.resolve(sourceReportDir) === path.resolve(destReportDir)) {
        return;
      }

      if (fs.existsSync(destReportDir)) {
        fs.rmSync(destReportDir, { recursive: true, force: true });
      }

      this.copyDirectoryRecursive(sourceReportDir, destReportDir);
    } catch (error) {
      Logger.warn('ReportGenerator', 'Failed to copy Playwright HTML report', { reason: error.message });
    }
  }

  buildTestsList(testResults, aiAnalysis, jiraData) {
    const tests = testResults.tests || [];

    return tests.map((test) => {
      let errorStr = null;
      let errorDetail = null;

      if (test.error) {
        if (typeof test.error === 'string') {
          errorStr = this.stripAnsiAndNormalize(test.error);
        } else if (typeof test.error === 'object') {
          const callLog = Array.isArray(test.error.callLog)
            ? test.error.callLog
              .map((entry) => this.stripAnsiAndNormalize(entry))
              .filter(Boolean)
              .slice(0, 25)
            : null;

          const message = this.stripAnsiAndNormalize(
            test.error.message || test.error.value || test.error.stack || JSON.stringify(test.error)
          );
          const stack = this.stripAnsiAndNormalize(test.error.stack || null);
          const snippet = this.stripAnsiAndNormalize(test.error.snippet || null);
          const value = this.stripAnsiAndNormalize(test.error.value || null);
          const callLogText = callLog?.length ? `\nCall log:\n${callLog.join('\n')}` : '';

          errorStr = this.stripAnsiAndNormalize([message, stack, value].filter(Boolean).join('\n\n') + callLogText);
          errorDetail = {
            message,
            stack,
            snippet,
            value,
            callLog,
            location: this.stripAnsiAndNormalize(test.error.location || null),
          };
        }
      }

      const normalizedTest = {
        id: this.stripAnsiAndNormalize(test.id || `${test.file}-${test.title}`),
        title: this.stripAnsiAndNormalize(test.title || 'Unnamed test'),
        suite: this.stripAnsiAndNormalize(test.suite || ''),
        file: this.normalizePathForReport(this.stripAnsiAndNormalize(test.file || '')),
        status: this.normalizeStatus(test.status),
        duration: Number(test.duration || 0),
        error: errorStr,
        errorDetail,
        retries: Number(test.retries || 0),
        attachments: {
          screenshots: test.artifacts?.screenshots || [],
          videos: test.artifacts?.videos || [],
          traces: test.artifacts?.traces || [],
          other: test.artifacts?.other || [],
        },
      };

      if (aiAnalysis) {
        const analysis = aiAnalysis.find(
          (item) => item.testName === test.title || item.failure?.testName === test.title
        );

        if (analysis) {
          normalizedTest.aiAnalysis = {
            analysis: this.stripAnsiAndNormalize(analysis.analysis),
            rootCause: this.stripAnsiAndNormalize(analysis.rootCause),
            suggestedFix: this.stripAnsiAndNormalize(analysis.suggestedFix),
            confidence: analysis.confidence,
            affectedFiles: this.stripAnsiAndNormalize(analysis.affectedFiles),
            testingRecommendations: this.stripAnsiAndNormalize(analysis.testingRecommendations),
            aiProvider: 'healix',
            model: analysis.model || 'healix-ai',
          };
        }
      }

      if (jiraData) {
        const jiraMatch = test.file?.match(/([a-z]+)[_-]?(\d+)/i);
        if (jiraMatch) {
          const storyKey = `${jiraMatch[1].toUpperCase()}-${jiraMatch[2]}`;
          const story = jiraData.find((item) => item.key === storyKey);
          if (story) {
            normalizedTest.jiraStory = {
              key: this.stripAnsiAndNormalize(story.key),
              summary: this.stripAnsiAndNormalize(story.summary),
              status: this.stripAnsiAndNormalize(story.status),
              priority: this.stripAnsiAndNormalize(story.priority),
            };
          }
        }
      }

      return normalizedTest;
    });
  }

  buildAISummary(aiAnalysis) {
    const total = aiAnalysis.length;
    const highConfidence = aiAnalysis.filter((item) => item.confidence >= 0.8).length;
    const mediumConfidence = aiAnalysis.filter((item) => item.confidence >= 0.5 && item.confidence < 0.8).length;
    const lowConfidence = aiAnalysis.filter((item) => item.confidence < 0.5).length;

    return {
      total,
      highConfidence,
      mediumConfidence,
      lowConfidence,
      analyses: aiAnalysis.map((item) => ({
        testName: this.stripAnsiAndNormalize(item.testName || item.failure?.testName),
        test: this.stripAnsiAndNormalize(item.testName || item.failure?.testName),
        test_name: this.stripAnsiAndNormalize(item.testName || item.failure?.testName),
        file: this.normalizePathForReport(this.stripAnsiAndNormalize(item.file || item.failure?.file || '')),
        analysis: this.stripAnsiAndNormalize(item.analysis),
        rootCause: this.stripAnsiAndNormalize(item.rootCause || item.root_cause || null),
        root_cause: this.stripAnsiAndNormalize(item.rootCause || item.root_cause || null),
        suggestedFix: this.stripAnsiAndNormalize(item.suggestedFix || item.suggested_fix || null),
        suggested_fix: this.stripAnsiAndNormalize(item.suggestedFix || item.suggested_fix || null),
        affectedFiles: this.stripAnsiAndNormalize(item.affectedFiles || null),
        testingRecommendations: this.stripAnsiAndNormalize(item.testingRecommendations || null),
        error: this.stripAnsiAndNormalize(item.error || null),
        confidence: item.confidence,
      })),
    };
  }

  buildJiraSummary(jiraData) {
    return {
      total: jiraData.length,
      stories: jiraData.map((story) => ({
        key: this.stripAnsiAndNormalize(story.key),
        summary: this.stripAnsiAndNormalize(story.summary),
        status: this.stripAnsiAndNormalize(story.status),
        acceptanceCriteria: story.acceptanceCriteria?.length || 0,
      })),
    };
  }

  /**
   * Generate a test report
   */
  async generate({
    projectPath,
    projectName,
    runId,
    testResults,
    aiAnalysis,
    jiraData,
    generationMeta,
    generationQuality,
    requirementsCoverage,
    phaseResults,
    tierResults,
    pipelineError,
    fallbackUsed,
    failures,
    flakyCount,
    classifierVerdicts,
    failureClusters,
    api_key,
    dashboard_url,
  }) {
    const timestamp = new Date().toISOString();
    const reportsDir = path.join(projectPath, 'healix-reports');
    this.ensureDir(reportsDir);

    if (!testResults) {
      testResults = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        tests: [],
        failures: [],
      };
    }

    if (!Array.isArray(testResults.tests)) {
      testResults.tests = [];
    }
    if (!Array.isArray(testResults.failures)) {
      testResults.failures = [];
    }

    await this.copyArtifacts(testResults, reportsDir, projectPath);
    await this.copyPlaywrightHTMLReport(projectPath, reportsDir);

    const report = {
      metadata: {
        timestamp,
        projectName: this.stripAnsiAndNormalize(projectName || path.basename(projectPath)),
        projectPath: this.normalizePathForReport(projectPath),
        version: '1.0.0',
        generator: 'healix-mcp',
        runId: this.stripAnsiAndNormalize(runId || null),
        generationMeta: generationMeta || null,
        videoValidation: this.stripAnsiAndNormalize(testResults.videoValidation || null),
        fallbackUsed: Boolean(fallbackUsed),
      },
      stats: {
        total: Number(testResults.total || 0),
        passed: Number(testResults.passed || 0),
        failed: Number(testResults.failed || 0),
        skipped: Number(testResults.skipped || 0),
        flaky: Number(flakyCount ?? testResults.flaky ?? 0),
        duration: Number(testResults.duration || 0),
        passRate: testResults.total > 0
          ? Math.round((testResults.passed / testResults.total) * 100)
          : 0,
      },
      tests: this.buildTestsList(testResults, aiAnalysis, jiraData),
      aiSummary: aiAnalysis ? this.buildAISummary(aiAnalysis) : null,
      jiraSummary: jiraData ? this.buildJiraSummary(jiraData) : null,
      generationQuality: this.stripAnsiAndNormalize(generationQuality || null),
      requirementsCoverage: this.stripAnsiAndNormalize(requirementsCoverage || null),
      phaseResults: this.stripAnsiAndNormalize(phaseResults || testResults.phaseResults || null),
      tierResults: tierResults || testResults.tierResults || null,
      pipelineError: pipelineError ? this.stripAnsiAndNormalize(pipelineError) : null,
      failures: Array.isArray(failures) ? failures : [],
      classifierVerdicts: Array.isArray(classifierVerdicts) ? classifierVerdicts : [],
      failureClusters: Array.isArray(failureClusters) ? failureClusters : [],
    };

    const reportFilename = `report-${timestamp.replace(/[:.]/g, '-')}.json`;
    const reportPath = path.join(reportsDir, reportFilename);
    const latestPath = path.join(reportsDir, 'latest.json');

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf-8');

    let dashboardLink = `file://${reportPath}`;
    if (api_key && dashboard_url) {
      try {
        const fetchFn = global.fetch || require('node-fetch');
        const response = await fetchFn(`${dashboard_url}/api/test-runs/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_key,
            creation_name: projectName || path.basename(projectPath),
            run_id: runId || null,
            report,
            project_path: projectPath,
            tier_results: report.tierResults || null,
            pipeline_error: report.pipelineError || null,
            failures: report.failures || [],
            flaky_count: report.stats.flaky || 0,
            classifier_verdicts: report.classifierVerdicts || [],
            failure_clusters: report.failureClusters || [],
          }),
        });

        if (response.ok) {
          const payload = await response.json();
          dashboardLink = `${dashboard_url}${payload.dashboard_url}`;
          // Store the actual test_run_id returned by the server
          if (payload.test_run_id) {
            report.metadata.actualRunId = payload.test_run_id;
            Logger.info('ReportGenerator', `Test run ingested with ID: ${payload.test_run_id}`);
          }
        } else {
          Logger.warn('ReportGenerator', 'Dashboard sync failed', { status: response.status });
        }
      } catch (error) {
        Logger.warn('ReportGenerator', 'Dashboard sync threw error', { reason: error.message });
      }
    }

    return {
      path: reportPath,
      latestPath,
      url: dashboardLink,
      actualRunId: report.metadata.actualRunId || runId,
    };
  }
}

module.exports = ReportGenerator;
