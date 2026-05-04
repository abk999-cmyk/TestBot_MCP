# Healix

**End-to-end AI test generation and QA automation, from your IDE.**

Healix is a monorepo containing two packages:

- **`testbot-mcp/`** — `@healix/mcp` (v2.0.0), an MCP server installed in developer IDEs. It orchestrates the full testing pipeline: auto-detect → explore → generate → execute → analyze → dashboard.
- **`webapp/`** — A Next.js 16 / React 19 webapp deployed on Vercel. Hosts all AI calls (OpenAI server-side), the Supabase-backed dashboard, artifact storage, and the Inngest async generation pipeline.

Users only need a `HEALIX_API_KEY`. All AI calls are proxied server-side through the webapp — no OpenAI key needed on user machines.

## Quick Start

### 1. Install the MCP server

```bash
npm install -g @healix/mcp
```

### 2. Configure your IDE

Add to your MCP settings (`~/.cursor/mcp.json`, Claude Code, or Windsurf):

```json
{
  "mcpServers": {
    "healix": {
      "command": "npx",
      "args": ["@healix/mcp"],
      "env": {
        "HEALIX_API_KEY": "your-healix-api-key"
      }
    }
  }
}
```

Get your API key from the Healix dashboard → API Keys.

### 3. Run a test

In your IDE prompt:

> "Test my app using the healix mcp"

The pipeline runs automatically:

1. **Config UI** — local HTTP form collects test type, base URL, start command, PRD file (optional), and role credentials
2. **Auto-detect** — port, framework, and start command inferred from the project when not supplied
3. **Browser exploration** — browser-use (Python subprocess) discovers real flows; falls back to a zero-dependency Playwright heuristic explorer if browser-use is unavailable
4. **PRD/AC parse** — structured acceptance-criteria extraction via `/api/parse-prd`; AC-less apps use exploration flows directly
5. **Test generation** — GPT-powered multi-agent fan-out via `/api/generate-tests`; each test tagged `[REQ:F#.S#.AC#]`
6. **Credential injection** — per-role Playwright `storageState` written to `.healix/auth-state-{role}.json`
7. **Tiered execution** — three Playwright projects run in sequence:
   - **Tier A** (`tierA-public`) — unauthenticated / public flows
   - **Tier B** (`tierB-auth-{role}`) — one project per role; marked `blocked` if login fails (A + C still run)
   - **Tier C** (`tierC-backend`) — API/backend contract tests
8. **Artifact upload** — screenshots, videos, and Playwright traces uploaded to Supabase Storage
9. **Ingest** — results POSTed to `/api/test-runs/ingest`
10. **Dashboard deep-link** — opens the run page with tier pills, failure analysis, and artifacts

## MCP Tools

| Tool | Description |
|------|-------------|
| `healix_test_my_app` | Full end-to-end pipeline. Accepts `projectPath`, `baseURL`, `port`, `startCommand`, `testType` (`frontend`/`backend`/`both`), `testStrategy` (`sequential`/`script`), `prdFile`, `generateTests`, `openDashboard`, `credentials`, `codebaseContext`, `playwrightMcp`, and more. |
| `healix_configure` | Opens the config UI and returns validated settings without running the pipeline. Useful for pre-flight checks. |

## Configuration

### MCP environment variables

Set these in the `env` block of your MCP client config (Cursor, Claude Code, Windsurf):

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `HEALIX_API_KEY` | **Yes** | Authenticates MCP → webapp; meters token usage. | — |
| `HEALIX_DASHBOARD_URL` | No | Webapp base URL. Used for all API calls and dashboard deep-links. | Production Vercel URL |
| `HEALIX_RUN_BUDGET_MS` | No | Overall pipeline timeout (ms). | `3600000` (60 min) |
| `HEALIX_GEN_BUDGET_MS` | No | Test-generation stage timeout (ms). Raise for large codebases. | `900000` (15 min) |
| `HEALIX_SKIP_PLANNER` | No | Set `1` to bypass the pre-fan-out planner pass (emergency circuit breaker). | unset |

### Webapp environment variables

Copy `.env.example` to `webapp/.env.local`:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (Supabase pooler URI for production). |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public). |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only — never expose). |
| `OPENAI_API_KEY` | OpenAI API key. Used only by webapp API routes — never by the MCP. |
| `OPENAI_MODEL` | Model override (default: `gpt-4o`). |
| `HEALIX_GEN_ASYNC` | `true` routes `/api/generate-tests` through Inngest background jobs. Default: `false`. |
| `HEALIX_TEST_STRATEGY` | `sequential` runs live turn-by-turn testing before synthesizing specs; `script` uses legacy full-spec generation. Default: `sequential`. |
| `INNGEST_EVENT_KEY` | Inngest event key (required only when `HEALIX_GEN_ASYNC=true`). |
| `INNGEST_SIGNING_KEY` | Inngest webhook signing key (required only when `HEALIX_GEN_ASYNC=true`). |
| `INNGEST_DEV` | Set `1` when running against the local `inngest-cli`. |
| `HEALIX_PLANNER_AGENT` | `1` to enable LLM-driven planner. Default: `0` (rule-based). |
| `AI_MAX_REQUESTS_PER_MINUTE` | Per-user AI rate-limit ceiling. Default: `20`. |

See `.env.example` for the full annotated reference.

### Async generation (Inngest)

The default sync generation path runs the full multi-agent fan-out inside the `/api/generate-tests` request. For very large codebases where a single agent call risks hitting Vercel's function timeout:

1. Set `HEALIX_GEN_ASYNC=true` on the webapp and configure `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`.
2. No MCP change needed — `@healix/mcp` auto-detects the `202` response and polls `/api/generate-tests/jobs/{jobId}`.

**Do not enable `HEALIX_GEN_ASYNC=true` for local dev.** There is no function-timeout constraint on `localhost`; the async path adds Inngest setup and polling overhead for no benefit.

## Development

```bash
# Start the webapp (Next.js dev server on port 3000)
npm run dev:webapp

# Start the MCP server (stdio transport)
npm run start:testbot

# Run MCP unit tests (26 test files via node --test)
npm run test:testbot

# Database — run from webapp/
npm run db:generate   # generate Drizzle migration from schema changes
npm run db:migrate    # apply pending migrations
npm run db:studio     # open Drizzle Studio
```

## Architecture

```
User IDE (Cursor / Claude Code / Windsurf)
         │  stdio (MCP protocol)
         ▼
 @healix/mcp  ─── thin client, HEALIX_API_KEY only ───────────────┐
         │                                                         │
         │  Pipeline (pipeline-worker.js):                         │
         │  1. Config UI (local HTTP server)                       │
         │  2. Auto-detect port/framework/start-cmd                │
         │  3. Browser-use exploration (Python) or PW heuristic    │
         │  4. Parse PRD/AC  ───── HTTPS ──────────────────────────┤
         │  5. Generate tests ──── HTTPS ──────────────────────────┤
         │  6. Inject credentials (storageState per role)          │
         │  7. Run Playwright: Tier A / Tier B / Tier C            │
         │  8. Upload artifacts ─── HTTPS ─────────────────────────┤
         │  9. Ingest results ──── HTTPS ──────────────────────────┤
         │ 10. Open dashboard deep-link                            │
         │                                                         ▼
         └──────────────────── Healix webapp (Vercel / localhost) ──
                               │  Next.js 16 + React 19
                               │  Supabase (Auth + DB + Storage)
                               │  Drizzle ORM (PostgreSQL)
                               │  Inngest (async generation jobs)
                               └──────── OpenAI (server-side only)
```

## Project Structure

```
TestBot_MCP/
├── testbot-mcp/                  # @healix/mcp — npm package (v2.0.0)
│   ├── bin/healix-mcp.js         # CLI entry point
│   ├── src/
│   │   ├── index.js              # MCP server + tool registration
│   │   ├── pipeline-worker.js    # End-to-end pipeline orchestration
│   │   ├── auto-detector.js      # Port/framework/start-cmd detection
│   │   ├── webapp-client.js      # All webapp API calls (HEALIX_API_KEY)
│   │   ├── config-ui-launcher.js # Local HTTP config form
│   │   ├── browser-use-driver.js # Python browser-use subprocess
│   │   ├── playwright-explorer.js # Zero-dep Playwright heuristic fallback
│   │   ├── playwright-integration.js # Tier A/B/C Playwright projects
│   │   ├── playwright-mcp-client.js  # @playwright/mcp integration
│   │   ├── credentials-injector.js   # Per-role storageState injection
│   │   ├── artifact-uploader.js  # Supabase Storage upload
│   │   ├── results-merger.js     # Merge tier results + blocked status
│   │   ├── report-generator.js   # Build ingest payload
│   │   ├── mcp-telemetry.js      # Background telemetry reporting
│   │   ├── multi-service-starter.js  # App-under-test launcher
│   │   ├── context-gatherer.js   # Codebase context extraction
│   │   ├── dashboard-launcher.js # Open dashboard deep-link
│   │   ├── logger.js
│   │   ├── ai-providers/
│   │   │   └── saas-client.js    # Proxy → Healix webapp
│   │   └── failure-triage/
│   │       ├── classifier.js           # Deterministic first-match rules
│   │       ├── agent-response.js       # AI failure analysis parsing
│   │       ├── error-remediations.js   # Patch suggestions
│   │       ├── evidence-bundler.js     # Test source + AC + trace evidence
│   │       ├── pipeline-error-classifier.js
│   │       └── trace-parser.js         # Playwright trace.zip parser
│   ├── scripts/
│   │   ├── browser_use_runner.py # Pinned browser-use driver
│   │   └── localhost-smoke.js    # Local smoke test helper
│   └── test/                     # 26 test files (node --test)
│
└── webapp/                       # Next.js 16 webapp (Vercel)
    ├── src/
    │   ├── app/
    │   │   ├── (auth)/           # Sign in / sign up / callback pages
    │   │   ├── (dashboard)/      # Authenticated dashboard pages
    │   │   │   ├── home/         # Overview + recent runs
    │   │   │   ├── create-tests/ # Manual test run creation
    │   │   │   ├── all-tests/    # Test run history
    │   │   │   ├── mcp-tests/    # MCP-originated runs
    │   │   │   ├── test-run/[id] # Live + historical run detail
    │   │   │   ├── import-tests/ # Groovy test import from Excel/CSV
    │   │   │   ├── monitoring/   # Live MCP telemetry + run monitoring
    │   │   │   ├── api-keys/     # API key management
    │   │   │   ├── plan-billing/ # Plan + credits
    │   │   │   └── profile/
    │   │   └── api/
    │   │       ├── generate-tests/    # Multi-agent AC-traced generation
    │   │       ├── parse-prd/         # PRD → structured AC extraction
    │   │       ├── exploration/plan/  # Flow prioritization
    │   │       ├── analyze-failures/  # AI failure triage
    │   │       ├── test-runs/         # CRUD + ingest + phase + SSE stream
    │   │       ├── import-tests/      # Excel/CSV → Groovy generation
    │   │       ├── mcp-telemetry/     # Telemetry ingest + summary
    │   │       ├── mcp-auth/validate/ # API key validation
    │   │       ├── artifacts/         # Supabase Storage proxy
    │   │       ├── upload-artifacts/  # Signed upload URLs
    │   │       ├── api-keys/          # Key CRUD
    │   │       ├── auth/              # Supabase Auth helpers
    │   │       ├── inngest/           # Inngest function registry
    │   │       └── profile/
    │   └── lib/
    │       ├── db/schema.ts           # Drizzle ORM schema (source of truth)
    │       ├── test-generation/       # GPT orchestration: planner + agents
    │       ├── inngest/functions/     # generate-tests-orchestrator + agent
    │       ├── types/database.ts      # Shared TypeScript interfaces
    │       ├── ai-guard.ts            # Per-user AI rate limiting
    │       ├── credits.ts             # Token accounting
    │       ├── mcp-live-runs.ts       # SSE live run state from telemetry
    │       ├── groovy-generator.ts    # Groovy test file generation
    │       └── excel-parser.ts        # Excel/CSV test case ingestion
    └── drizzle/                  # SQL migrations
```

## Database Schema (key tables)

| Table | Purpose |
|-------|---------|
| `profiles` | User accounts (plan, credits, tokens) |
| `api_keys` | Hashed API keys per user |
| `test_runs` | Execution results with tier results, pipeline errors, AI analysis |
| `test_failures` | Per-test failure verdicts with evidence and user overrides |
| `mcp_telemetry_events` | Pipeline event stream (powers live run monitoring) |
| `generation_jobs` | Inngest async generation job lifecycle |
| `generation_plans` | 24h cached planner output per repo snapshot |
| `test_artifacts` | Screenshot / video / trace metadata + Supabase Storage paths |
| `import_sessions` | Groovy import sessions (Excel/CSV → test cases) |
| `imported_test_cases` | Parsed test cases from import |
| `generated_groovy_files` | Generated Groovy API test files |

## Migrating from `@testbot/mcp`

See [`MIGRATION.md`](./MIGRATION.md) for the full upgrade guide. Summary:

```bash
npm uninstall -g @testbot/mcp
npm install -g @healix/mcp
```

Remove `OPENAI_API_KEY`, `AI_PROVIDER`, and any other AI keys from your MCP config — they are ignored in v2.0.0. Only `HEALIX_API_KEY` is required.

## License

MIT
