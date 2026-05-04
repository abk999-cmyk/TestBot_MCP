/**
 * Artifact Uploader
 * Uploads test artifacts (screenshots, videos, traces) to backend storage
 * Uses multipart/form-data for efficient streaming and image compression
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FormData = require('form-data');
const Logger = require('./logger');

// Phase D: anything matching these patterns MUST NEVER upload. Credentials
// stay on the user's machine.
//
//   auth-state-*.json  — storageState files written by credentials-injector
//   credentials.json   — raw creds blob (status-dir historical)
//   credentials-*      — any derivative naming
//
// Applied by fileName + fullPath so a state file copied anywhere still gets
// blocked.
const CREDENTIAL_DENY_PATTERNS = [
  /(?:^|[\\/])\.healix[\\/]auth-state-.*\.json$/,
  /(?:^|[\\/])auth-state-.*\.json$/,
  /(?:^|[\\/])credentials\.json$/,
  /(?:^|[\\/])credentials-.*$/,
];

function isCredentialFile(filePath, fileName) {
  const candidates = [filePath, fileName].filter(Boolean);
  return candidates.some((s) => CREDENTIAL_DENY_PATTERNS.some((rx) => rx.test(s)));
}

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  Logger.warn('ArtifactUploader', 'sharp not installed - image compression disabled');
  sharp = null;
}

// Check if ffmpeg is available on system PATH
let ffmpegAvailable = false;
try {
  require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
  ffmpegAvailable = true;
} catch (e) {
  Logger.warn('ArtifactUploader', 'ffmpeg not found in PATH - video compression disabled');
}

class ArtifactUploader {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      dashboardUrl: config.dashboardUrl || process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000',
      apiKey: config.apiKey || process.env.HEALIX_API_KEY,
      artifactMode: config.artifactMode || 'hybrid',
      videoMode: config.videoMode || process.env.HEALIX_VIDEO_MODE || 'on',
      ...config,
    };
    this.config.videoMode = String(this.config.videoMode || '').trim().toLowerCase() === 'retain-on-failure'
      ? 'retain-on-failure'
      : 'on';
    
    Logger.info('ArtifactUploader', 'Initialized with config:', {
      projectPath: this.config.projectPath,
      dashboardUrl: this.config.dashboardUrl,
      apiKeyPresent: !!this.config.apiKey,
      apiKeyPrefix: this.config.apiKey ? this.config.apiKey.substring(0, 8) + '...' : 'MISSING',
    });
  }

  resolveArtifactPath(filePath) {
    if (!filePath) return null;
    const rawPath = String(filePath);
    if (path.isAbsolute(rawPath)) return rawPath;

    const projectRelative = path.resolve(this.config.projectPath, rawPath);
    if (fs.existsSync(projectRelative)) return projectRelative;

    return path.resolve(process.cwd(), rawPath);
  }

  isExecutedTest(test) {
    const status = String(test?.status || test?.outcome || '').toLowerCase();
    return status !== 'skipped' && status !== 'pending';
  }

  collectArtifacts(testResults, options = {}) {
    const artifacts = [];
    const includePassed = options.includePassed === true;
    const selectedTests = (testResults.tests || [])
      .filter((test) => includePassed ? this.isExecutedTest(test) : String(test.status || '').toLowerCase() === 'failed');
    
    Logger.info('ArtifactUploader', 'Starting artifact collection', {
      totalTests: testResults.tests?.length || 0,
      failedCount: (testResults.tests || []).filter(t => t.status === 'failed').length,
      selectedCount: selectedTests.length,
      includePassed,
    });

    if (selectedTests.length === 0) {
      Logger.warn('ArtifactUploader', 'No matching executed tests found, skipping artifact collection', { includePassed });
      return artifacts;
    }

    Logger.info('ArtifactUploader', `Collecting artifacts for ${selectedTests.length} test(s)`);

    // Extract artifacts from test results (already parsed by playwright-integration)
    for (const test of selectedTests) {
      const testName = test.title || test.name || 'unknown-test';
      const testArtifacts = test.artifacts || {};
      
      Logger.debug('ArtifactUploader', `Test "${testName}" has artifacts:`, {
        screenshots: testArtifacts.screenshots?.length || 0,
        videos: testArtifacts.videos?.length || 0,
        traces: testArtifacts.traces?.length || 0,
      });
      
      // Process screenshots
      for (const screenshot of testArtifacts.screenshots || []) {
        const screenshotPath = this.resolveArtifactPath(screenshot.fullPath || screenshot.path);
        Logger.debug('ArtifactUploader', `Checking screenshot: ${screenshotPath}`);
        if (screenshotPath && fs.existsSync(screenshotPath)) {
          artifacts.push({
            fullPath: screenshotPath,
            fileName: path.basename(screenshotPath),
            type: 'screenshot',
            contentType: screenshot.contentType || 'image/png',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Screenshot not found: ${screenshotPath}`);
        }
      }
      
      // Process videos
      for (const video of testArtifacts.videos || []) {
        const videoPath = this.resolveArtifactPath(video.fullPath || video.path);
        Logger.debug('ArtifactUploader', `Checking video: ${videoPath}`);
        if (videoPath && fs.existsSync(videoPath)) {
          artifacts.push({
            fullPath: videoPath,
            fileName: path.basename(videoPath),
            type: 'video',
            contentType: video.contentType || 'video/webm',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Video not found: ${videoPath}`);
        }
      }
      
      // Process traces
      for (const trace of testArtifacts.traces || []) {
        const tracePath = this.resolveArtifactPath(trace.fullPath || trace.path);
        Logger.debug('ArtifactUploader', `Checking trace: ${tracePath}`);
        if (tracePath && fs.existsSync(tracePath)) {
          artifacts.push({
            fullPath: tracePath,
            fileName: path.basename(tracePath),
            type: 'trace',
            contentType: trace.contentType || 'application/zip',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Trace not found: ${tracePath}`);
        }
      }
    }

    // Phase D: strip any credential file that snuck into test.artifacts.
    const beforeDeny = artifacts.length;
    for (let i = artifacts.length - 1; i >= 0; i -= 1) {
      if (isCredentialFile(artifacts[i].fullPath, artifacts[i].fileName)) {
        Logger.warn('ArtifactUploader', 'Deny-listed credential file excluded from artifacts', {
          fileName: artifacts[i].fileName,
        });
        artifacts.splice(i, 1);
      }
    }
    if (artifacts.length !== beforeDeny) {
      Logger.info('ArtifactUploader', `Deny-list removed ${beforeDeny - artifacts.length} credential file(s)`);
    }

    Logger.info('ArtifactUploader', `Collected ${artifacts.length} artifacts from ${selectedTests.length} test(s) via test.artifacts`);
    
    // ALWAYS try filesystem fallback if no artifacts found from test.artifacts
    if (artifacts.length === 0 && selectedTests.length > 0) {
      Logger.warn('ArtifactUploader', 'No artifacts found via test.artifacts property, scanning filesystem...');
      // Pass selected tests so we can map directory names to actual test titles.
      const testTitleMap = {};
      for (const test of selectedTests) {
        const title = test.title || test.name || 'unknown-test';
        // Create a normalized key from the title for matching
        const normalizedKey = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        testTitleMap[normalizedKey] = title;
      }
      const fsArtifacts = this.collectFromFilesystem(selectedTests, testTitleMap);
      Logger.info('ArtifactUploader', `Filesystem scan found ${fsArtifacts.length} artifacts`);
      return fsArtifacts;
    }
    
    return artifacts;
  }

  /**
   * Collect artifacts from failed tests only. Kept for legacy callers/tests.
   */
  collectFailureArtifacts(testResults) {
    return this.collectArtifacts(testResults, { includePassed: false });
  }

  validateVideoArtifacts(testResults, options = {}) {
    const requireForAllExecuted = options.requireForAllExecuted === true;
    const executedTests = (testResults.tests || []).filter((test) => this.isExecutedTest(test));
    const missing = [];
    const invalid = [];
    let testsWithVideo = 0;
    let videoCount = 0;

    for (const test of executedTests) {
      const testName = test.title || test.name || 'unknown-test';
      const videos = Array.isArray(test.artifacts?.videos) ? test.artifacts.videos : [];
      if (videos.length > 0) {
        testsWithVideo += 1;
      } else if (requireForAllExecuted) {
        missing.push({
          testName,
          status: test.status || 'unknown',
          reason: 'missing_video_attachment',
        });
      }

      for (const video of videos) {
        videoCount += 1;
        const videoPath = this.resolveArtifactPath(video.fullPath || video.path);
        if (!videoPath || !fs.existsSync(videoPath)) {
          invalid.push({
            testName,
            path: video.fullPath || video.path || null,
            reason: 'missing_file',
          });
          continue;
        }

        const stats = fs.statSync(videoPath);
        if (stats.size <= 0) {
          invalid.push({
            testName,
            path: videoPath,
            reason: 'zero_byte_file',
            size: stats.size,
          });
        }
      }
    }

    return {
      ok: missing.length === 0 && invalid.length === 0,
      requiredForAllExecuted: requireForAllExecuted,
      totalExecuted: executedTests.length,
      testsWithVideo,
      videoCount,
      missing,
      invalid,
    };
  }
  
  /**
   * Fallback: Scan filesystem for artifacts when test.artifacts is empty
   * @param {Array} failedTests - Array of failed test objects
   * @param {Object} testTitleMap - Map of normalized test names to actual titles
   */
  collectFromFilesystem(failedTests, testTitleMap = {}) {
    const artifacts = [];
    const testResultsDir = path.join(this.config.projectPath, 'test-results');
    
    if (!fs.existsSync(testResultsDir)) {
      Logger.warn('ArtifactUploader', 'test-results directory not found at:', testResultsDir);
      return artifacts;
    }
    
    Logger.info('ArtifactUploader', `Scanning ${testResultsDir} for artifacts (${failedTests.length} failed tests)`);
    Logger.debug('ArtifactUploader', `Test title map has ${Object.keys(testTitleMap).length} entries`);
    
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          let type = null;
          let contentType = null;
          
          if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            type = 'screenshot';
            contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
          } else if (ext === '.webm' || ext === '.mp4') {
            type = 'video';
            contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
          } else if (ext === '.zip' && entry.name.includes('trace')) {
            type = 'trace';
            contentType = 'application/zip';
          }
          
          if (type) {
            // Extract test name from parent directory name
            // Playwright creates dirs like: "test-title-hash-browser"
            const parentDir = path.basename(path.dirname(fullPath));
            const dirBasedName = parentDir.split('-chromium')[0].split('-firefox')[0].split('-webkit')[0] || 'unknown-test';
            
            // Try to find the actual test title by matching against testTitleMap
            let actualTestTitle = dirBasedName; // fallback
            if (Object.keys(testTitleMap).length > 0) {
              // Normalize the directory name for matching
              const normalizedDir = dirBasedName.toLowerCase().replace(/[^a-z0-9]/g, '');
              
              // Find best match in testTitleMap
              for (const [normalizedKey, title] of Object.entries(testTitleMap)) {
                if (normalizedDir.includes(normalizedKey.substring(0, 20)) || 
                    normalizedKey.includes(normalizedDir.substring(0, 20))) {
                  actualTestTitle = title;
                  Logger.debug('ArtifactUploader', `Mapped directory "${dirBasedName}" to test title "${title}"`);
                  break;
                }
              }
            }
            
            artifacts.push({
              fullPath,
              fileName: entry.name,
              type,
              contentType,
              testName: actualTestTitle, // Use the actual test title, not directory name
            });
            
            Logger.debug('ArtifactUploader', `Found artifact: ${type} - ${entry.name} for test "${actualTestTitle}"`);
          }
        }
      }
    };
    
    scanDir(testResultsDir);
    
    const filtered = artifacts.filter((artifact) => {
      const denied = isCredentialFile(artifact.fullPath, artifact.fileName);
      if (denied) {
        Logger.warn('ArtifactUploader', 'Deny-listed credential file excluded from filesystem artifact scan', {
          fileName: artifact.fileName,
        });
      }
      return !denied;
    });

    Logger.info('ArtifactUploader', `Filesystem scan found ${filtered.length} artifacts`);
    return filtered;
  }


  /**
   * Compress image if it's a screenshot and sharp is available
   */
  async compressImage(filePath) {
    if (!sharp) {
      return fs.readFileSync(filePath);
    }

    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
        return fs.readFileSync(filePath);
      }

      const originalBuffer = fs.readFileSync(filePath);
      const originalSize = originalBuffer.length;

      // Compress with sharp: resize to max 1280px, quality 60, convert to JPEG for better compression
      const metadata = await sharp(originalBuffer).metadata();
      let compressor = sharp(originalBuffer)
        .resize(1280, null, { withoutEnlargement: true, fit: 'inside' });
      
      // Use JPEG for better compression (unless image has transparency)
      if (metadata.hasAlpha) {
        compressor = compressor.png({ quality: 60, compressionLevel: 9 });
      } else {
        compressor = compressor.jpeg({ quality: 60, mozjpeg: true });
      }
      
      const compressed = await compressor.toBuffer();

      const compressedSize = compressed.length;
      const savedPercent = Math.round((1 - compressedSize / originalSize) * 100);

      Logger.debug('ArtifactUploader', `Compressed ${path.basename(filePath)}: ${originalSize} → ${compressedSize} bytes (${savedPercent}% saved)`);
      
      return compressed;
    } catch (error) {
      Logger.warn('ArtifactUploader', `Image compression failed for ${filePath}, using original`, { error: error.message });
      return fs.readFileSync(filePath);
    }
  }

  /**
   * Compress video using ffmpeg (native child_process) with near-lossless encoding
   */
  async compressVideo(filePath) {
    if (!ffmpegAvailable) {
      return fs.readFileSync(filePath);
    }

    return new Promise((resolve) => {
      try {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.webm' && ext !== '.mp4') {
          resolve(fs.readFileSync(filePath));
          return;
        }

        const originalSize = fs.statSync(filePath).size;
        const outputPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');

        Logger.debug('ArtifactUploader', `Compressing video ${path.basename(filePath)}...`);

        // Call ffmpeg directly via spawn with very aggressive compression
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', filePath,              // Input file
          '-c:v', 'libx264',           // H.264 codec
          '-crf', '32',                // Aggressive compression (32=smaller files, still acceptable)
          '-preset', 'medium',         // Balance speed/compression
          '-vf', 'scale=960:-2,fps=15',  // Resize to 960px width + reduce to 15fps
          '-c:a', 'aac',               // Re-encode audio to AAC for better compression
          '-b:a', '64k',               // Audio bitrate 64kbps (lower quality but smaller)
          '-movflags', '+faststart',   // Enable streaming
          '-y',                        // Overwrite output file
          outputPath
        ], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        ffmpegProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            try {
              const compressedSize = fs.statSync(outputPath).size;
              const savedPercent = Math.round((1 - compressedSize / originalSize) * 100);

              Logger.debug('ArtifactUploader', `Compressed ${path.basename(filePath)}: ${originalSize} → ${compressedSize} bytes (${savedPercent}% saved)`);
              
              const compressed = fs.readFileSync(outputPath);
              // Clean up temp file
              try { fs.unlinkSync(outputPath); } catch {}
              resolve(compressed);
            } catch (error) {
              Logger.warn('ArtifactUploader', `Failed to read compressed video, using original`, { error: error.message });
              try { fs.unlinkSync(outputPath); } catch {}
              resolve(fs.readFileSync(filePath));
            }
          } else {
            Logger.warn('ArtifactUploader', `Video compression failed (exit ${code}), using original`);
            try { fs.unlinkSync(outputPath); } catch {}
            resolve(fs.readFileSync(filePath));
          }
        });

        ffmpegProcess.on('error', (error) => {
          Logger.warn('ArtifactUploader', `Video compression error for ${filePath}, using original`, { error: error.message });
          try { fs.unlinkSync(outputPath); } catch {}
          resolve(fs.readFileSync(filePath));
        });
      } catch (error) {
        Logger.warn('ArtifactUploader', `Video compression setup error for ${filePath}, using original`, { error: error.message });
        resolve(fs.readFileSync(filePath));
      }
    });
  }

  /**
   * Upload artifacts to backend storage using multipart/form-data
   */
  async uploadArtifacts(runId, artifacts) {
    Logger.info('ArtifactUploader', `uploadArtifacts called`, {
      runId,
      artifactCount: artifacts.length,
      hasApiKey: !!this.config.apiKey,
      dashboardUrl: this.config.dashboardUrl
    });
    
    if (!this.config.apiKey) {
      Logger.error('ArtifactUploader', 'No API key configured, cannot upload artifacts');
      return { success: false, reason: 'no_api_key' };
    }

    if (artifacts.length === 0) {
      Logger.warn('ArtifactUploader', 'No artifacts to upload - collection found 0 artifacts');
      return { success: true, uploaded: 0 };
    }

    // CRITICAL: Must use node-fetch, not global fetch
    // Global fetch doesn't handle form-data library streams properly
    const fetchFn = require('node-fetch');

    Logger.info('ArtifactUploader', `Uploading ${artifacts.length} artifacts to ${this.config.dashboardUrl} via multipart`);

    try {
      // Create multipart form data
      const form = new FormData();
      form.append('api_key', this.config.apiKey);
      form.append('run_id', runId);

      // Add each artifact as a file with metadata
      for (let i = 0; i < artifacts.length; i++) {
        const artifact = artifacts[i];

        // Phase D deny-list: never upload credential files. Belt-and-braces
        // check here in addition to collect-time filtering — if someone hands
        // this function a credentials file directly, we still refuse.
        if (isCredentialFile(artifact.fullPath, artifact.fileName)) {
          Logger.warn('ArtifactUploader', 'Refusing to upload credential file', {
            fileName: artifact.fileName,
          });
          continue;
        }

        // Compress based on type
        let fileBuffer;
        if (artifact.type === 'screenshot') {
          fileBuffer = await this.compressImage(artifact.fullPath);
        } else if (artifact.type === 'video') {
          fileBuffer = await this.compressVideo(artifact.fullPath);
        } else {
          fileBuffer = fs.readFileSync(artifact.fullPath);
        }

        // Append file
        form.append(`artifact_${i}`, fileBuffer, {
          filename: artifact.fileName,
          contentType: artifact.contentType,
        });

        // Append metadata as JSON string
        form.append(`artifact_${i}_meta`, JSON.stringify({
          test_name: artifact.testName,
          type: artifact.type,
          metadata: {
            file_size: fileBuffer.length,
            uploaded_at: new Date().toISOString(),
          },
        }));

        Logger.debug('ArtifactUploader', `Added artifact ${i}: ${artifact.fileName} (${fileBuffer.length} bytes)`);
      }

      // Upload with multipart/form-data
      // IMPORTANT: Don't set Content-Type header - let FormData set it with boundary
      const headers = form.getHeaders ? form.getHeaders() : undefined;
      
      const response = await fetchFn(`${this.config.dashboardUrl}/api/upload-artifacts`, {
        method: 'POST',
        body: form,
        ...(headers && { headers }), // Only include headers for node-fetch with form-data
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        Logger.error('ArtifactUploader', `Upload failed (HTTP ${response.status})`, { error: text });
        return { success: false, reason: `http_${response.status}`, error: text };
      }

      const result = await response.json();
      Logger.info('ArtifactUploader', `Successfully uploaded ${result.uploaded}/${result.total} artifacts (${result.failed || 0} failed)`);
      
      if (result.errors && result.errors.length > 0) {
        Logger.warn('ArtifactUploader', 'Some artifacts failed:', result.errors);
      }
      
      return { 
        success: result.uploaded > 0, 
        uploaded: result.uploaded,
        failed: result.failed || 0,
        artifacts: result.artifacts 
      };
    } catch (error) {
      Logger.error('ArtifactUploader', 'Upload failed', { error: error.message });
      return { success: false, reason: 'network_error', error: error.message };
    }
  }

  /**
   * Main method: collect and upload artifacts for failed tests
   */
  async processAndUpload(runId, testResults) {
    try {
      const includePassed = this.config.videoMode === 'on' || this.config.artifactMode === 'full';
      Logger.info('ArtifactUploader', `processAndUpload called for run ${runId}`, { includePassed });
      const artifacts = this.collectArtifacts(testResults, { includePassed });
      Logger.info('ArtifactUploader', `Collected ${artifacts.length} artifacts, proceeding to upload`);
      
      if (artifacts.length === 0) {
        Logger.warn('ArtifactUploader', 'No artifacts collected - check if test-results directory exists and contains artifact files');
      }
      
      const result = await this.uploadArtifacts(runId, artifacts);
      Logger.info('ArtifactUploader', 'Upload completed', result);
      return result;
    } catch (error) {
      Logger.error('ArtifactUploader', 'processAndUpload failed with error:', error);
      return { success: false, reason: 'exception', error: error.message };
    }
  }
}

module.exports = ArtifactUploader;
module.exports.isCredentialFile = isCredentialFile;
module.exports.CREDENTIAL_DENY_PATTERNS = CREDENTIAL_DENY_PATTERNS;
