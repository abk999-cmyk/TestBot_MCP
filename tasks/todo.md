# Local Run And Atlas MCP Setup

- [x] Confirm repo scripts and local task notes
- [x] Put webapp environment in `webapp/.env.local`
- [x] Install workspace dependencies if needed
- [x] Start the Next.js webapp on localhost
- [x] Start or validate the Healix MCP server
- [x] Configure repo-side MCP files for the local Healix MCP server
- [x] Verify webapp reachability and MCP setup status

## Review

- Next.js dev server is running at `http://localhost:3000` and returned HTTP 200.
- Healix MCP stdio handshake succeeded and exposed `healix_configure`, `healix_test_my_app`, `healix_check_run_status`, `healix_analyze_failures`, and `healix_generate_report`.
- Atlas Apps settings show Developer mode is currently off; enabling it is required before custom/unverified MCP apps can be configured.
- Added local MCP env at `testbot-mcp/.env` and project MCP config at `.cursor/mcp.json`; both contain the provided Healix API key, are ignored by git, and have `600` permissions.
- Fixed root workspace scripts from stale package name `@testbot/mcp` to the actual package `@healix/mcp`.
- Verified the provided Healix API key through the MCP server with `healix_configure`; validation succeeded and returned `aiProviderAvailable: true`.
- Verified `npm run start:testbot` launches the local MCP package and lists tools.
- `npm run test:testbot` runs through the corrected workspace name, but this checkout currently has no `testbot-mcp/test` files, so Node reports `tests 0`.
- ChatGPT Atlas cannot be fully wired to this local stdio MCP by file-only setup: current OpenAI docs say ChatGPT custom MCP connectors require remote servers, while this repo exposes only `StdioServerTransport`.

# Thea Pipeline Test Setup

- [x] Create a new subfolder for `https://github.com/ShreyesPD/thea.git`
- [x] Add the provided Supabase/port environment file to the cloned app
- [x] Install project dependencies
- [x] Find an available local port and run the app there
- [x] Verify the running app responds locally

## Review

- Cloned `https://github.com/ShreyesPD/thea.git` into `/Users/abhinav/Desktop/Helix/thea`.
- Added the supplied values to `/Users/abhinav/Desktop/Helix/thea/.env.local`, which is ignored by git.
- Installed dependencies with `npm ci`; install succeeded, with npm reporting 7 audit vulnerabilities and a deprecated Next 15.1.3 warning.
- Started the Next.js dev server on `http://127.0.0.1:3002`.
- Verified `HEAD /` and `GET /` both returned HTTP 200 from the running app.

# Thea Healix Pipeline Run

- [x] Confirm Healix webapp is reachable on `http://localhost:3000`
- [x] Confirm Thea app is reachable on `http://127.0.0.1:3002`
- [x] Start Healix MCP run for Thea frontend and backend
- [x] Submit run configuration with Thea test credentials
- [ ] Poll run status until terminal
- [ ] Open result dashboard and record outcome

## Review

- Started Healix run `1777914635891-qfh2uu` for `/Users/abhinav/Desktop/Helix/thea`.
- Submitted config automatically: `testType=both`, generated tests enabled, Thea target `http://127.0.0.1:3003`, start command `npm run dev -- -H 127.0.0.1 -p 3003`, admin test credentials supplied by the user.

# Sequential Tester Refactor

- [x] Add `testStrategy` config and preserve legacy script generation
- [x] Let fully configured MCP calls bypass the config UI
- [x] Implement turn-by-turn sequential runner with persisted traces
- [x] Add webapp turn-action and spec-synthesis endpoints
- [x] Treat auth setup as a repairable/blockable sequential step
- [x] Wire dashboard-visible telemetry/artifacts for sequential runs
- [x] Add focused tests for schema validation, repair limits, auth fallback, and legacy strategy

## Review

- Added `testStrategy` with default `sequential` and legacy `script` fallback.
- Direct MCP runs now start automatically when `baseURL` and `startCommand` are supplied; incomplete runs still use the config UI.
- Sequential runs execute live Playwright turns, persist traces under `healix-reports/.runs/<runId>/sequential-traces`, synthesize specs into `tests/generated`, and surface case/turn progress through status + telemetry.
- Added `/api/test-turns/next-action` and `/api/test-turns/synthesize-spec` webapp routes with API key, rate, concurrency, AI guard, and token checks.
- Credential injection now tries common login routes before falling back to `/`, so missing exploration authFlow no longer treats the app root as the login page.
- Verification passed: `npm run test:testbot`, `npx tsc --noEmit --pretty false` in `webapp`, and `npm run build -w webapp`.

# Thea Sequential Verification

- [x] Start a direct sequential MCP run against Thea
- [x] Monitor live status and inspect sequential traces
- [x] Stop the first run after confirming locator resolution failure
- [x] Patch shorthand locator handling in the sequential runner
- [x] Add regression coverage for shorthand locator objects
- [x] Patch max-turn exhaustion and loopback URL normalization
- [x] Patch quota/auth turn API failures to block cases instead of passing smoke fallbacks
- [x] Re-run MCP test suite after the fix
- [x] Start a fresh Thea sequential MCP run with the patched runner
- [x] Poll run status until blocked by environment/quota
- [x] Record honest outcome

## Review

- First patched-run attempt `1777916690108-in9l2t` entered `sequential_turn`, proving the new strategy path was active.
- The first attempt exposed a real runner bug: turn actions returned locator objects like `{ "css": "#email" }`, but live execution ignored shorthand keys and eventually tried raw `locator("Email")`.
- Patched `testbot-mcp/src/sequential-runner.js` to support shorthand `css`, `label`, `placeholder`, `text`, `testId`, and role/name locator objects in both execution and local spec synthesis.
- Regression verification passed with `npm run test:testbot` after adding shorthand locator coverage.
- Fresh Thea sequential run `1777917145883-ooyyf1` started on `http://127.0.0.1:3005`; admin credential injection verified successfully before exploration.
- While monitoring `1777917145883-ooyyf1`, found a second honesty issue: a case could hit the turn cap without `finish` and still be marked passed. Patched that state to `blocked`, and normalized absolute `localhost` actions back to the configured loopback origin.
- Verification after the second patch passed: `npm run test:testbot`, `npx tsc --noEmit --pretty false` in `webapp`, and `node --check testbot-mcp/src/sequential-runner.js`.
- Fresh post-fix verification run `1777917867454-j6knqa` started on `http://127.0.0.1:3006`.
- While monitoring `1777917867454-j6knqa`, found the local Healix account/API key exhausted turn-generation tokens (`402 No tokens remaining`), and the runner was marking deterministic smoke fallbacks as passed. Patched fatal turn-service errors to block cases immediately with the underlying token/auth/rate reason.
- Verification after the third patch passed: `npm run test:testbot` and `node --check testbot-mcp/src/sequential-runner.js`.
- A final post-patch run could not start: `healix_test_my_app` now rejects the configured Healix API key at validation with `No tokens remaining`, so there is no trustworthy terminal dashboard run until tokens are restored or a valid key is supplied.

# Code-Level Sequential Test Coverage

- [x] Expand sequential runner unit tests around action execution, repair/fatal behavior, planning, and spec synthesis
- [x] Add credentials injector unit tests for login route ordering and state file paths
- [x] Expand MCP config tests for direct-run defaults and fallback strategy behavior
- [x] Add webapp turn contract tests if the package can run them without new framework churn
- [x] Run MCP tests, webapp typecheck, and any viable webapp code tests
- [x] Record final code-level verification results

## Review

- Added MCP-side coverage in `testbot-mcp/test`: sequential action execution, API probes, spec synthesis, fatal turn-service failures, case planning, direct run config, credentials injector behavior, and webapp-client endpoint/error mapping.
- Added webapp-side turn-contract coverage in `webapp/test/turn-contract.test.cjs` and replaced the placeholder webapp test script with `node --test`.
- Tests exposed a real synthesis bug where `assertURL` for `/orders` emitted invalid `toHaveURL(//orders/)`; fixed `buildSpecFromTrace` to emit `toHaveURL(new RegExp("/orders"))`.
- Final verification passed: MCP tests 33/33, webapp turn-contract tests 7/7, webapp TypeScript check, webapp production build, and Node syntax checks for modified MCP JS files.
- Targeted lint for the new webapp test passed. Full `npm run lint -w webapp` still fails on existing app lint issues outside this sequential-testing change set, including dashboard static component rules, unescaped text, `any`, and pre-existing `require()` imports in `openai-generator.ts`.

# Playwright Video, Artifact, and Agent Pipeline Hardening

- [x] Add `videoMode` config with default `on` and legacy `retain-on-failure`
- [x] Enforce Healix-owned Playwright config for generated test execution
- [x] Collect/upload videos from all executed tests when `videoMode=on`
- [x] Validate video artifacts and surface missing/empty videos in run metadata
- [x] Align MCP agent planning with webapp dispatcher rules
- [x] Add agent health accounting metadata and terminal all-agent failure handling
- [x] Add focused MCP/webapp tests for video policy, artifacts, cursor overlay, agent planning, and health
- [x] Run requested verification commands and document results

## Review

- Added `videoMode` to MCP config/direct runs/config UI payloads. Default is `on`; `retain-on-failure` remains supported.
- Generated Healix Playwright execution now uses `.healix/playwright.config.generated.cjs` so video policy is enforced even when the target app has its own Playwright config.
- Fixed Playwright browser installation to invoke the same `@playwright/test` CLI revision that the runner executes; the new video smoke test caught the previous revision mismatch.
- Artifact upload now includes passed and failed executed tests when video capture is on, while preserving credential-file denylist filtering.
- Video validation now checks every executed non-skipped test for video attachments and flags missing or zero-byte files in status/report metadata.
- Dashboard report metadata includes `videoValidation`, and the test-run page shows a warning banner when video artifacts are incomplete.
- MCP agent selection now mirrors webapp `planAgents`, and generation metadata includes agent health, requested/completed/failed accounting, and per-agent file counts.
- Verification passed: `npm run test:testbot` (46/46), `npm run test -w webapp` (10/10), `npx tsc --noEmit --pretty false` in `webapp`, `npm run build -w webapp`, and targeted ESLint for the webapp test files.

# Publish `akfixes`

- [x] Create branch `akfixes`
- [x] Stage intended repo changes excluding local Thea clone/artifacts
- [x] Commit implementation and tests
- [x] Attempt push to `origin` and record permission blocker
- [x] Push `akfixes` to writable fork `abk999-cmyk/TestBot_MCP`
- [x] Verify branch tracks the pushed fork branch

## Review

- Local commit is on branch `akfixes`.
- Push to `origin` (`krishsharma1008/TestBot_MCP`) was rejected with GitHub 403 because the authenticated account `abk999-cmyk` has read-only access there.
- Created fork `abk999-cmyk/TestBot_MCP` and pushed branch `akfixes` there.
