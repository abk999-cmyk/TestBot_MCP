'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ArtifactUploader = require('../src/artifact-uploader');
const ReportGenerator = require('../src/report-generator');

function makeProject(t) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-artifacts-'));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  return projectPath;
}

function writeFile(projectPath, relativePath, contents = 'x') {
  const fullPath = path.join(projectPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
  return fullPath;
}

test('collectArtifacts includes passed and failed videos when includePassed is true', (t) => {
  const projectPath = makeProject(t);
  const passedVideo = writeFile(projectPath, 'test-results/passed/video.webm', 'passed-video');
  const failedVideo = writeFile(projectPath, 'test-results/failed/video.webm', 'failed-video');
  const skippedVideo = writeFile(projectPath, 'test-results/skipped/video.webm', 'skipped-video');
  const credentialFile = writeFile(projectPath, '.healix/auth-state-admin.json', '{"token":"secret"}');
  const uploader = new ArtifactUploader({ projectPath, videoMode: 'on' });

  const artifacts = uploader.collectArtifacts({
    tests: [
      {
        title: 'passes',
        status: 'passed',
        artifacts: {
          screenshots: [{ path: credentialFile, contentType: 'image/png' }],
          videos: [{ path: passedVideo, contentType: 'video/webm' }],
        },
      },
      {
        title: 'fails',
        status: 'failed',
        artifacts: { videos: [{ path: failedVideo, contentType: 'video/webm' }] },
      },
      {
        title: 'skipped',
        status: 'skipped',
        artifacts: { videos: [{ path: skippedVideo, contentType: 'video/webm' }] },
      },
    ],
  }, { includePassed: true });

  assert.deepEqual(
    artifacts.map((artifact) => artifact.testName).sort(),
    ['fails', 'passes'],
  );
  assert.equal(artifacts.every((artifact) => artifact.type === 'video'), true);
  assert.equal(artifacts.some((artifact) => artifact.fullPath === credentialFile), false);
});

test('collectFailureArtifacts remains failed-tests-only for legacy mode', (t) => {
  const projectPath = makeProject(t);
  const passedVideo = writeFile(projectPath, 'test-results/passed/video.webm', 'passed-video');
  const failedVideo = writeFile(projectPath, 'test-results/failed/video.webm', 'failed-video');
  const uploader = new ArtifactUploader({ projectPath, videoMode: 'retain-on-failure' });

  const artifacts = uploader.collectFailureArtifacts({
    tests: [
      { title: 'passes', status: 'passed', artifacts: { videos: [{ path: passedVideo }] } },
      { title: 'fails', status: 'failed', artifacts: { videos: [{ path: failedVideo }] } },
    ],
  });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].testName, 'fails');
});

test('validateVideoArtifacts flags missing and zero-byte videos for executed tests', (t) => {
  const projectPath = makeProject(t);
  const goodVideo = writeFile(projectPath, 'test-results/good/video.webm', 'good-video');
  const emptyVideo = writeFile(projectPath, 'test-results/empty/video.webm', '');
  const uploader = new ArtifactUploader({ projectPath, videoMode: 'on' });

  const validation = uploader.validateVideoArtifacts({
    tests: [
      { title: 'has video', status: 'passed', artifacts: { videos: [{ path: goodVideo }] } },
      { title: 'missing attachment', status: 'failed', artifacts: { videos: [] } },
      { title: 'empty video', status: 'passed', artifacts: { videos: [{ path: emptyVideo }] } },
      { title: 'missing file', status: 'passed', artifacts: { videos: [{ path: path.join(projectPath, 'missing.webm') }] } },
      { title: 'skipped no video', status: 'skipped', artifacts: { videos: [] } },
    ],
  }, { requireForAllExecuted: true });

  assert.equal(validation.ok, false);
  assert.equal(validation.totalExecuted, 4);
  assert.equal(validation.testsWithVideo, 3);
  assert.deepEqual(validation.missing.map((item) => item.testName), ['missing attachment']);
  assert.deepEqual(
    validation.invalid.map((item) => item.reason).sort(),
    ['missing_file', 'zero_byte_file'],
  );
});

test('report metadata and test attachments preserve video validation state', async (t) => {
  const projectPath = makeProject(t);
  const videoPath = writeFile(projectPath, 'test-results/passed/video.webm', 'passed-video');
  const reportGenerator = new ReportGenerator();
  const videoValidation = {
    ok: false,
    requiredForAllExecuted: true,
    totalExecuted: 1,
    testsWithVideo: 1,
    videoCount: 1,
    missing: [],
    invalid: [{ testName: 'passes', reason: 'zero_byte_file', path: videoPath }],
  };

  const report = await reportGenerator.generate({
    projectPath,
    projectName: 'Video Report',
    runId: 'run-video',
    testResults: {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      duration: 10,
      videoValidation,
      tests: [
        {
          id: 'passes',
          title: 'passes',
          suite: 'smoke',
          file: 'tests/generated/passes.spec.ts',
          status: 'passed',
          duration: 10,
          artifacts: {
            screenshots: [],
            videos: [{ path: videoPath, contentType: 'video/webm', name: 'video.webm' }],
            traces: [],
            other: [],
          },
        },
      ],
      failures: [],
    },
  });

  const reportJson = JSON.parse(fs.readFileSync(report.path, 'utf-8'));
  assert.deepEqual(reportJson.metadata.videoValidation, videoValidation);
  assert.equal(reportJson.tests[0].attachments.videos.length, 1);
  assert.match(reportJson.tests[0].attachments.videos[0].path, /^artifacts\/videos\/videos-/);
  assert.ok(fs.existsSync(reportJson.tests[0].attachments.videos[0].fullPath));
});
