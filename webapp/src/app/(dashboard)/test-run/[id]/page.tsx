'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import type { TestRun, TestFailure, FailureVerdict } from '@/lib/types/database';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ErrorObj {
  message?: string;
  stack?: string;
  value?: string;
  callLog?: string[];
  snippet?: string;
  location?: { file?: string; line?: number; column?: number };
}

interface Attachment {
  path?: string;
  fullPath?: string;
  name?: string;
  contentType?: string;
}

interface ReportTest {
  name?: string;
  title?: string;
  status?: string;
  outcome?: string;
  duration?: number;
  duration_ms?: number;
  suite?: string;
  file?: string;
  error?: string | ErrorObj;
  error_message?: string;
  errorMessage?: string;
  message?: string;
  attachments?: {
    screenshots?: Attachment[];
    videos?: Attachment[];
    traces?: Attachment[];
    other?: Attachment[];
  };
  artifacts?: {
    screenshots?: Attachment[];
    videos?: Attachment[];
    traces?: Attachment[];
  };
}

interface AgentFailure {
  agent: string;
  code?: string | null;
  message?: string;
}

interface PartialGenerationWarning {
  reason: string;
  generator?: string;
  partialsWrittenCount?: number;
  message?: string;
}

interface QualityImprovementSuggestion {
  key: string;
  potentialImprovement: number;
  text: string;
}

interface QualityWarning {
  qualityScore: number;
  potentialImprovement: number;
  suggestions: QualityImprovementSuggestion[];
  totalTests?: number;
  selectorQuality?: number;
  coverageProfile?: string;
  missingCategories?: string[];
}

interface VideoValidationIssue {
  testName?: string;
  status?: string;
  path?: string | null;
  reason?: string;
  size?: number;
}

interface VideoValidation {
  ok?: boolean;
  requiredForAllExecuted?: boolean;
  totalExecuted?: number;
  testsWithVideo?: number;
  videoCount?: number;
  missing?: VideoValidationIssue[];
  invalid?: VideoValidationIssue[];
  error?: string;
}

interface AgentGenerationQuality {
  valid?: boolean;
  errorCode?: string;
  errors?: string[];
  totalTests?: number;
  minGeneratedTests?: number;
  coverageProfile?: string;
  requiredCategories?: string[];
  missingCategories?: string[];
  categories?: Record<string, number>;
}

interface AgentMetaEntry {
  agent: string;
  generationMeta?: {
    provider?: string;
    startedAt?: string;
    finishedAt?: string;
    generationQuality?: AgentGenerationQuality;
  };
}

interface GenerationMetaShape {
  chunkingStrategy?: string;
  agentsRequested?: string[];
  agentsCompleted?: string[];
  agentFailures?: AgentFailure[];
  agentMeta?: AgentMetaEntry[];
  partialsWrittenCount?: number;
  partialGenerationWarning?: PartialGenerationWarning;
  qualityWarning?: QualityWarning;
  [key: string]: unknown;
}

interface ReportJson {
  metadata?: {
    projectPath?: string;
    runId?: string;
    run_id?: string;
    generationMeta?: GenerationMetaShape | null;
    videoValidation?: VideoValidation | null;
    live?: {
      isLive?: boolean;
      phase?: string;
      status?: string;
      errorCode?: string;
      message?: string;
      reason?: string;
      generatedFiles?: string[];
      hasLiveTests?: boolean;
    };
  };
  tests?: ReportTest[];
  results?: ReportTest[];
  summary?: { total?: number; passed?: number; failed?: number; skipped?: number };
  stats?: { total?: number; passed?: number; failed?: number; skipped?: number; duration?: number };
}

interface AiAnalysisItem {
  testName?: string;
  test?: string;
  test_name?: string;
  analysis?: string;
  root_cause?: string;
  rootCause?: string;
  suggested_fix?: string;
  suggestedFix?: string;
  fix?: string;
  testingRecommendations?: string;
  testing_recommendations?: string;
  confidence?: number | string;
}

interface LiveEvent {
  id: string;
  type: string;
  phase: string | null;
  status: string | null;
  message: string | null;
  errorCode: string | null;
  reason: string | null;
  eventType: string | null;
  durationMs: number | null;
  occurredAt: string | null;
  metadata: Record<string, unknown> | null;
}

// ── Async generation-job progress snapshot (P2-i) ────────────────────────────
// Fed by /api/test-runs/[id] on initial load + refetch polls, and live-updated
// by the `generation_job` SSE event emitted from /api/test-runs/[id]/stream.
// `null` for sync-mode runs that never wrote a generation_jobs row.
interface GenerationJobSnapshot {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial';
  agentsRequested: string[];
  agentsCompleted: Array<{ agent: string; ok: boolean; errorCode?: string }>;
  completedAt: string | null;
}

interface LiveTestResult {
  n: string;
  su: string;
  f: string;
  s: string;
  d: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely convert any error value to a display string */
function errorToString(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as ErrorObj;
    const parts = [e.message, e.stack, e.value, e.callLog?.length ? `Call log:\n${e.callLog.join('\n')}` : null]
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : JSON.stringify(err, null, 2);
  }
  return String(err);
}

/** Safely convert any value to a renderable string */
function safeString(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    if ('message' in (val as Record<string, unknown>)) return String((val as Record<string, unknown>).message);
    return JSON.stringify(val);
  }
  return String(val);
}

function getConfidencePercent(confidence: number | string | null | undefined): number | null {
  if (confidence === null || confidence === undefined) return null;
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    return confidence > 1 ? Math.max(0, Math.min(100, Math.round(confidence))) : Math.max(0, Math.min(100, Math.round(confidence * 100)));
  }
  if (typeof confidence === 'string') {
    const trimmed = confidence.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed.endsWith('%')) {
      const pct = Number(trimmed.replace('%', ''));
      return Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return parsed > 1 ? Math.max(0, Math.min(100, Math.round(parsed))) : Math.max(0, Math.min(100, Math.round(parsed * 100)));
  }
  return null;
}

function buildFailureInsight(errorText: string): string | null {
  const text = errorText.toLowerCase();

  if (text.includes('tohaveurl') && text.includes('/login')) {
    return 'This flow expects an authenticated route but the app redirected to /login. Seed auth state or add a login step before asserting URL.';
  }

  if (text.includes('expect(received).tocontain(expected)') && text.includes('received array')) {
    return 'Status assertion is too strict for this endpoint. Expand expected status set for validation/auth conflicts or update test data setup.';
  }

  if (text.includes('timeout') && (text.includes('locator') || text.includes('tobevisible'))) {
    return 'Element was not found before timeout. Prefer role/label selectors and wait on a stable UI state tied to data load.';
  }

  if (text.includes('econnrefused') || text.includes('failed to fetch')) {
    return 'Target server was unavailable during execution. Verify start command, base URL, and that the service is reachable before tests run.';
  }

  if (text.includes('tohaveproperty') || text.includes('unexpected token')) {
    return 'API contract assertion failed. Response payload shape/content changed and needs updated schema expectations or endpoint fix.';
  }

  return null;
}

// ─── Count-up animation hook ─────────────────────────────────────────────────

function useCountUp(target: number, duration = 1200, delay = 0) {
  const [value, setValue] = useState(0);
  const raf = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    let start: number | null = null;
    const timeout = setTimeout(() => {
      if (target === from) return;
      if (target === 0) { fromRef.current = 0; setValue(0); return; }
      const step = (ts: number) => {
        if (!start) start = ts;
        const progress = Math.min((ts - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const next = Math.round(from + eased * (target - from));
        fromRef.current = next;
        setValue(next);
        if (progress < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    }, delay);

    return () => {
      clearTimeout(timeout);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, duration, delay]);

  return value;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color, delay, loading }: {
  label: string; value: number; sub?: string; color: string; delay: number; loading?: boolean;
}) {
  const displayed = useCountUp(value, 1000, delay);
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: delay / 1000 }}
      className="glass-card rounded-2xl p-5 flex flex-col gap-1"
    >
      <span className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider">{label}</span>
      {loading ? (
        <div className="relative mt-1 h-9 w-14 rounded-lg bg-white/5 overflow-hidden">
          <motion.div
            className="absolute inset-y-0 w-1/2 rounded-lg"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.07), transparent)' }}
            animate={{ left: ['-50%', '150%'] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'linear', repeatDelay: 0.4 }}
          />
        </div>
      ) : (
        <span className={`text-3xl font-bold ${color}`}>{displayed}{sub}</span>
      )}
    </motion.div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = (status ?? '').toLowerCase();
  if (s === 'passed' || s === 'pass')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400">passed</span>;
  if (s === 'failed' || s === 'fail')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400">failed</span>;
  if (s === 'skipped' || s === 'skip' || s === 'pending')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400">skipped</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400">{s}</span>;
}


// ─── Artifact viewer components ──────────────────────────────────────────────

function ArtifactImage({ src, alt }: { src: string; alt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg border border-white/10 bg-white/5 px-3 py-4 text-left text-xs text-[#8BA4C8] hover:border-blue-500/30"
      >
        Screenshot unavailable in preview. Open file directly.
      </a>
    );
  }

  return (
    <>
      <button onClick={() => setExpanded(true)} className="relative group cursor-pointer rounded-lg overflow-hidden border border-white/10 hover:border-blue-500/40 transition-all">
        <img src={src} alt={alt} className="w-full h-32 object-cover" loading="lazy" onError={() => setFailed(true)} />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" /></svg>
        </div>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-8"
            onClick={() => setExpanded(false)}
          >
            <motion.img
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.8 }}
              src={src}
              alt={alt}
              className="max-w-full max-h-full rounded-xl shadow-2xl border border-white/10"
              onClick={e => e.stopPropagation()}
            />
            <button onClick={() => setExpanded(false)} className="absolute top-6 right-6 text-white/60 hover:text-white transition-colors">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ArtifactVideo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="rounded-lg overflow-hidden border border-white/10 bg-white/5 p-3">
        <div className="text-xs text-[#8BA4C8] mb-2">Video preview unavailable for this artifact.</div>
        <ArtifactDownload src={src} label="Download Video" />
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden border border-white/10">
      <video controls preload="metadata" className="w-full max-h-64" onError={() => setFailed(true)}>
        <source src={src} />
        Your browser does not support the video tag.
      </video>
    </div>
  );
}

function ArtifactDownload({ src, label }: { src: string; label: string }) {
  return (
    <a href={src} download className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 hover:border-blue-500/30 transition-all text-sm text-[#8BA4C8] hover:text-[#F0F6FF]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
      {label}
    </a>
  );
}

// ─── Normalise test from various report shapes ───────────────────────────────

interface NormalisedTest {
  name: string;
  status: string;
  duration: number | null;
  suite: string;
  error: string | null;
  errorObj: ErrorObj | null;
  screenshots: string[];
  videos: string[];
  traces: string[];
}

function normaliseTest(t: ReportTest, idx: number, testRunId: string): NormalisedTest {
  // Safely extract error
  const rawError = t.error ?? t.error_message ?? t.errorMessage ?? t.message ?? null;
  const errorStr = errorToString(rawError);
  const errorObj: ErrorObj | null = (rawError && typeof rawError === 'object') ? rawError as ErrorObj : null;

  // Collect artifact paths
  const att = t.attachments || t.artifacts || {};
  const screenshotPaths = (att.screenshots || []).map(a => a.path || a.fullPath || a.name).filter(Boolean) as string[];
  const videoPaths = (att.videos || []).map(a => a.path || a.fullPath || a.name).filter(Boolean) as string[];
  const tracePaths = (att.traces || []).map(a => a.path || a.fullPath || a.name).filter(Boolean) as string[];

  // Extract test name for artifact matching
  // The uploader stores transformed names with hash IDs, not the original title
  // For now, just pass the original title and let the API do fuzzy matching
  const testName = t.name ?? t.title ?? `Test ${idx + 1}`;

  // Build artifact URLs with test name for proper DB matching
  const toUrl = (p: string) => `/api/artifacts?testRunId=${testRunId}&file=${encodeURIComponent(p)}&testName=${encodeURIComponent(testName)}`;

  return {
    name: t.name ?? t.title ?? `Test ${idx + 1}`,
    status: t.status ?? t.outcome ?? 'unknown',
    duration: t.duration ?? t.duration_ms ?? null,
    suite: t.suite ?? t.file ?? '—',
    error: errorStr,
    errorObj,
    screenshots: screenshotPaths.map(toUrl),
    videos: videoPaths.map(toUrl),
    traces: tracePaths.map(toUrl),
  };
}

// ─── Category helpers ─────────────────────────────────────────────────────────

function extractCategory(name: string): string {
  const match = name.match(/\[CAT:([^\]]+)\]/i);
  if (!match) return 'uncategorized';
  return match[1].trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

const CATEGORY_META: Record<string, { label: string; color: string; border: string; dot: string }> = {
  form_validation:   { label: 'Form Validation',    color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  ui_flow:           { label: 'UI Flow',             color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  workflow_journey:  { label: 'Workflow / Journey',  color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  api_contract:      { label: 'API Contract',        color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  api_auth:          { label: 'API Auth',            color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  api_negative:      { label: 'API Negative',        color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  api_stress:        { label: 'API Stress',          color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
  uncategorized:     { label: 'Uncategorized',       color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' },
};

function getCategoryMeta(cat: string) {
  if (CATEGORY_META[cat]) return CATEGORY_META[cat];
  const label = cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { label, color: 'text-[#8BA4C8]', border: 'border-[#8BA4C8]/30', dot: 'bg-[#8BA4C8]' };
}

const API_CATS = new Set(['api_contract', 'api_auth', 'api_negative', 'api_stress']);
const FRONTEND_CATS = new Set(['ui_flow', 'form_validation', 'workflow_journey']);

// Words that, when found as a filename segment, unambiguously denote a test type.
// Add any new type here and it will automatically get its own main-type group.
const TYPE_KEYWORD_MAP: Record<string, string> = {
  smoke:         'smoke',
  sanity:        'smoke',
  e2e:           'e2e',
  integration:   'integration',
  regression:    'regression',
  workflow:      'workflow',
  journey:       'workflow',
  performance:   'performance',
  perf:          'performance',
  load:          'load',
  stress:        'stress',
  burst:         'stress',
  accessibility: 'accessibility',
  a11y:          'accessibility',
  visual:        'visual',
  snapshot:      'visual',
  contract:      'api',
  api:           'api',
  expansion:     'expansion',
  error:         'error',
  frontend:      'frontend',
  ui:            'frontend',
};

// Feature-name prefixes common in filenames that are NOT test types — ignore these
// when deciding type from a segment (e.g. auth-forms.spec.ts → 'auth' is a feature).
const FEATURE_SEGMENTS = new Set([
  'auth', 'user', 'users', 'home', 'page', 'pages', 'test', 'spec',
  'main', 'index', 'app', 'dashboard', 'settings', 'profile', 'login',
  'signup', 'register', 'admin', 'public', 'private', 'shared',
]);

function extractMainType(name: string, suite: string): string {
  const fileBase = (suite || '')
    .toLowerCase()
    .replace(/\.spec\.(ts|js)$/i, '')
    .replace(/^(fallback|healix)[-_]/, '');

  // 1. Scan every segment of the filename for a type keyword
  const segments = fileBase.split(/[-_./\\]/);
  for (const seg of segments) {
    if (TYPE_KEYWORD_MAP[seg]) return TYPE_KEYWORD_MAP[seg];
  }

  // 2. CAT tag inference (most explicit per-test signal)
  const cat = extractCategory(name);
  if (API_CATS.has(cat)) return 'api';
  if (FRONTEND_CATS.has(cat)) return 'frontend';

  // 3. No keyword match and no CAT tag — use first non-feature segment of the
  //    filename as the type so new/unknown file conventions still surface correctly.
  const firstMeaningful = segments.find(s => s.length > 1 && !FEATURE_SEGMENTS.has(s));
  if (firstMeaningful) return firstMeaningful;

  // 4. Absolute fallback (generic file with no usable signal)
  return 'other';
}

const MAIN_TYPE_META: Record<string, { label: string; color: string; bg: string; dot: string; order: number }> = {
  smoke:     { label: 'Smoke',            color: 'text-[#C8DEFF]', bg: 'bg-white/[0.04]', dot: 'bg-[#C8DEFF]', order: 0 },
  frontend:  { label: 'Frontend',         color: 'text-[#C8DEFF]', bg: 'bg-white/[0.04]', dot: 'bg-[#C8DEFF]', order: 1 },
  api:       { label: 'API',              color: 'text-[#C8DEFF]', bg: 'bg-white/[0.04]', dot: 'bg-[#C8DEFF]', order: 2 },
  workflow:  { label: 'Workflow',         color: 'text-[#C8DEFF]', bg: 'bg-white/[0.04]', dot: 'bg-[#C8DEFF]', order: 3 },
  expansion: { label: 'Enhanced Coverage', color: 'text-[#C8DEFF]', bg: 'bg-white/[0.04]', dot: 'bg-[#C8DEFF]', order: 4 },
};

function getMainTypeMeta(type: string) {
  if (MAIN_TYPE_META[type]) return MAIN_TYPE_META[type];
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return { label, color: 'text-[#C8DEFF]', bg: 'bg-white/[0.04]', dot: 'bg-[#C8DEFF]', order: 99 };
}

const SECTION_BORDER: Record<string, string> = {
  smoke:     'border-[#C8DEFF]/40',
  frontend:  'border-[#C8DEFF]/40',
  api:       'border-[#C8DEFF]/40',
  workflow:  'border-[#C8DEFF]/40',
  expansion: 'border-[#C8DEFF]/40',
};

type SectionCounts = { passed: number; failed: number; skipped: number };
interface SectionDatum {
  key: string;
  totals: SectionCounts;
  subs: { key: string; counts: SectionCounts }[];
}

function SectionOverview({ sections }: { sections: SectionDatum[] }) {
  const R = 24;
  const CIRC = 2 * Math.PI * R;
  const count = sections.length;
  const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 6 ? 3 : 4;
  const remainder = count % cols;
  const leadingSpacers = remainder === 0 ? 0 : Math.floor((cols - remainder) / 2);
  const colsClass = cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-4';
  const lastRowStart = remainder === 0 ? count : count - remainder;
  const firstRows = sections.slice(0, lastRowStart);
  const lastRow = sections.slice(lastRowStart);

  const renderSection = ({ key, totals, subs }: SectionDatum) => {
        const meta = getMainTypeMeta(key);
        const border = SECTION_BORDER[key] ?? 'border-white/20';
        const total = totals.passed + totals.failed + totals.skipped;
        const rate = total > 0 ? Math.round((totals.passed / total) * 100) : 0;
        const rateColor = rate >= 70 ? 'text-emerald-400' : rate >= 40 ? 'text-amber-400' : 'text-red-400';
        const subParts = [
          totals.failed > 0 ? `${totals.failed} failed` : null,
          totals.skipped > 0 ? `${totals.skipped} skipped` : null,
          totals.passed > 0 ? `${totals.passed} passed` : null,
        ].filter(Boolean).join(' · ');
        return (
          <div key={key} className={`border-l-2 ${border} pl-3 flex flex-col gap-2`}>
            {/* Section header: name + overall inline */}
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
              <span className={`text-xs font-bold tabular-nums ${rateColor}`}>{rate}%</span>
              <span className="text-[#4A6280] text-[11px]">{subParts}</span>
            </div>
            {/* Subcategory arc-progress circles */}
            {subs.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {subs.map(({ key: subKey, counts }) => {
                  const subMeta = getCategoryMeta(subKey);
                  const subTotal = counts.passed + counts.failed + counts.skipped;
                  const subRate = subTotal > 0 ? Math.round((counts.passed / subTotal) * 100) : 0;
                  const stroke = subRate >= 70 ? '#34d399' : subRate >= 40 ? '#fbbf24' : '#f87171';
                  const offset = CIRC * (1 - subRate / 100);
                  return (
                    <div key={subKey} className="flex flex-col items-center gap-1">
                      <div className="relative w-14 h-14">
                        <svg width="56" height="56" viewBox="0 0 56 56">
                          <circle cx="28" cy="28" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
                          <circle
                            cx="28" cy="28" r={R}
                            fill="none"
                            stroke={stroke}
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray={CIRC}
                            strokeDashoffset={offset}
                            transform="rotate(-90 28 28)"
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-[11px] font-bold tabular-nums" style={{ color: stroke }}>{subRate}%</span>
                        </div>
                      </div>
                      <span className="text-[#8BA4C8] text-[10px] text-center leading-tight max-w-[56px]">{subMeta.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
  };

  return (
    <div className="flex flex-col gap-4">
      {firstRows.length > 0 && (
        <div className={`grid ${colsClass} gap-x-6 gap-y-4`}>
          {firstRows.map(s => renderSection(s))}
        </div>
      )}
      {lastRow.length > 0 && (
        <div className={`grid ${colsClass} gap-x-6 gap-y-4`}>
          {Array.from({ length: leadingSpacers }).map((_, i) => <div key={`sp-${i}`} />)}
          {lastRow.map(s => renderSection(s))}
        </div>
      )}
    </div>
  );
}

// ─── Failure verdict chip / evidence panel / override bar ──────────────────

const VERDICT_META: Record<FailureVerdict, { label: string; cls: string; dot: string }> = {
  test_is_wrong: { label: 'Test is wrong',  cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400' },
  app_is_wrong:  { label: 'App regression', cls: 'bg-red-500/15 text-red-300 border-red-500/30',       dot: 'bg-red-400' },
  environment:   { label: 'Environment',    cls: 'bg-zinc-500/20 text-zinc-300 border-zinc-400/30',    dot: 'bg-zinc-400' },
  ambiguous:     { label: 'Ambiguous',      cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30',    dot: 'bg-blue-400' },
  flake:         { label: 'Flake',          cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30', dot: 'bg-yellow-400' },
};

function VerdictChip({ verdict, confidence, source, overridden }: { verdict: FailureVerdict; confidence?: number | null; source?: string; overridden?: boolean }) {
  const meta = VERDICT_META[verdict] ?? VERDICT_META.ambiguous;
  const conf = typeof confidence === 'number' ? Math.round(confidence * 100) : null;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${meta.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
      {conf !== null && !overridden && <span className="text-white/60 tabular-nums">· {conf}%</span>}
      {overridden && <span className="text-white/60 uppercase tracking-wider">· your call</span>}
      {!overridden && source === 'classifier' && <span className="text-white/40 text-[10px] uppercase tracking-wider">· rule</span>}
      {!overridden && source === 'ai' && <span className="text-white/40 text-[10px] uppercase tracking-wider">· ai</span>}
    </span>
  );
}

function OverrideBar({ runId, failureId, current, aiVerdict, onOverride }: {
  runId: string;
  failureId: string;
  current: FailureVerdict | null;
  aiVerdict: FailureVerdict;
  onOverride: (v: FailureVerdict) => void;
}) {
  const [submitting, setSubmitting] = useState<FailureVerdict | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (verdict: FailureVerdict) => {
    setSubmitting(verdict);
    setErr(null);
    try {
      const res = await fetch(`/api/test-runs/${runId}/failure-verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ failureId, override: verdict }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      onOverride(verdict);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setSubmitting(null);
    }
  };

  const btn = (verdict: FailureVerdict, label: string, cls: string) => {
    const active = current === verdict;
    const busy = submitting === verdict;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); submit(verdict); }}
        disabled={!!submitting}
        className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all border ${active ? cls : 'bg-white/5 text-[#8BA4C8] border-white/10 hover:border-white/25'} ${busy ? 'opacity-60' : ''}`}
      >
        {busy ? '…' : label}
      </button>
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold">Your verdict:</span>
      {btn('test_is_wrong', '🔧 Test wrong', VERDICT_META.test_is_wrong.cls)}
      {btn('app_is_wrong',  '🐛 App wrong',  VERDICT_META.app_is_wrong.cls)}
      {btn('flake',         '💨 Flake',      VERDICT_META.flake.cls)}
      {current && current !== aiVerdict && (
        <span className="text-[10px] text-[#8BA4C8] italic">
          You overrode the AI ({VERDICT_META[aiVerdict]?.label ?? aiVerdict}).
        </span>
      )}
      {err && <span className="text-[10px] text-red-400">{err}</span>}
    </div>
  );
}

interface EvidenceShape {
  trace?: {
    failedAction?: { name?: string; selector?: string | null; url?: string | null; errorText?: string };
    domAtFailure?: { bodyTextSample?: string; visibleButtons?: string[]; visibleInputs?: string[] };
    networkAtFailure?: Array<{ url: string; method?: string; status: number; duration?: number }>;
    consoleAtFailure?: string[];
    preFailureScreenshot?: { path?: string } | null;
  };
  testSource?: string;
  acceptanceCriterion?: { tag?: string; text?: string } | null;
  explorationRoute?: { url?: string; title?: string | null; elements?: Array<{ selector?: string; label?: string; type?: string }> } | null;
  tier?: string | null;
  role?: string | null;
}

function EvidencePanel({ failure }: { failure: TestFailure }) {
  const [tab, setTab] = useState<'test' | 'app' | 'ac' | 'patch'>('test');
  const evidence: EvidenceShape = (failure.evidence ?? {}) as EvidenceShape;
  const patch = failure.suggested_patch as null | {
    file?: string; lineStart?: number; lineEnd?: number;
    oldCode?: string; newCode?: string; preservesRequirementTag?: boolean;
  };

  const Tab = ({ k, label }: { k: typeof tab; label: string }) => (
    <button
      onClick={(e) => { e.stopPropagation(); setTab(k); }}
      className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-t-md transition-colors ${
        tab === k
          ? 'bg-white/10 text-[#F0F6FF] border-b-2 border-[#60A5FA]'
          : 'text-[#4A6280] hover:text-[#8BA4C8]'
      }`}
    >{label}</button>
  );

  const failedAction = evidence.trace?.failedAction;
  const dom = evidence.trace?.domAtFailure;
  const net = evidence.trace?.networkAtFailure ?? [];
  const ac = evidence.acceptanceCriterion;

  return (
    <div className="rounded-xl bg-white/[0.02] border border-white/10 overflow-hidden">
      <div className="flex items-center gap-1 px-3 pt-2 border-b border-white/5">
        <Tab k="test"  label="Test asked for" />
        <Tab k="app"   label="App rendered" />
        <Tab k="ac"    label="AC says" />
        <Tab k="patch" label={patch ? 'Suggested patch' : 'No patch'} />
      </div>
      <div className="p-3">
        {tab === 'test' && (
          <div className="flex flex-col gap-2">
            {failedAction?.selector && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold mb-1">Failed action</div>
                <code className="text-[12px] font-mono text-[#F0F6FF] block break-all">
                  {failedAction.name ?? 'action'}({failedAction.selector})
                </code>
                {failedAction.errorText && (
                  <pre className="mt-1 text-red-300/80 text-[11px] font-mono whitespace-pre-wrap">{failedAction.errorText}</pre>
                )}
              </div>
            )}
            {evidence.testSource ? (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold mb-1">Test source</div>
                <pre className="text-[11.5px] font-mono text-[#D8E8FF]/85 whitespace-pre-wrap bg-black/25 rounded p-2 max-h-72 overflow-auto">{evidence.testSource}</pre>
              </div>
            ) : (
              <div className="text-[#4A6280] text-xs italic">No test source captured.</div>
            )}
          </div>
        )}
        {tab === 'app' && (
          <div className="flex flex-col gap-2">
            {dom?.bodyTextSample ? (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold mb-1">DOM at failure</div>
                <pre className="text-[11.5px] font-mono text-[#D8E8FF]/85 whitespace-pre-wrap bg-black/25 rounded p-2 max-h-48 overflow-auto">{dom.bodyTextSample}</pre>
              </div>
            ) : (
              <div className="text-[#4A6280] text-xs italic">No DOM snapshot captured.</div>
            )}
            {(dom?.visibleButtons?.length ?? 0) > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold mb-1">Visible buttons</div>
                <div className="flex flex-wrap gap-1">
                  {dom!.visibleButtons!.slice(0, 30).map((b, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-white/5 text-[#D8E8FF]/80 text-[10px] font-mono">{b}</span>
                  ))}
                </div>
              </div>
            )}
            {net.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold mb-1">Recent network</div>
                <div className="flex flex-col gap-0.5">
                  {net.slice(-10).map((r, i) => (
                    <div key={i} className={`text-[11px] font-mono ${r.status >= 500 ? 'text-red-400' : r.status >= 400 ? 'text-amber-400' : 'text-[#8BA4C8]'}`}>
                      {r.status} {r.method ?? 'GET'} {r.url}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'ac' && (
          ac?.text ? (
            <div>
              {ac.tag && (
                <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold mb-1 font-mono">{ac.tag}</div>
              )}
              <div className="text-[#D8E8FF] text-sm leading-relaxed">{ac.text}</div>
            </div>
          ) : (
            <div className="text-[#4A6280] text-xs italic">No acceptance criterion attached to this test.</div>
          )
        )}
        {tab === 'patch' && (
          patch && patch.newCode ? (
            <div className="flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-wider text-[#4A6280] font-semibold font-mono">
                {patch.file}{patch.lineStart ? `:${patch.lineStart}` : ''}{patch.lineEnd ? `-${patch.lineEnd}` : ''}
                {patch.preservesRequirementTag === false && (
                  <span className="ml-2 text-amber-400 normal-case"> · ⚠ does not preserve [REQ:]</span>
                )}
              </div>
              {patch.oldCode && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-red-400/70 font-semibold mb-1">Remove</div>
                  <pre className="text-[11.5px] font-mono text-red-300 whitespace-pre-wrap bg-red-500/5 rounded p-2">{patch.oldCode}</pre>
                </div>
              )}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-emerald-400/70 font-semibold mb-1">Replace with</div>
                <pre className="text-[11.5px] font-mono text-emerald-200 whitespace-pre-wrap bg-emerald-500/5 rounded p-2">{patch.newCode}</pre>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const prompt = [
                    `Apply the following patch to ${patch.file}${patch.lineStart ? `:${patch.lineStart}` : ''}:`,
                    '',
                    '--- Replace:',
                    patch.oldCode ?? '',
                    '',
                    '+++ With:',
                    patch.newCode ?? '',
                  ].join('\n');
                  navigator.clipboard.writeText(prompt).catch(() => {});
                }}
                className="self-start px-3 py-1 rounded-md bg-[#60A5FA]/15 text-[#60A5FA] border border-[#60A5FA]/25 text-[11px] font-semibold hover:bg-[#60A5FA]/25 transition-colors"
              >
                Copy as Cursor prompt
              </button>
            </div>
          ) : (
            <div className="text-[#4A6280] text-xs italic">No patch suggested. This verdict is for diagnosis only.</div>
          )
        )}
      </div>
    </div>
  );
}

function FailureClusterBanner({ clusters }: { clusters: Array<{ clusterId: string; members: TestFailure[] }> }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (clusters.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {clusters.map(({ clusterId, members }) => {
        const sample = members[0];
        const verdict = sample.verdict;
        const reason = sample.reason || 'same root cause';
        const open = openId === clusterId;
        return (
          <div key={clusterId} className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] overflow-hidden">
            <button
              onClick={() => setOpenId(open ? null : clusterId)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors"
            >
              <VerdictChip verdict={verdict} />
              <div className="flex-1 min-w-0">
                <div className="text-[#F0F6FF] text-sm font-semibold">
                  {members.length} tests failed with the same root cause
                </div>
                <div className="text-[#8BA4C8] text-xs mt-0.5 font-mono truncate">{reason}</div>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-[#4A6280] transition-transform ${open ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {open && (
              <ul className="px-4 pb-3 flex flex-col gap-1 border-t border-white/5 pt-2">
                {members.map((m) => (
                  <li key={m.id} className="text-[#D8E8FF]/85 text-xs font-mono truncate">
                    <span className="text-[#4A6280]">•</span> {m.test_name}
                    {m.tier && <span className="text-[#4A6280] ml-2">[{m.tier}]</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Expandable test row ─────────────────────────────────────────────────────

function TestRow({ t, idx, indented = false, aiAnalysis = [], failure, runId, onOverride }: { t: NormalisedTest; idx: number; indented?: boolean; aiAnalysis?: AiAnalysisItem[]; failure?: TestFailure; runId?: string; onOverride?: (failureId: string, verdict: FailureVerdict) => void }) {
  const [expanded, setExpanded] = useState(false);
  const matchedAi = aiAnalysis.find(item => {
    const aiName = safeString(item.testName ?? item.test ?? item.test_name);
    if (!aiName) return false;
    return aiName.toLowerCase().trim() === t.name.toLowerCase().trim();
  }) ?? null;
  const isFailed = ['failed', 'fail'].includes(t.status.toLowerCase());
  const hasDetails = !!(t.error || t.screenshots.length || t.videos.length || t.traces.length || t.errorObj || (matchedAi && isFailed) || failure);
  const failureInsight = t.error ? buildFailureInsight(t.error) : null;

  const displayVerdict: FailureVerdict | null = failure
    ? (failure.user_override ?? failure.verdict)
    : null;
  const aiVerdict: FailureVerdict | null = failure?.verdict ?? null;
  const overridden = !!failure?.user_override;

  return (
    <>
      <motion.tr
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 + idx * 0.02 }}
        className={`border-b border-white/5 last:border-0 transition-all ${hasDetails ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        <td className={`${indented ? 'pl-14 pr-6' : 'px-6'} py-3`}>
          <div className="flex items-center gap-2">
            {hasDetails ? (
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`flex-shrink-0 text-[#4A6280] transition-transform ${expanded ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            ) : (
              <span className="w-[14px] h-[14px] flex-shrink-0 inline-block" />
            )}
            <div>
              <div className="text-[#F0F6FF] text-sm font-medium flex items-center gap-2 flex-wrap">
                <span>{t.name}</span>
                {displayVerdict && (
                  <VerdictChip
                    verdict={displayVerdict}
                    confidence={failure?.verdict_confidence ?? null}
                    source={failure?.verdict_source}
                    overridden={overridden}
                  />
                )}
              </div>
              {isFailed && t.error && !expanded && (
                <div className="text-red-400/70 text-xs mt-0.5 font-mono truncate max-w-xs">
                  {t.error.length > 100 ? t.error.slice(0, 100) + '...' : t.error}
                </div>
              )}
              {isFailed && failure?.reason && !expanded && (
                <div className="text-[#8BA4C8] text-[11px] mt-0.5 font-mono truncate max-w-xs">{failure.reason}</div>
              )}
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <span className="text-[#4A6280] text-xs font-mono truncate max-w-[160px] block">{t.suite}</span>
        </td>
        <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
        <td className="px-4 py-3">
          <span className="text-[#4A6280] text-xs font-mono">
            {t.duration !== null ? `${(t.duration / 1000).toFixed(2)}s` : '—'}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {t.screenshots.length > 0 && (
              <span title={`${t.screenshots.length} screenshot(s)`} className="w-5 h-5 rounded bg-blue-500/10 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
              </span>
            )}
            {t.videos.length > 0 && (
              <span title={`${t.videos.length} video(s)`} className="w-5 h-5 rounded bg-purple-500/10 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
              </span>
            )}
            {t.traces.length > 0 && (
              <span title={`${t.traces.length} trace(s)`} className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              </span>
            )}
          </div>
        </td>
      </motion.tr>

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.tr
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <td colSpan={5} className="px-6 pb-4">
              <div className="ml-5 flex flex-col gap-4 pt-1">
                {/* Error details */}
                {t.error && (
                  <div className="rounded-xl bg-red-500/5 border border-red-500/15 p-4">
                    <div className="text-red-400 text-xs font-semibold uppercase tracking-wider mb-2">Error</div>
                    {failureInsight && (
                      <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/5 p-2.5">
                        <div className="text-red-300 text-[11px] font-semibold uppercase tracking-wider mb-1">Likely Cause</div>
                        <div className="text-red-200/90 text-xs leading-relaxed">{failureInsight}</div>
                      </div>
                    )}
                    <pre className="text-red-300/80 text-xs font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                      {t.error}
                    </pre>
                    {t.errorObj?.snippet && (
                      <div className="mt-3 pt-3 border-t border-red-500/10">
                        <div className="text-red-400/60 text-xs font-semibold uppercase tracking-wider mb-1">Code Snippet</div>
                        <pre className="text-[#8BA4C8] text-xs font-mono whitespace-pre-wrap leading-relaxed">{t.errorObj.snippet}</pre>
                      </div>
                    )}
                    {Array.isArray(t.errorObj?.callLog) && t.errorObj.callLog.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-red-500/10">
                        <div className="text-red-400/60 text-xs font-semibold uppercase tracking-wider mb-1">Call Log</div>
                        <pre className="text-[#8BA4C8] text-xs font-mono whitespace-pre-wrap leading-relaxed">
                          {t.errorObj.callLog.join('\n')}
                        </pre>
                      </div>
                    )}
                    {t.errorObj?.location && (
                      <div className="mt-2 text-[#4A6280] text-xs font-mono">
                        {t.errorObj.location.file}:{t.errorObj.location.line}:{t.errorObj.location.column}
                      </div>
                    )}
                  </div>
                )}

                {/* Screenshots */}
                {t.screenshots.length > 0 && (
                  <div>
                    <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                      Screenshots ({t.screenshots.length})
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {t.screenshots.map((src, i) => (
                        <ArtifactImage key={i} src={src} alt={`${t.name} screenshot ${i + 1}`} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Videos */}
                {t.videos.length > 0 && (
                  <div>
                    <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                      Videos ({t.videos.length})
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {t.videos.map((src, i) => (
                        <ArtifactVideo key={i} src={src} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Traces */}
                {t.traces.length > 0 && (
                  <div>
                    <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                      Traces ({t.traces.length})
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {t.traces.map((src, i) => (
                        <ArtifactDownload key={i} src={src} label={`Trace ${i + 1}`} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Triage verdict + evidence + override */}
                {failure && isFailed && (
                  <div className="flex flex-col gap-3">
                    {failure.reason && (
                      <div className="text-[#8BA4C8] text-xs">
                        <span className="text-[#4A6280] text-[10px] uppercase tracking-wider mr-2 font-semibold">Reason</span>
                        {failure.reason}
                      </div>
                    )}
                    <EvidencePanel failure={failure} />
                    {runId && onOverride && (
                      <OverrideBar
                        runId={runId}
                        failureId={failure.id}
                        current={failure.user_override ?? null}
                        aiVerdict={aiVerdict ?? 'ambiguous'}
                        onOverride={(v) => onOverride(failure.id, v)}
                      />
                    )}
                  </div>
                )}

                {/* Inline AI Analysis */}
                {matchedAi && isFailed && (() => {
                  const analysis = safeString(matchedAi.analysis);
                  const rootCause = safeString(matchedAi.root_cause ?? matchedAi.rootCause);
                  const fix = safeString(matchedAi.suggested_fix ?? matchedAi.suggestedFix ?? matchedAi.fix);
                  const testingRecommendations = safeString(matchedAi.testingRecommendations ?? matchedAi.testing_recommendations);
                  const confidence = getConfidencePercent(matchedAi.confidence);
                  return (
                    <div className="rounded-xl bg-purple-500/5 border border-purple-500/10 p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-md bg-purple-500/10 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2">
                              <path d="M12 2a10 10 0 110 20A10 10 0 0112 2z" /><path d="M12 8v4l3 3" />
                            </svg>
                          </div>
                          <span className="text-purple-300 text-xs font-semibold uppercase tracking-wider">AI Analysis</span>
                        </div>
                        {confidence !== null && (
                          <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-300 border border-purple-500/20 whitespace-nowrap">
                            {`${confidence}% confidence`}
                          </span>
                        )}
                      </div>
                      {analysis && (
                        <div>
                          <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Analysis</div>
                          <div className="text-[#8BA4C8] text-sm">{analysis}</div>
                        </div>
                      )}
                      {rootCause && (
                        <div>
                          <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Root Cause</div>
                          <div className="text-[#8BA4C8] text-sm">{rootCause}</div>
                        </div>
                      )}
                      {fix && (
                        <div>
                          <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Suggested Fix</div>
                          <div className="text-[#8BA4C8] text-sm">{fix}</div>
                        </div>
                      )}
                      {testingRecommendations && (
                        <div>
                          <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Verification</div>
                          <div className="text-[#8BA4C8] text-sm">{testingRecommendations}</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </td>
          </motion.tr>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Category group (sub-category collapsible tbody section) ─────────────────

function CategoryGroup({ category, tests, indented = false, aiAnalysis = [], failuresByName, runId, onOverride }: { category: string; tests: NormalisedTest[]; indented?: boolean; aiAnalysis?: AiAnalysisItem[]; failuresByName?: Map<string, TestFailure>; runId?: string; onOverride?: (failureId: string, verdict: FailureVerdict) => void }) {
  const [open, setOpen] = useState(true);
  const meta = getCategoryMeta(category);
  const passed = tests.filter(t => ['passed', 'pass'].includes(t.status.toLowerCase())).length;
  const failed = tests.filter(t => ['failed', 'fail'].includes(t.status.toLowerCase())).length;
  const skipped = tests.filter(t => ['skipped', 'skip', 'pending'].includes(t.status.toLowerCase())).length;
  const px = indented ? 'pl-10 pr-5' : 'px-5';

  return (
    <tbody>
      {/* Sub-category header row */}
      <tr
        className="cursor-pointer select-none border-b border-white/5 bg-white/[0.015] hover:bg-white/[0.03] transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <td colSpan={5} className={`${px} py-2`}>
          <div className="flex items-center gap-2.5">
            <svg
              width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`flex-shrink-0 text-[#4A6280] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
            <span className={`text-[11px] font-semibold uppercase tracking-wider ${meta.color}`}>{meta.label}</span>
            <span className="text-[#4A6280] text-[11px]">{tests.length} test{tests.length !== 1 ? 's' : ''}</span>
            <div className="flex items-center gap-2">
              {passed > 0 && <span className="text-[#8BA4C8] text-[11px]">{passed} passed</span>}
              {failed > 0 && <span className="text-[#8BA4C8] text-[11px]">{failed} failed</span>}
              {skipped > 0 && <span className="text-[#8BA4C8] text-[11px]">{skipped} skipped</span>}
            </div>
          </div>
        </td>
      </tr>
      {/* Test rows */}
      {open && tests.map((t, i) => (
        <TestRow
          key={i}
          t={t}
          idx={i}
          indented={indented}
          aiAnalysis={aiAnalysis}
          failure={failuresByName?.get(t.name) ?? undefined}
          runId={runId}
          onOverride={onOverride}
        />
      ))}
    </tbody>
  );
}

// ─── Main type group (top-level collapsible section) ─────────────────────────

function MainTypeGroup({ mainType, subGroups, aiAnalysis = [], failuresByName, runId, onOverride }: { mainType: string; subGroups: [string, NormalisedTest[]][]; aiAnalysis?: AiAnalysisItem[]; failuresByName?: Map<string, TestFailure>; runId?: string; onOverride?: (failureId: string, verdict: FailureVerdict) => void }) {
  const [open, setOpen] = useState(true);
  const meta = getMainTypeMeta(mainType);
  const allTests = subGroups.flatMap(([, tests]) => tests);
  const passed = allTests.filter(t => ['passed', 'pass'].includes(t.status.toLowerCase())).length;
  const failed = allTests.filter(t => ['failed', 'fail'].includes(t.status.toLowerCase())).length;
  const skipped = allTests.filter(t => ['skipped', 'skip', 'pending'].includes(t.status.toLowerCase())).length;
  const isSingleUncategorised = subGroups.length === 1 && subGroups[0][0] === 'uncategorized';

  return (
    <>
      <tbody>
        {/* Main type header row */}
        <tr
          className={`cursor-pointer select-none border-b border-white/10 ${meta.bg} hover:brightness-110 transition-all`}
          onClick={() => setOpen(o => !o)}
        >
          <td colSpan={5} className="px-4 py-3">
            <div className="flex items-center gap-3">
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={`flex-shrink-0 text-[#4A6280] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${meta.dot}`} />
              <span className={`text-sm font-bold ${meta.color}`}>{meta.label}</span>
              <span className="text-[#4A6280] text-xs">{allTests.length} test{allTests.length !== 1 ? 's' : ''}</span>
              <div className="flex items-center gap-3">
                {passed > 0 && <span className="text-[#8BA4C8] text-xs font-medium">{passed} passed</span>}
                {failed > 0 && <span className="text-[#8BA4C8] text-xs font-medium">{failed} failed</span>}
                {skipped > 0 && <span className="text-[#8BA4C8] text-xs font-medium">{skipped} skipped</span>}
              </div>
              {!isSingleUncategorised && (
                <span className="ml-auto text-[#4A6280] text-[11px]">{subGroups.length} sub-categor{subGroups.length === 1 ? 'y' : 'ies'}</span>
              )}
            </div>
          </td>
        </tr>
      </tbody>
      {/* Sub-category groups rendered as sibling tbodies */}
      {open && (isSingleUncategorised
        ? (
          <tbody>
            {subGroups[0][1].map((t, i) => (
              <TestRow
                key={i}
                t={t}
                idx={i}
                aiAnalysis={aiAnalysis}
                failure={failuresByName?.get(t.name) ?? undefined}
                runId={runId}
                onOverride={onOverride}
              />
            ))}
          </tbody>
        )
        : subGroups.map(([subCat, tests]) => (
          <CategoryGroup
            key={subCat}
            category={subCat}
            tests={tests}
            indented
            aiAnalysis={aiAnalysis}
            failuresByName={failuresByName}
            runId={runId}
            onOverride={onOverride}
          />
        ))
      )}
    </>
  );
}

// ─── Phase display helpers ───────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  starting_pipeline: 'Starting Healix',
  started: 'Healix Started',
  port_conflict: 'Port Conflict',
  jira: 'Fetching Jira Stories',
  context: 'Gathering Context',
  context_enrichment: 'Enriching Context',
  generating: 'Generating Tests',
  plan_generated: 'Plan Generated',
  generating_tests: 'Generating Tests',
  generation_partial: 'Generating Tests',
  running: 'Running Tests',
  tests_complete: 'Tests Complete',
  analyzing: 'Analyzing Failures',
  reporting: 'Generating Report',
  uploading_artifacts: 'Uploading Artifacts',
  artifacts_uploaded: 'Artifacts Uploaded',
  artifacts_upload_failed: 'Artifact Upload Failed',
  artifacts_upload_error: 'Artifact Upload Error',
  dashboard: 'Opening Dashboard',
  completed: 'Healix run Complete',
  error: 'Healix Error',
  error_reported: 'Error Reported',
  // stage:* budget markers emitted after each pipeline stage completes
  'stage:prdparse': 'Parsing PRD',
  'stage:generation': 'Generating Tests',
  'stage:execution': 'Running Tests',
  'stage:aitriage': 'Analyzing Failures',
  'stage:reporting': 'Generating Report',
  'stage:dashboard': 'Opening Dashboard',
};

const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported']);

function phaseLabel(phase: string | null): string {
  if (!phase) return 'Unknown';
  return PHASE_LABELS[phase.toLowerCase()] || phase;
}

function PhaseIcon({ phase, isLast }: { phase: string | null; isLast: boolean }) {
  const p = (phase || '').toLowerCase();
  
  // Completed phases - green checkmark
  if (p === 'completed') {
    return (
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
      </span>
    );
  }
  
  // Error/failed phases - red X
  if (p === 'error' || p === 'error_reported' || p === 'artifacts_upload_failed' || p === 'artifacts_upload_error' || p.includes('failed') || p.includes('error')) {
    return (
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </span>
    );
  }
  
  // Currently running phase - blue pulsing dot
  if (isLast) {
    return (
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center">
        <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
      </span>
    );
  }
  
  // Default completed phases - green checkmark
  return (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
    </span>
  );
}

function LiveTimeline({ events, liveFiles, pipelineEnded }: {
  events: LiveEvent[];
  liveFiles: string[];
  pipelineEnded: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  // Tick every second while the pipeline is still running so the elapsed timer updates
  useEffect(() => {
    if (pipelineEnded) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [pipelineEnded]);

  const filteredEvents = events.filter(e =>
    e.eventType !== 'test_results' &&
    e.eventType !== 'test_file_generated' &&
    e.eventType !== 'test_result'
  );
  // Deduplicate: keep only the last event per phase (multiple events per phase are repetitive)
  const phaseMap = new Map<string, LiveEvent>();
  for (const e of filteredEvents) {
    phaseMap.set(e.phase ?? '__unknown__', e);
  }
  const displayEvents = Array.from(phaseMap.values());
  if (displayEvents.length === 0) return null;
  // Decide which single event owns files to avoid duplicates
  const hasTestsGenEvent = displayEvents.some(e => e.eventType === 'tests_generated');
  return (
    <div className="flex flex-col gap-0">
      {displayEvents.map((ev, i) => {
        const isLast = i === displayEvents.length - 1;
        const isTerminal = TERMINAL_PHASES.has((ev.phase || '').toLowerCase());
        const isTestsGen = ev.eventType === 'tests_generated';
        const isGeneratingPhase = (ev.phase || '').toLowerCase() === 'generating';
        // Show files: prefer tests_generated event if present, else generating phase
        const showFiles = liveFiles.length > 0 && (hasTestsGenEvent ? isTestsGen : isGeneratingPhase);
        const effectiveIsLast = isLast && !isTerminal && !pipelineEnded;
        const time = ev.occurredAt ? new Date(ev.occurredAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '';

        // Live elapsed timer for the currently active step
        let elapsedLabel = '';
        if (effectiveIsLast && ev.occurredAt) {
          const elapsedSec = Math.max(0, Math.floor((now - new Date(ev.occurredAt).getTime()) / 1000));
          if (elapsedSec >= 2) {
            elapsedLabel = elapsedSec < 60
              ? `${elapsedSec}s`
              : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
          }
        }

        return (
          <div key={ev.id} className="flex gap-3 group">
            <div className="flex flex-col items-center">
              <PhaseIcon phase={isTerminal ? ev.phase : (effectiveIsLast ? ev.phase : 'done')} isLast={effectiveIsLast} />
              {i < displayEvents.length - 1 ? (
                <div className="w-px h-full min-h-[16px] bg-white/10 mt-0.5" />
              ) : effectiveIsLast ? (
                // Animated flowing connector below the active step to signal work in progress
                <div className="w-px flex-1 min-h-[12px] mt-0.5 relative overflow-hidden bg-blue-400/10">
                  <motion.div
                    className="absolute left-0 right-0 h-8"
                    style={{ background: 'linear-gradient(to bottom, rgba(96,165,250,0.35), transparent)' }}
                    animate={{ y: ['-100%', '200%'] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
                  />
                </div>
              ) : null}
            </div>
            <div className="pb-3 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[#F0F6FF] text-xs font-semibold">{phaseLabel(ev.phase)}</span>
                {time && <span className="text-[#4A6280] text-[10px] font-mono">{time}</span>}
                {ev.durationMs != null && ev.durationMs > 0 && (
                  <span className="text-[#4A6280] text-[10px] font-mono">{(ev.durationMs / 1000).toFixed(1)}s</span>
                )}
                {effectiveIsLast && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400/70 flex-shrink-0 animate-spin" style={{animationDuration: '2s'}}>
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                )}
              </div>
              {ev.message && (
                <div className="text-[#8BA4C8] text-xs mt-0.5">{ev.message}</div>
              )}
              {ev.reason && (
                <div className="text-red-300/80 text-xs mt-0.5 font-mono">{ev.reason}</div>
              )}

              {/* Live file badges — drip in under generating phase AND tests_generated */}
              {showFiles && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {liveFiles.map((f, fi) => (
                    <motion.span
                      key={f}
                      initial={{ opacity: 0, scale: 0.8, y: 4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ duration: 0.2, delay: fi * 0.055 }}
                      className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300/80 text-[10px] font-mono"
                    >
                      {f}
                    </motion.span>
                  ))}
                </div>
              )}

              {/* Indeterminate shimmer progress bar — only on the active (last, non-terminal) step */}
              {effectiveIsLast && (
                <div className="relative mt-2 h-0.5 rounded-full overflow-hidden bg-blue-500/10">
                  <motion.div
                    className="absolute inset-y-0 rounded-full"
                    style={{ width: '45%', background: 'linear-gradient(90deg, transparent, rgba(96,165,250,0.55), transparent)' }}
                    animate={{ left: ['-45%', '100%'] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'linear', repeatDelay: 0.15 }}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Pipeline error banner ──────────────────────────────────────────────────

interface PipelineErrorShape {
  stage?: string;
  reason?: string | null;
  stderr?: string | null;
  stdout?: string | null;
  firstSpecPreview?: { file?: string; lines?: string } | null;
  generatedSpecCount?: number;
  qualityAuditErrors?: string[] | null;
  errorCode?: string | null;
  userFacingMessage?: string | null;
}

// ─── Generation-job progress chip (P2-i) ────────────────────────────────────
// Single-line pill that surfaces live "X/N agents complete" progress for runs
// backed by an async generation_jobs row. Collapses silently on full success;
// the existing PartialGenerationBanner owns the richer partial-state UX once
// the run lands. Hidden for legacy sync-mode runs (generationJob = null).
function GenerationJobProgressChip({ job }: { job: GenerationJobSnapshot | null }) {
  if (!job) return null;
  if (job.status === 'succeeded') return null;

  const done = job.agentsCompleted.length;
  const total = job.agentsRequested.length || done;
  const failed = job.agentsCompleted.filter((a) => !a.ok).length;

  if (job.status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/25 text-[#60A5FA] text-[11px] font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        Queued · awaiting {total} agent{total === 1 ? '' : 's'}
      </span>
    );
  }
  if (job.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/25 text-[#60A5FA] text-[11px] font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
        Generating — {done}/{total} agents complete
      </span>
    );
  }
  if (job.status === 'partial') {
    const succeeded = Math.max(0, done - failed);
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-[#FCD34D] text-[11px] font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        Partial — {succeeded}/{total} agents completed · {failed} failed
      </span>
    );
  }
  if (job.status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/25 text-[#F87171] text-[11px] font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Generation failed — 0/{total} agents completed
      </span>
    );
  }
  return null;
}

function QualityWarningBanner({ warning }: { warning: QualityWarning }) {
  const [open, setOpen] = useState(false);
  const score = Math.max(0, Math.min(100, Math.round(warning.qualityScore)));
  const potential = Math.max(0, Math.min(100 - score, Math.round(warning.potentialImprovement)));
  const targetScore = Math.min(100, score + potential);
  const suggestions = warning.suggestions || [];
  const topSuggestion = suggestions[0];

  // amber for 60-79, orange/red for below 60
  const toneClass = score >= 60
    ? 'border-amber-500/25 bg-amber-500/[0.04]'
    : 'border-orange-500/30 bg-orange-500/[0.05]';
  const accentText = score >= 60 ? 'text-[#FDE68A]' : 'text-[#FDBA74]';
  const chipBg = score >= 60 ? 'bg-amber-500/10 border-amber-500/25 text-[#FCD34D]' : 'bg-orange-500/10 border-orange-500/30 text-[#FDBA74]';

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass-card rounded-2xl overflow-hidden border ${toneClass}`}
    >
      <div className="px-5 py-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${score >= 60 ? 'bg-amber-500/15 border border-amber-500/30' : 'bg-orange-500/15 border border-orange-500/30'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={score >= 60 ? '#FBBF24' : '#FB923C'} strokeWidth="2.2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className={`font-semibold text-[15px] ${accentText}`}>
              Test suite quality: {score}%
            </div>
            <div className="text-[#F0F6FF]/85 text-sm mt-0.5">
              {potential > 0 ? (
                <>
                  Tests were generated and will run, but quality could improve by{' '}
                  <span className="font-semibold text-[#FDE68A]">~{potential}%</span>{' '}
                  (to ~{targetScore}%) with the steps below.
                </>
              ) : (
                <>Tests were generated and will run, but Healix flagged some coverage concerns.</>
              )}
              {topSuggestion && (
                <span className="block mt-1 text-[#D8E8FF]/75 text-[12.5px]">
                  Biggest lift: {topSuggestion.text}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className={`px-2 py-0.5 rounded-md border text-[11px] font-mono ${chipBg}`}>
                quality: {score}%
              </span>
              {potential > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-[11px] font-mono">
                  +{potential}% achievable
                </span>
              )}
              {typeof warning.totalTests === 'number' && (
                <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                  {warning.totalTests} tests
                </span>
              )}
              {typeof warning.selectorQuality === 'number' && (
                <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                  selectorQuality: {Math.round(warning.selectorQuality * 100)}%
                </span>
              )}
              {warning.coverageProfile && (
                <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                  profile: {warning.coverageProfile}
                </span>
              )}
            </div>
          </div>
        </div>
        {suggestions.length > 0 && (
          <button
            onClick={() => setOpen((o) => !o)}
            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors flex-shrink-0 ${score >= 60 ? 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30 text-[#FCD34D]' : 'bg-orange-500/15 hover:bg-orange-500/25 border-orange-500/30 text-[#FDBA74]'}`}
          >
            {open ? 'Hide suggestions' : `How to improve (${suggestions.length})`}
          </button>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className={`px-5 py-3 border-t ${score >= 60 ? 'border-amber-500/10' : 'border-orange-500/15'}`}>
          <div className="text-[#D8E8FF]/60 text-[11px] uppercase tracking-wide mb-2">
            Ways to improve next run
          </div>
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.key} className="flex items-start gap-2">
                <span className="mt-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-[10.5px] font-mono flex-shrink-0">
                  +{s.potentialImprovement}%
                </span>
                <span className="text-[13px] text-[#F0F6FF]/90 leading-relaxed">
                  {s.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}

function AgentCoveragePanel({ agentMeta }: { agentMeta: AgentMetaEntry[] }) {
  const rows = agentMeta
    .map((entry) => {
      const q = entry.generationMeta?.generationQuality ?? {};
      const categories = q.categories ?? {};
      const total = Number(q.totalTests ?? 0);
      const required = Array.isArray(q.requiredCategories) ? q.requiredCategories : [];
      const missing = Array.isArray(q.missingCategories) ? q.missingCategories : [];
      const met = required.filter((c) => !missing.includes(c)).length;
      return {
        agent: entry.agent,
        total,
        valid: q.valid !== false,
        errorCode: q.errorCode ?? null,
        missing,
        met,
        totalRequired: required.length,
        categories,
      };
    })
    .sort((a, b) => a.agent.localeCompare(b.agent));

  if (rows.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-2xl border border-white/8 p-5"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-[#F5F8FF]">Generation coverage by agent</div>
          <div className="text-xs text-[#D8E8FF]/60">Per-agent test counts and missing required categories from this run.</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[#D8E8FF]/60">
              <th className="py-2 pr-4 font-medium">Agent</th>
              <th className="py-2 pr-4 font-medium">Tests</th>
              <th className="py-2 pr-4 font-medium">Categories met</th>
              <th className="py-2 pr-4 font-medium">Missing</th>
              <th className="py-2 pr-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.agent} className="border-t border-white/5">
                <td className="py-2 pr-4 font-mono text-[#F5F8FF]">{row.agent}</td>
                <td className="py-2 pr-4 font-mono text-[#F5F8FF]">{row.total}</td>
                <td className="py-2 pr-4 font-mono text-[#D8E8FF]/80">
                  {row.totalRequired > 0 ? `${row.met}/${row.totalRequired}` : '—'}
                </td>
                <td className="py-2 pr-4 text-[#D8E8FF]/80">
                  {row.missing.length === 0 ? (
                    <span className="text-emerald-300/90">none</span>
                  ) : (
                    <span className="font-mono text-[11px]">{row.missing.join(', ')}</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {row.valid ? (
                    <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300/90 text-[11px]">ok</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-[#FCD34D] text-[11px] font-mono">
                      {row.errorCode ?? 'shortfall'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

function VideoValidationBanner({ validation }: { validation: VideoValidation }) {
  if (validation.ok !== false) return null;
  const missing = Array.isArray(validation.missing) ? validation.missing : [];
  const invalid = Array.isArray(validation.invalid) ? validation.invalid : [];
  const totalIssues = missing.length + invalid.length + (validation.error ? 1 : 0);
  const samples = [...missing, ...invalid].slice(0, 4);

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-2xl overflow-hidden border border-purple-500/25 bg-purple-500/[0.04]"
    >
      <div className="px-5 py-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C4B5FD" strokeWidth="2.2">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-[#DDD6FE] font-semibold text-[15px]">Video artifact validation failed</div>
          <div className="text-[#F0F6FF]/85 text-sm mt-0.5">
            {validation.error || `${totalIssues} video issue${totalIssues === 1 ? '' : 's'} found across executed tests.`}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="px-2 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/25 text-[#C4B5FD] text-[11px] font-mono">
              videos: {validation.testsWithVideo ?? 0}/{validation.totalExecuted ?? 0} tests
            </span>
            <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
              mode: {validation.requiredForAllExecuted ? 'on' : 'retain-on-failure'}
            </span>
            {validation.videoCount !== undefined && (
              <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                files: {validation.videoCount}
              </span>
            )}
          </div>
          {samples.length > 0 && (
            <ul className="mt-2 space-y-1 font-mono text-[11px] text-[#D8E8FF]/75">
              {samples.map((issue, idx) => (
                <li key={`${issue.testName ?? 'video'}-${idx}`} className="truncate">
                  <span className="text-[#C4B5FD]">{issue.reason ?? 'video_issue'}</span>
                  {issue.testName && <span> · {issue.testName}</span>}
                  {issue.path && <span className="text-[#8BA4C8]"> · {issue.path}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function PartialGenerationBanner({
  warning,
  agentFailures,
  agentsCompleted,
  agentsRequested,
}: {
  warning: PartialGenerationWarning;
  agentFailures: AgentFailure[];
  agentsCompleted: string[];
  agentsRequested: string[];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const completedCount = agentsCompleted.length;
  const requestedCount = agentsRequested.length || completedCount + agentFailures.length;
  const failedCount = agentFailures.length;
  const partials = warning.partialsWrittenCount ?? null;

  const reasonLabel =
    warning.reason === 'budget_exceeded'
      ? 'Generation ran out of time'
      : warning.reason === 'agent_errors'
      ? 'Some agents failed'
      : 'Partial generation';

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-2xl overflow-hidden border border-amber-500/25 bg-amber-500/[0.04]"
    >
      <div className="px-5 py-4 border-b border-amber-500/15 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2.2">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-[#FDE68A] font-semibold text-[15px]">Partial test generation</div>
            <div className="text-[#F0F6FF]/85 text-sm mt-0.5">
              {warning.message ||
                `${reasonLabel}. Healix continued with the suites that completed in time.`}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-[#FCD34D] text-[11px] font-mono">
                agents: {completedCount}/{requestedCount} complete
              </span>
              {failedCount > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-[#FCD34D] text-[11px] font-mono">
                  {failedCount} failed
                </span>
              )}
              {partials !== null && (
                <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                  {partials} test{partials === 1 ? '' : 's'} generated
                </span>
              )}
              <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                reason: {warning.reason}
              </span>
            </div>
          </div>
        </div>
        {(failedCount > 0 || completedCount > 0) && (
          <button
            onClick={() => setDetailsOpen((o) => !o)}
            className="px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-[#FCD34D] text-xs font-semibold transition-colors flex-shrink-0"
          >
            {detailsOpen ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>

      {detailsOpen && (
        <div className="px-5 py-3 text-[12px] text-[#D8E8FF]/85 border-t border-amber-500/10">
          {completedCount > 0 && (
            <div className="mb-2">
              <div className="text-[#D8E8FF]/60 text-[11px] uppercase tracking-wide mb-1">
                Completed agents
              </div>
              <div className="flex flex-wrap gap-1">
                {agentsCompleted.map((a) => (
                  <span
                    key={a}
                    className="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-[11px] font-mono"
                  >
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}
          {failedCount > 0 && (
            <div>
              <div className="text-[#D8E8FF]/60 text-[11px] uppercase tracking-wide mb-1">
                Failed agents
              </div>
              <ul className="space-y-1 font-mono text-[11px]">
                {agentFailures.map((f, i) => (
                  <li key={`${f.agent}-${i}`} className="flex gap-2">
                    <span className="text-[#FCD34D]">{f.agent}</span>
                    {f.code && <span className="text-[#F87171]">{f.code}</span>}
                    {f.message && (
                      <span className="text-[#D8E8FF]/70 truncate">
                        {f.message.length > 160 ? f.message.slice(0, 157) + '…' : f.message}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

interface SuggestedFixStep {
  action: string;
  detail?: string;
  code?: string;
}
interface SuggestedFix {
  title: string;
  steps: SuggestedFixStep[];
  file?: string;
}

function buildSuggestedFix(error: PipelineErrorShape): SuggestedFix | null {
  const code = error.errorCode || '';
  const stderr = error.stderr || '';

  if (code === 'PLAYWRIGHT_WEBSERVER_TIMEOUT' || /Timed out waiting \d+ms from config\.webServer/i.test(stderr)) {
    // Try to extract the mismatched URL from userFacingMessage so we can show
    // the exact replacement target.
    const urlMatch = (error.userFacingMessage || '').match(/baseURL \((https?:\/\/[^)\s]+)\)/);
    const baseURL = urlMatch?.[1] || 'http://127.0.0.1:<healix-port>/';
    return {
      title: 'Suggested fix — playwright.config `webServer` block is racing Healix',
      file: 'playwright.config.ts',
      steps: [
        {
          action: 'Option A — let Healix own the dev server (recommended)',
          detail: 'Delete the entire `webServer: { ... }` block from playwright.config. Healix already starts the dev server based on the config form.',
        },
        {
          action: 'Option B — align the port',
          detail: `Change \`url\` to match the Healix baseURL and set \`reuseExistingServer: true\`:`,
          code: `webServer: {\n  command: 'npm run dev',\n  url: '${baseURL}',\n  reuseExistingServer: true,\n  timeout: 120000,\n}`,
        },
      ],
    };
  }

  if (code === 'FIXTURE_MODULE_TYPE_MISMATCH') {
    return {
      title: 'Suggested fix — fixture ESM/CJS mismatch',
      steps: [
        { action: 'Re-run Healix', detail: 'Healix now matches the generated fixture body to your project\'s `package.json` `"type"`. Just re-run — no manual edit needed.' },
      ],
    };
  }

  if (code === 'NO_TESTS_TO_RUN') {
    return {
      title: 'Suggested fix — nothing to execute',
      steps: [
        { action: 'Re-run with generation enabled', detail: 'In the Healix config form, toggle "Generate tests" ON, or point Healix at a project that already has `tests/generated/*.spec.ts` files.' },
      ],
    };
  }

  if (code === 'ONLY_FALLBACK_SPECS_EXIST') {
    return {
      title: 'Suggested fix — generation was off, only fallback stubs exist',
      steps: [
        { action: 'Enable "Generate tests" in the config form', detail: 'The specs on disk are generic Healix fallback probes from a prior failed generation — not AC-traced tests. Toggle generation ON before re-submitting.' },
        { action: 'Optional — clear the stale fallbacks first', code: 'rm tests/generated/fallback-*.spec.*' },
      ],
    };
  }

  if (code === 'PLAYWRIGHT_DEPENDENCY_MISSING') {
    return {
      title: 'Suggested fix — install @playwright/test',
      steps: [
        { action: 'Install the dep in the target project', code: 'npm install --save-dev @playwright/test' },
        { action: 'Re-run Healix', detail: 'Once installed, re-run from Cursor.' },
      ],
    };
  }

  if (code === 'WEBAPP_UNREACHABLE') {
    return {
      title: 'Suggested fix — start the Healix webapp',
      steps: [
        { action: 'Boot the webapp', code: 'cd webapp && npm run dev' },
        { action: 'Verify', detail: 'Wait for http://localhost:3000 to serve, then re-run.' },
      ],
    };
  }

  if (code === 'SERVER_START_TIMEOUT') {
    return {
      title: 'Suggested fix — dev server didn\'t come up',
      steps: [
        { action: 'Check the start command and port', detail: 'Re-open the Healix config form and confirm the `start command`, `baseURL`, and `port` all match your project.' },
        { action: 'Try running it manually', detail: 'In a terminal, run the same start command yourself and confirm it binds to the expected port before re-running Healix.' },
      ],
    };
  }

  return null;
}

function SuggestedFixBlock({ error }: { error: PipelineErrorShape }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const fix = buildSuggestedFix(error);
  if (!fix) return null;

  const onCopy = async (code: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="px-5 py-4 border-b border-red-500/10 bg-emerald-500/[0.04]">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="w-6 h-6 rounded-md bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6EE7B7" strokeWidth="2.6">
            <polyline points="9 12 12 15 16 10" /><circle cx="12" cy="12" r="10" />
          </svg>
        </div>
        <div className="text-[12.5px] font-semibold text-[#A7F3D0]">{fix.title}</div>
        {fix.file && (
          <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[10.5px] font-mono">
            {fix.file}
          </span>
        )}
      </div>
      <ol className="space-y-2.5 pl-1">
        {fix.steps.map((step, i) => (
          <li key={i} className="text-[12.5px] text-[#D8E8FF]/90 leading-relaxed">
            <div className="flex items-start gap-2">
              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[#6EE7B7] text-[10px] font-bold flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-[#ECFDF5]">{step.action}</div>
                {step.detail && <div className="text-[#D8E8FF]/80 mt-0.5">{step.detail}</div>}
                {step.code && (
                  <div className="mt-1.5 relative">
                    <pre className="text-[11.5px] text-[#A7F3D0] bg-black/30 border border-emerald-500/15 rounded-md px-3 py-2 font-mono whitespace-pre overflow-x-auto">
{step.code}
                    </pre>
                    <button
                      onClick={() => onCopy(step.code!, i)}
                      className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-[#6EE7B7] text-[10px] font-semibold"
                    >
                      {copiedIdx === i ? 'Copied ✓' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PipelineErrorBanner({ error, runId }: { error: PipelineErrorShape; runId: string }) {
  const [stderrOpen, setStderrOpen] = useState(true);
  const [specOpen, setSpecOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const stage = error.stage || 'unknown';
  const reason = error.reason || 'unknown_reason';
  const code = error.errorCode || null;

  const stageLabel =
    stage === 'validation' ? 'Generated tests failed Playwright validation' :
    stage === 'generation' ? 'Test generation failed' :
    stage === 'server_start' ? 'Dev server failed to start' :
    stage === 'execution' ? 'Playwright run crashed before completion' :
    `Pipeline stage \`${stage}\` failed`;

  const promptForAgent = [
    `Healix pipeline failed at stage: ${stage} (${reason}${code ? ' · ' + code : ''}).`,
    error.userFacingMessage ? `Summary: ${error.userFacingMessage}` : '',
    '',
    'Playwright stderr:',
    '```',
    (error.stderr || '(none)').slice(0, 3000),
    '```',
    error.firstSpecPreview?.lines ? [
      '',
      `First generated spec (${error.firstSpecPreview.file}):`,
      '```ts',
      error.firstSpecPreview.lines,
      '```',
    ].join('\n') : '',
    '',
    'Please diagnose the root cause (dependency, generated-code bug, config) and fix it.',
  ].filter(Boolean).join('\n');

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptForAgent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-2xl overflow-hidden border border-red-500/25 bg-red-500/[0.04]"
      id={`pipeline-error-${runId}`}
    >
      <div className="px-5 py-4 border-b border-red-500/15 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="2.2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-[#FECACA] font-semibold text-[15px]">Healix couldn&apos;t run your tests</div>
            <div className="text-[#F0F6FF]/85 text-sm mt-0.5">{stageLabel}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="px-2 py-0.5 rounded-md bg-red-500/10 border border-red-500/25 text-[#FCA5A5] text-[11px] font-mono">
                stage: {stage}
              </span>
              <span className="px-2 py-0.5 rounded-md bg-red-500/10 border border-red-500/25 text-[#FCA5A5] text-[11px] font-mono">
                reason: {reason}
              </span>
              {code && (
                <span className="px-2 py-0.5 rounded-md bg-red-500/10 border border-red-500/25 text-[#FCA5A5] text-[11px] font-mono">
                  {code}
                </span>
              )}
              {typeof error.generatedSpecCount === 'number' && (
                <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[#D8E8FF]/70 text-[11px] font-mono">
                  generated: {error.generatedSpecCount} spec{error.generatedSpecCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={onCopy}
          className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-[#FCA5A5] text-xs font-semibold transition-colors flex-shrink-0"
        >
          {copied ? 'Copied ✓' : 'Ask Cursor agent to fix'}
        </button>
      </div>

      {error.userFacingMessage && (
        <div className="px-5 py-3 text-[13px] text-[#D8E8FF]/85 border-b border-red-500/10 leading-relaxed">
          {error.userFacingMessage}
        </div>
      )}

      <SuggestedFixBlock error={error} />

      {error.qualityAuditErrors && error.qualityAuditErrors.length > 0 && (
        <div className="px-5 py-3 border-b border-red-500/10">
          <div className="text-[11px] uppercase tracking-wider text-[#FCA5A5] font-semibold mb-1.5">Quality audit errors</div>
          <ul className="text-[12.5px] text-[#D8E8FF]/90 space-y-1 list-disc list-inside">
            {error.qualityAuditErrors.slice(0, 6).map((e, i) => (<li key={i}>{e}</li>))}
          </ul>
        </div>
      )}

      {error.stderr && (
        <div className="border-b border-red-500/10">
          <button
            onClick={() => setStderrOpen(o => !o)}
            className="w-full px-5 py-2.5 text-left text-[11px] uppercase tracking-wider text-[#FCA5A5] font-semibold flex items-center justify-between hover:bg-white/[0.02] transition-colors"
          >
            <span>Playwright stderr</span>
            <span className="text-[#FCA5A5]/70">{stderrOpen ? '▾' : '▸'}</span>
          </button>
          {stderrOpen && (
            <pre className="px-5 pb-4 text-[11.5px] text-[#FECACA]/90 font-mono whitespace-pre-wrap max-h-80 overflow-auto">
{error.stderr}
            </pre>
          )}
        </div>
      )}

      {error.firstSpecPreview?.lines && (
        <div>
          <button
            onClick={() => setSpecOpen(o => !o)}
            className="w-full px-5 py-2.5 text-left text-[11px] uppercase tracking-wider text-[#FCA5A5] font-semibold flex items-center justify-between hover:bg-white/[0.02] transition-colors"
          >
            <span>First generated spec{error.firstSpecPreview.file ? ` — ${error.firstSpecPreview.file}` : ''}</span>
            <span className="text-[#FCA5A5]/70">{specOpen ? '▾' : '▸'}</span>
          </button>
          {specOpen && (
            <pre className="px-5 pb-4 text-[11.5px] text-[#D8E8FF]/90 font-mono whitespace-pre-wrap max-h-80 overflow-auto">
{error.firstSpecPreview.lines}
            </pre>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TestRunDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const isLiveDetailId = String(id || '').startsWith('live-');

  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [overrides, setOverrides] = useState<Record<string, FailureVerdict>>({});
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [groupByCategory, setGroupByCategory] = useState(true);
  const [activePolling, setActivePolling] = useState(true);
  const lastRunSignatureRef = useRef<string | null>(null);
  const pollFailCountRef = useRef(0);

  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [liveFiles, setLiveFiles] = useState<string[]>([]);
  const [liveTestResults, setLiveTestResults] = useState<LiveTestResult[]>([]);
  const [generationJob, setGenerationJob] = useState<GenerationJobSnapshot | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(true);
  const [pipelineEnded, setPipelineEnded] = useState(false);
  const [testResultsOpen, setTestResultsOpen] = useState(true);
  const [overviewOpen, setOverviewOpen] = useState(false);

  const testResultsHeaderRef = useRef<HTMLDivElement>(null);
  const evtSourceRef = useRef<EventSource | null>(null);

  const isLiveOrRunning = useCallback((run: TestRun | null) => {
    if (!run) return false;
    // For real ingested runs trust their status directly.
    // For synthetic live runs (is_live=true) keep polling until the real run appears.
    const status = String(run.status || '').toLowerCase();
    const phase = String(run.current_phase || '').toLowerCase();
    if (run.is_live) return true;
    if (status === 'running') return true;
    return [
      'queued',
      'awaiting_configuration',
      'awaiting_config_ui',
      'config_received',
      'starting_pipeline',
      'started',
      'context',
      'context_enrichment',
      'generating',
      'running',
      'reporting',
      'tests_complete',
    ].includes(phase);
  }, []);

  useEffect(() => {
    if (!id || !isLiveDetailId) return;
    const evtSource = new EventSource(`/api/test-runs/${id}/stream`);
    evtSourceRef.current = evtSource;
    let retryCount = 0;

    evtSource.onmessage = (e: MessageEvent) => {
      retryCount = 0;
      try {
        const data = JSON.parse(e.data) as LiveEvent & {
          type: string;
          generationJob?: GenerationJobSnapshot | null;
        };
        // P2-i: absorb generation-job snapshots (sent on `connected` and on
        // change during poll). Separate from LiveEvent handling — these never
        // go into the liveEvents timeline.
        if (data.type === 'connected' || data.type === 'generation_job') {
          if ('generationJob' in data) {
            setGenerationJob(data.generationJob ?? null);
          }
          return;
        }
        if (data.type === 'event') {
          setLiveEvents(prev => {
            if (prev.some(ev => ev.id === data.id)) return prev;
            return [...prev, data];
          });
          if (data.eventType === 'test_file_generated' && typeof (data.metadata as Record<string, unknown>)?.file === 'string') {
            const file = (data.metadata as Record<string, unknown>).file as string;
            setLiveFiles(prev => prev.includes(file) ? prev : [...prev, file]);
          }
          if (data.eventType === 'test_result' && (data.metadata as Record<string, unknown>)?.test) {
            const t = (data.metadata as Record<string, unknown>).test as LiveTestResult;
            // Playwright emits one test_result per attempt; with retries=2 a single
            // failing test fires up to 3 events. Key on (suite, name, file) and keep
            // the latest outcome so counts reflect distinct tests, not attempts.
            setLiveTestResults(prev => {
              const key = `${t.su ?? ''}::${t.n ?? ''}::${t.f ?? ''}`;
              const idx = prev.findIndex(x => `${x.su ?? ''}::${x.n ?? ''}::${x.f ?? ''}` === key);
              if (idx >= 0) {
                const next = prev.slice();
                next[idx] = t;
                return next;
              }
              return [...prev, t];
            });
          }
          if (data.eventType === 'test_results' && Array.isArray((data.metadata as Record<string, unknown>)?.tests)) {
            const batch = (data.metadata as Record<string, unknown>).tests as LiveTestResult[];
            setLiveTestResults(prev => prev.length === 0 ? batch : prev);
          }
        } else if (data.type === 'done') {
          evtSource.close();
          evtSourceRef.current = null;
          setActivePolling(false);
          setPipelineEnded(true);
          // Final fetch to pick up completed state & report (Fix 1 returns real ingested run)
          fetch(`/api/test-runs/${id}`, { cache: 'no-store' })
            .then(res => res.ok ? res.json() : null)
            .then(json => {
              if (json?.data) {
                setTestRun(json.data);
                setGenerationJob(
                  (json.data as { generationJob?: GenerationJobSnapshot | null }).generationJob ?? null
                );
              }
            })
            .catch(() => {});
        }
      } catch { /* ignore malformed events */ }
    };
    evtSource.onerror = () => {
      retryCount++;
      if (retryCount > 10) {
        evtSource.close();
        evtSourceRef.current = null;
        setActivePolling(false);
      }
      // else: let EventSource auto-reconnect (native browser behavior)
    };
    return () => {
      evtSource.close();
      evtSourceRef.current = null;
    };
  }, [id, isLiveDetailId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!id) return;
    let mounted = true;

    const fetchRun = async (isInitial = false) => {
      if (isInitial) setLoading(true);
      try {
        const res = await fetch(`/api/test-runs/${id}`, { cache: 'no-store' });
        if (!mounted) return;

        if (!res.ok) {
          setNotFound(true);
          setActivePolling(false);
          return;
        }

        const json = await res.json();
        const nextRun = json.data as TestRun;
        const signature = JSON.stringify({
          id: nextRun?.id,
          status: nextRun?.status,
          updated_at: nextRun?.updated_at,
          current_phase: nextRun?.current_phase,
          error_code: nextRun?.error_code,
          total_tests: nextRun?.total_tests,
          passed_tests: nextRun?.passed_tests,
          failed_tests: nextRun?.failed_tests,
          skipped_tests: nextRun?.skipped_tests,
        });

        if (signature !== lastRunSignatureRef.current) {
          lastRunSignatureRef.current = signature;
          setTestRun(nextRun);
        }

        // P2-i: pick up the generation-job snapshot unconditionally so the
        // progress chip renders on initial load for async-backed runs even
        // when SSE isn't attached (non-live-prefixed URLs). Cheap `null` fall-
        // back for sync-mode runs.
        setGenerationJob(
          (json.data as { generationJob?: GenerationJobSnapshot | null }).generationJob ?? null
        );

        // When the real ingested run is returned for a live-prefixed URL,
        // mark the pipeline as ended and close the SSE connection.
        if (isLiveDetailId && nextRun && !nextRun.is_live) {
          setPipelineEnded(true);
          if (evtSourceRef.current) {
            evtSourceRef.current.close();
            evtSourceRef.current = null;
          }
        }

        setNotFound(false);
        setActivePolling(isLiveOrRunning(nextRun));
      } catch {
        if (mounted) {
          setNotFound(true);
          setActivePolling(false);
        }
      } finally {
        if (mounted && isInitial) setLoading(false);
      }
    };

    fetchRun(true);
    return () => {
      mounted = false;
    };
  }, [id, isLiveDetailId, isLiveOrRunning]);

  useEffect(() => {
    if (!id || !activePolling) {
      return;
    }

    const intervalMs = 8000;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      fetch(`/api/test-runs/${id}`, { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) {
            pollFailCountRef.current += 1;
            if (pollFailCountRef.current >= 5) {
              setActivePolling(false);
            }
            return null;
          }
          pollFailCountRef.current = 0;
          return res.json();
        })
        .then((json) => {
          if (!json?.data) return;
          const nextRun = json.data as TestRun;
          const signature = JSON.stringify({
            id: nextRun?.id,
            status: nextRun?.status,
            updated_at: nextRun?.updated_at,
            current_phase: nextRun?.current_phase,
            error_code: nextRun?.error_code,
            total_tests: nextRun?.total_tests,
            passed_tests: nextRun?.passed_tests,
            failed_tests: nextRun?.failed_tests,
            skipped_tests: nextRun?.skipped_tests,
          });
          if (signature !== lastRunSignatureRef.current) {
            lastRunSignatureRef.current = signature;
            setTestRun(nextRun);
          }
          // P2-i: sync the generation-job snapshot on every poll. SSE pushes
          // updates faster for live runs, but non-live runs still get current
          // progress here.
          setGenerationJob(
            (json.data as { generationJob?: GenerationJobSnapshot | null }).generationJob ?? null
          );
          // When the real ingested run is returned for a live-prefixed URL,
          // mark the pipeline as ended and close the SSE connection.
          if (isLiveDetailId && nextRun && !nextRun.is_live) {
            setPipelineEnded(true);
            if (evtSourceRef.current) {
              evtSourceRef.current.close();
              evtSourceRef.current = null;
            }
          }
          setActivePolling(isLiveOrRunning(nextRun));
        })
        .catch(() => {
          pollFailCountRef.current += 1;
          if (pollFailCountRef.current >= 5) {
            setActivePolling(false);
          }
        });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [id, activePolling, isLiveDetailId, isLiveOrRunning]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="max-w-6xl mx-auto flex flex-col gap-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-8 w-24 bg-white/5 rounded-xl animate-pulse" />
          <div className="h-6 w-48 bg-white/5 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card rounded-2xl p-5 h-24 animate-pulse bg-white/[0.02]" />
          ))}
        </div>
        <div className="glass-card rounded-2xl h-64 animate-pulse bg-white/[0.02]" />
      </div>
    );
  }

  // ── Not found ──
  if (notFound || !testRun) {
    return (
      <div className="max-w-6xl mx-auto flex flex-col items-center justify-center py-24 gap-6">
        <div className="w-20 h-20 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
        </div>
        <div className="text-center">
          <div className="text-[#F0F6FF] font-bold text-xl mb-2">Test run not found</div>
          <div className="text-[#4A6280] text-sm">This test run may have been deleted or doesn&apos;t exist.</div>
        </div>
        <Link href="/all-tests" className="btn-gradient text-white font-semibold px-6 py-2.5 rounded-xl text-sm">
          Back to All Tests
        </Link>
      </div>
    );
  }

  // ── Parse report ──
  const report: ReportJson | null = testRun.report_json ?? null;
  const liveMeta = report?.metadata?.live || null;
  const liveRunId = report?.metadata?.runId || report?.metadata?.run_id || testRun.run_id || null;
  const rawTests: ReportTest[] = report?.tests ?? report?.results ?? [];
  const normalisedTests = rawTests.map((t, i) => normaliseTest(t, i, testRun.id));

  // Filter tests — strip synthetic pipeline rows when we have real test data
  const isPipelineSynthetic = (t: NormalisedTest) =>
    (t.suite === 'pipeline' || t.suite === 'Healix') && (t.name.startsWith('[PIPELINE') || t.name.startsWith('[HEALIX'));
  const pipelineError = testRun.pipeline_error ?? null;

  // Partial-generation banner (P1-f): surface budget-exhaustion + per-agent
  // failures that survived as a partial suite. Only render when the MCP
  // actually annotated generationMeta — legacy runs have neither field and
  // the banner stays hidden.
  const generationMeta = (report?.metadata?.generationMeta ?? null) as GenerationMetaShape | null;
  const partialWarning = generationMeta?.partialGenerationWarning ?? null;
  const qualityWarning = generationMeta?.qualityWarning ?? null;
  const videoValidation = (report?.metadata?.videoValidation ?? generationMeta?.videoValidation ?? null) as VideoValidation | null;
  const agentFailuresFromMeta: AgentFailure[] = Array.isArray(generationMeta?.agentFailures)
    ? (generationMeta!.agentFailures as AgentFailure[])
    : [];
  const agentsCompletedFromMeta: string[] = Array.isArray(generationMeta?.agentsCompleted)
    ? (generationMeta!.agentsCompleted as string[])
    : [];
  const agentsRequestedFromMeta: string[] = Array.isArray(generationMeta?.agentsRequested)
    ? (generationMeta!.agentsRequested as string[])
    : [];
  // Banner shows when (a) MCP flagged a budget-exceeded partial, OR
  // (b) no explicit warning but some agents rejected while others landed tests.
  // Hide when pipelineError is set — the red banner already tells the full story.
  const shouldShowPartialBanner =
    !pipelineError &&
    !!generationMeta &&
    (!!partialWarning ||
      (agentFailuresFromMeta.length > 0 && agentsCompletedFromMeta.length > 0));
  const effectiveWarning: PartialGenerationWarning | null = partialWarning
    ? partialWarning
    : shouldShowPartialBanner
    ? {
        reason: 'agent_errors',
        partialsWrittenCount: generationMeta?.partialsWrittenCount,
      }
    : null;
  const hasRealTests = liveTestResults.length > 0 || normalisedTests.some(t => !isPipelineSynthetic(t));
  // When pipeline_error is structured on the run, always hide the synthetic fake-test row
  // in favour of the dedicated banner. Otherwise fall back to legacy behaviour.
  const displayTests = pipelineError
    ? normalisedTests.filter(t => !isPipelineSynthetic(t))
    : (hasRealTests ? normalisedTests.filter(t => !isPipelineSynthetic(t)) : normalisedTests);
  
  // Count of real (non-synthetic) tests for accurate stats
  const realTestsCount = normalisedTests.filter(t => !isPipelineSynthetic(t)).length;

  // Extract generated test count from live events (e.g., "Generated 68 tests across 42 files")
  const generatedTestCount = (() => {
    for (const ev of liveEvents) {
      if (ev.message) {
        const match = ev.message.match(/Generated\s+(\d+)\s+tests/i);
        if (match) return parseInt(match[1], 10);
      }
    }
    return 0;
  })();

  // Use live test results for stats when available (real-time updates)
  const livePassed = liveTestResults.filter(t => t.s === 'passed').length;
  const liveFailed = liveTestResults.filter(t => t.s === 'failed').length;
  const liveSkipped = liveTestResults.filter(t => t.s === 'skipped').length;
  const liveTotal = liveTestResults.length;
  // Only treat live as the primary source while the pipeline is still running.
  // Once pipelineEnded fires, the ingested report (testRun.* / report.stats) is
  // authoritative — preferring live here caused mismatches like All(17)/Passed(14)/Failed(61)
  // because "All" is driven off displayTests while the other pills were driven off
  // liveTotal, which accumulates retry attempts.
  const reportTotal = testRun.total_tests || report?.summary?.total || report?.stats?.total || 0;
  const hasIngestedStats = reportTotal > 0;
  // Treat the pipeline as ended when we already have confirmed ingested results,
  // even if the terminal 'completed' event was missed due to the fire-and-forget
  // race at process exit. This prevents stage:reporting (or any last phase) from
  // staying stuck as a spinning step indefinitely.
  const effectivePipelineEnded = pipelineEnded || (
    isLiveDetailId && Boolean(testRun) && testRun?.is_live === false && hasIngestedStats
  );
  const hasLiveStats = liveTotal > 0 && !(effectivePipelineEnded && hasIngestedStats);

  // Priority: pipeline_error (zero real tests ran) > live (mid-run only) > DB stats > generated > real
  //
  // When the pipeline errored before any test reported, the ingest payload
  // still carries the fake synthetic row in testRun.total_tests / failed_tests.
  // That used to surface as "Total 1 / Failed 1" — misleading because nothing
  // actually ran. With pipeline_error set we zero the counters and let the
  // banner carry the explanation.
  const totalTests = pipelineError
    ? 0
    : (hasLiveStats
        ? liveTotal
        : (reportTotal || generatedTestCount || realTestsCount));
  const passedTests = pipelineError ? 0 : (hasLiveStats ? livePassed : (testRun.passed_tests || report?.summary?.passed || report?.stats?.passed || displayTests.filter(t => ['passed', 'pass'].includes(t.status.toLowerCase())).length));
  const failedTests = pipelineError ? 0 : (hasLiveStats ? liveFailed : (testRun.failed_tests || report?.summary?.failed || report?.stats?.failed || displayTests.filter(t => ['failed', 'fail'].includes(t.status.toLowerCase())).length));
  const skippedTests = pipelineError ? 0 : (hasLiveStats ? liveSkipped : (testRun.skipped_tests || report?.summary?.skipped || report?.stats?.skipped || displayTests.filter(t => ['skipped', 'skip', 'pending'].includes(t.status.toLowerCase())).length));
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  // True while Playwright is executing but no individual results have streamed in yet
  const isRunningPhase = !effectivePipelineEnded && liveEvents.some(e => (e.phase || '').toLowerCase() === 'running');
  const filteredTests = filterStatus === 'all'
    ? displayTests
    : displayTests.filter(t => {
        const s = t.status.toLowerCase();
        if (filterStatus === 'passed') return s === 'passed' || s === 'pass';
        if (filterStatus === 'failed') return s === 'failed' || s === 'fail';
        if (filterStatus === 'skipped') return s === 'skipped' || s === 'skip' || s === 'pending';
        return true;
      });

  // Two-level grouping: mainType → subCat → tests
  const hierarchicalTests: [string, [string, NormalisedTest[]][]][] = (() => {
    if (!groupByCategory) return [];
    const typeMap = new Map<string, Map<string, NormalisedTest[]>>();
    for (const t of filteredTests) {
      const mainType = extractMainType(t.name, t.suite);
      const subCat = extractCategory(t.name);
      if (!typeMap.has(mainType)) typeMap.set(mainType, new Map());
      const subMap = typeMap.get(mainType)!;
      if (!subMap.has(subCat)) subMap.set(subCat, []);
      subMap.get(subCat)!.push(t);
    }
    return [...typeMap.entries()]
      .sort(([a], [b]) => getMainTypeMeta(a).order - getMainTypeMeta(b).order)
      .map(([mainType, subMap]) => [
        mainType,
        [...subMap.entries()].sort(([a], [b]) => {
          if (a === 'uncategorized') return 1;
          if (b === 'uncategorized') return -1;
          return getCategoryMeta(a).label.localeCompare(getCategoryMeta(b).label);
        }),
      ]);
  })();

  // Count artifacts across all tests
  const totalScreenshots = normalisedTests.reduce((sum, t) => sum + t.screenshots.length, 0);
  const totalVideos = normalisedTests.reduce((sum, t) => sum + t.videos.length, 0);
  const totalTraces = normalisedTests.reduce((sum, t) => sum + t.traces.length, 0);

  // AI analysis
  const aiRaw = testRun.ai_analysis;
  const aiAnalysis: AiAnalysisItem[] = (
    Array.isArray(aiRaw)
      ? aiRaw
      : (Array.isArray(aiRaw?.analyses) ? aiRaw.analyses : Array.isArray(aiRaw?.items) ? aiRaw.items : [])
  ).filter((item: AiAnalysisItem) => (
    !!safeString(item?.testName ?? item?.test ?? item?.test_name)
    || !!safeString(item?.analysis)
    || !!safeString(item?.rootCause ?? item?.root_cause)
    || !!safeString(item?.suggestedFix ?? item?.suggested_fix ?? item?.fix)
  ));

  // Failure triage state — merge server rows with optimistic overrides
  const rawFailures: TestFailure[] = Array.isArray(testRun.test_failures) ? testRun.test_failures : [];
  const testFailures: TestFailure[] = rawFailures.map((f) => (
    overrides[f.id] ? { ...f, user_override: overrides[f.id] } : f
  ));
  const failuresByName = new Map<string, TestFailure>();
  for (const f of testFailures) failuresByName.set(f.test_name, f);

  const failureClusters = (() => {
    const byCluster = new Map<string, TestFailure[]>();
    for (const f of testFailures) {
      if (!f.cluster_id) continue;
      if (!byCluster.has(f.cluster_id)) byCluster.set(f.cluster_id, []);
      byCluster.get(f.cluster_id)!.push(f);
    }
    return Array.from(byCluster.entries())
      .filter(([, members]) => members.length >= 3)
      .map(([clusterId, members]) => ({ clusterId, members }));
  })();

  const handleOverride = (failureId: string, verdict: FailureVerdict) => {
    setOverrides((prev) => ({ ...prev, [failureId]: verdict }));
  };

  const formattedDate = new Date(testRun.created_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  }) + ' at ' + new Date(testRun.created_at).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-6xl mx-auto flex flex-col gap-6">
      {/* Back + header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3">
        <Link href="/all-tests" className="inline-flex items-center gap-2 text-[#4A6280] hover:text-[#F0F6FF] text-sm transition-colors w-fit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Back to All Tests
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-[#F0F6FF] font-bold text-2xl">{testRun.creation_name || 'Test Run'}</h1>
            <p className="text-[#4A6280] text-sm mt-0.5">{formattedDate}</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <GenerationJobProgressChip job={generationJob} />
            {testRun.source && (
              <span className="px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[#60A5FA] text-xs font-semibold uppercase tracking-wider">
                {testRun.source}
              </span>
            )}
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
              testRun.status === 'passed' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              : testRun.status === 'failed' ? 'bg-red-500/10 border border-red-500/20 text-red-400'
              : testRun.status === 'running' ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
              : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
            }`}>
              {testRun.status}
            </span>
          </div>
        </div>
      </motion.div>

      {pipelineError && (
        <PipelineErrorBanner error={pipelineError as PipelineErrorShape} runId={testRun.id} />
      )}

      {shouldShowPartialBanner && effectiveWarning && (
        <PartialGenerationBanner
          warning={effectiveWarning}
          agentFailures={agentFailuresFromMeta}
          agentsCompleted={agentsCompletedFromMeta}
          agentsRequested={agentsRequestedFromMeta}
        />
      )}

      {!pipelineError && qualityWarning && qualityWarning.suggestions?.length > 0 && (
        <QualityWarningBanner warning={qualityWarning} />
      )}

      {!pipelineError && videoValidation?.ok === false && (
        <VideoValidationBanner validation={videoValidation} />
      )}

      {Array.isArray(generationMeta?.agentMeta) && generationMeta!.agentMeta!.length > 0 && (
        <AgentCoveragePanel agentMeta={generationMeta!.agentMeta!} />
      )}

      {(testRun.is_live || !!liveMeta || !!testRun.current_phase || !!testRun.error_code || liveEvents.length > 0) && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card rounded-2xl overflow-hidden border border-blue-500/20 bg-blue-500/[0.03]"
        >
          {/* Header — clickable to collapse/expand */}
          <button
            onClick={() => setPipelineOpen(o => !o)}
            className="w-full px-5 py-3.5 border-b border-white/8 flex items-center justify-between gap-3 text-left hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                effectivePipelineEnded
                  ? 'bg-emerald-500/10 border border-emerald-500/30'
                  : 'bg-blue-500/10 border border-blue-500/20'
              }`}>
                {effectivePipelineEnded ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse" />
                )}
              </div>
              <div>
                <div className="text-[#D8E8FF] font-semibold text-sm">Healix Activity</div>
                <div className="text-[#4A6280] text-[11px] font-mono">
                  {effectivePipelineEnded ? 'completed' : (testRun.current_phase || liveMeta?.phase || testRun.status)}
                  {testRun.error_code || liveMeta?.errorCode ? ` · error: ${testRun.error_code || liveMeta?.errorCode}` : ''}
                  {liveRunId ? ` · run: ${liveRunId}` : ''}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {liveEvents.length > 0 && (() => {
                const pipelineCount = (() => {
                  const seen = new Set<string>();
                  for (const e of liveEvents) {
                    if (e.eventType !== 'test_results' && e.eventType !== 'test_file_generated' && e.eventType !== 'test_result') {
                      seen.add(e.phase ?? '__unknown__');
                    }
                  }
                  return seen.size;
                })();
                return (
                  <div className="flex items-center gap-1.5">
                    <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-semibold">
                      {pipelineCount} step{pipelineCount !== 1 ? 's' : ''}
                    </span>
                    {liveFiles.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[10px] font-semibold">
                        {liveFiles.length} file{liveFiles.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                );
              })()}
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`text-[#4A6280] transition-transform duration-200 flex-shrink-0 ${pipelineOpen ? 'rotate-180' : ''}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </button>

          <AnimatePresence initial={false}>
            {pipelineOpen && (
              <motion.div
                key="pipeline-body"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                style={{ overflow: 'hidden' }}
              >
                {/* SSE timeline */}
                {liveEvents.length > 0 ? (
                  <div className="px-5 py-4">
                    <LiveTimeline events={liveEvents} liveFiles={liveFiles} pipelineEnded={effectivePipelineEnded} />
                  </div>
                ) : (
                  (liveMeta?.message || liveMeta?.reason) && (
                    <div className="px-5 py-3 text-[#BFD4F2] text-xs">
                      {liveMeta?.message || liveMeta?.reason}
                    </div>
                  )
                )}

                {/* Generated Files — standalone section, shown when no tests_generated event */}
                {liveFiles.length > 0 && !liveEvents.some(e => e.eventType === 'tests_generated') && !liveEvents.some(e => (e.phase || '').toLowerCase() === 'generating') && (
                  <div className="border-t border-white/8 px-5 py-3">
                    <div className="text-[#4A6280] text-[10px] font-semibold uppercase tracking-wider mb-2">
                      Generated Files ({liveFiles.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {liveFiles.map((f, fi) => (
                        <motion.span
                          key={f}
                          initial={{ opacity: 0, scale: 0.8, y: 4 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          transition={{ duration: 0.2, delay: fi * 0.055 }}
                          className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300/80 text-[10px] font-mono"
                        >
                          {f}
                        </motion.span>
                      ))}
                    </div>
                  </div>
                )}

                {/* End-of-testing banner */}
                {effectivePipelineEnded && (
                  <div className="border-t border-white/8 px-5 py-3 flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    <span className="text-emerald-400 text-xs font-semibold">Healix run complete</span>
                    {liveTotal > 0 && (
                      <span className="text-[#4A6280] text-xs">— {livePassed}/{liveTotal} tests passed ({Math.round((livePassed / liveTotal) * 100)}%)</span>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* KPI cards */}
      {isRunningPhase && !hasLiveStats && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-500/5 border border-blue-500/15 w-fit"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
          <span className="text-blue-300/70 text-xs font-medium">Tests executing — results will stream in as they complete</span>
        </motion.div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <KpiCard label="Total Tests" value={totalTests} color="text-[#F0F6FF]" delay={0} />
        <KpiCard label="Passed" value={passedTests} color="text-emerald-400" delay={80} loading={isRunningPhase && !hasLiveStats} />
        <KpiCard label="Failed" value={failedTests} color="text-red-400" delay={160} loading={isRunningPhase && !hasLiveStats} />
        <KpiCard label="Skipped" value={skippedTests} color="text-amber-400" delay={240} loading={isRunningPhase && !hasLiveStats} />
        <KpiCard label="Pass Rate" value={passRate} sub="%" color={passRate >= 70 ? 'text-emerald-400' : passRate >= 40 ? 'text-amber-400' : 'text-red-400'} delay={320} loading={isRunningPhase && !hasLiveStats} />
      </div>

      {/* Tier pills (Phase D) — Tier A/B/C segmentation from MCP. Only shown
          when the run reported a tier breakdown. */}
      {testRun.tier_results && Object.keys(testRun.tier_results).length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-[#8DA0BC]/70 font-medium">Tiered execution</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(testRun.tier_results).map(([tier, counts]) => {
              const label =
                tier === 'A-public' ? 'Tier A · public'
                : tier.startsWith('B-auth-') ? `Tier B · ${tier.replace('B-auth-', '')}`
                : tier === 'C-backend' ? 'Tier C · backend'
                : tier === 'untiered' ? 'Untiered'
                : tier;
              const tone =
                counts.failed > 0 ? 'border-red-500/40 bg-red-500/10 text-red-200'
                : counts.blocked > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : counts.passed > 0 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-white/10 bg-white/5 text-[#8DA0BC]';
              const parts: string[] = [];
              if (counts.passed) parts.push(`${counts.passed} passed`);
              if (counts.failed) parts.push(`${counts.failed} failed`);
              if (counts.blocked) parts.push(`${counts.blocked} blocked`);
              if (counts.skipped) parts.push(`${counts.skipped} skipped`);
              return (
                <div key={tier} className={`px-3 py-1.5 rounded-full text-xs font-medium border ${tone}`}>
                  <span className="opacity-80 mr-2">{label}</span>
                  <span>{parts.length > 0 ? parts.join(' · ') : `${counts.total} tests`}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Results by Section */}
      {totalTests > 0 && (() => {
        const sourceTests = hasLiveStats
          ? liveTestResults.map(t => ({ name: t.n, suite: t.su, status: t.s }))
          : displayTests.map(t => ({ name: t.name, suite: t.suite, status: t.status }));

        type Counts = { passed: number; failed: number; skipped: number };
        const sectionMap = new Map<string, { totals: Counts; subs: Map<string, Counts> }>();
        for (const t of sourceTests) {
          const mainKey = extractMainType(t.name, t.suite);
          const subKey = extractCategory(t.name);
          if (!sectionMap.has(mainKey)) sectionMap.set(mainKey, { totals: { passed: 0, failed: 0, skipped: 0 }, subs: new Map() });
          const section = sectionMap.get(mainKey)!;
          if (!section.subs.has(subKey)) section.subs.set(subKey, { passed: 0, failed: 0, skipped: 0 });
          const s = t.status.toLowerCase();
          const increment = (c: Counts) => { if (s === 'passed' || s === 'pass') c.passed++; else if (s === 'failed' || s === 'fail') c.failed++; else c.skipped++; };
          increment(section.totals);
          increment(section.subs.get(subKey)!);
        }

        const sections = [...sectionMap.entries()]
          .sort(([a], [b]) => getMainTypeMeta(a).order - getMainTypeMeta(b).order);

        if (sections.length === 0) return null;

        const sectionData: SectionDatum[] = sections.map(([mainKey, { totals, subs }]) => ({
          key: mainKey,
          totals,
          subs: [...subs.entries()]
            .filter(([k]) => k !== 'uncategorized')
            .sort(([a], [b]) => getCategoryMeta(a).label.localeCompare(getCategoryMeta(b).label))
            .map(([k, counts]) => ({ key: k, counts })),
        }));

        return (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="glass-card rounded-2xl p-5">
            <button
              onClick={() => setOverviewOpen(o => !o)}
              className="w-full flex items-center justify-between mb-0 group"
            >
              <h2 className="text-[#F0F6FF] font-semibold text-sm">Overview</h2>
              <div className="flex items-center gap-2">
                <span className="text-[#4A6280] text-xs">{overviewOpen ? 'Click to collapse' : 'Click to expand'}</span>
                <motion.svg
                  animate={{ rotate: overviewOpen ? 0 : -90 }}
                  transition={{ duration: 0.2 }}
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className="text-[#4A6280] flex-shrink-0"
                >
                  <polyline points="6 9 12 15 18 9" />
                </motion.svg>
              </div>
            </button>
            <AnimatePresence initial={false}>
              {overviewOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="mt-3">
                    <SectionOverview sections={sectionData} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })()}

      {/* Artifacts summary */}
      {(totalScreenshots + totalVideos + totalTraces) > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }} className="glass-card rounded-2xl p-5">
          <h2 className="text-[#F0F6FF] font-semibold text-sm mb-3">Test Artifacts</h2>
          <div className="flex items-center gap-4">
            {totalScreenshots > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/5 border border-blue-500/15">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                <span className="text-[#60A5FA] text-sm font-medium">{totalScreenshots} screenshot{totalScreenshots !== 1 ? 's' : ''}</span>
              </div>
            )}
            {totalVideos > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-500/5 border border-purple-500/15">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                <span className="text-[#A78BFA] text-sm font-medium">{totalVideos} video{totalVideos !== 1 ? 's' : ''}</span>
              </div>
            )}
            {totalTraces > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/5 border border-amber-500/15">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                <span className="text-[#FBBF24] text-sm font-medium">{totalTraces} trace{totalTraces !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Test results table */}
      {report === null ? (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="glass-card rounded-2xl p-8 flex flex-col items-center justify-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-[#F0F6FF] font-semibold mb-1">Report data not available</div>
            <div className="text-[#4A6280] text-sm">No detailed report was saved for this test run.</div>
          </div>
        </motion.div>
      ) : displayTests.length > 0 ? (
        <>
        {failureClusters.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <FailureClusterBanner clusters={failureClusters} />
          </motion.div>
        )}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="glass-card rounded-2xl overflow-hidden">
          {/* Header with collapse toggle */}
          <div ref={testResultsHeaderRef} className="px-6 py-4 border-b border-white/8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <button
              onClick={() => setTestResultsOpen(o => !o)}
              className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
            >
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`text-[#4A6280] transition-transform duration-200 flex-shrink-0 ${testResultsOpen ? 'rotate-180' : ''}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <div>
                <h2 className="text-[#F0F6FF] font-semibold text-base">Test Results</h2>
                <p className="text-[#4A6280] text-xs mt-0.5">{totalTests} individual tests — click a row to expand details</p>
              </div>
            </button>
            {/* Filter + Group buttons */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(['all', 'passed', 'failed', 'skipped'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilterStatus(f)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                    filterStatus === f
                      ? f === 'passed' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : f === 'failed' ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : f === 'skipped' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-white/10 text-[#F0F6FF] border border-white/20'
                      : 'bg-white/5 text-[#4A6280] border border-transparent hover:border-white/10'
                  }`}
                >
                  {f === 'all' ? `All (${totalTests})` : f === 'passed' ? `Passed (${passedTests})` : f === 'failed' ? `Failed (${failedTests})` : `Skipped (${skippedTests})`}
                </button>
              ))}
              <div className="w-px h-4 bg-white/10 mx-1" />
              <button
                onClick={() => setGroupByCategory(g => !g)}
                title="Group tests by category"
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all border ${
                  groupByCategory
                    ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                    : 'bg-white/5 text-[#4A6280] border-transparent hover:border-white/10'
                }`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                Group
              </button>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {testResultsOpen && (
              <motion.div
                key="test-results-body"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-white/5">
                        <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Test Name</th>
                        <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Suite / File</th>
                        <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                        <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Duration</th>
                        <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Artifacts</th>
                      </tr>
                    </thead>
                    {groupByCategory ? (
                      hierarchicalTests.map(([mainType, subGroups]) => (
                        <MainTypeGroup
                          key={mainType}
                          mainType={mainType}
                          subGroups={subGroups}
                          aiAnalysis={aiAnalysis}
                          failuresByName={failuresByName}
                          runId={testRun.id}
                          onOverride={handleOverride}
                        />
                      ))
                    ) : (
                      <tbody>
                        {filteredTests.map((t, i) => (
                          <TestRow
                            key={i}
                            t={t}
                            idx={i}
                            aiAnalysis={aiAnalysis}
                            failure={failuresByName.get(t.name) ?? undefined}
                            runId={testRun.id}
                            onOverride={handleOverride}
                          />
                        ))}
                      </tbody>
                    )}
                  </table>
                </div>
                {filteredTests.length === 0 && (
                  <div className="px-6 py-8 text-center text-[#4A6280] text-sm">No tests match the selected filter.</div>
                )}
                
                {/* Footer collapse toggle */}
                <button
                  onClick={() => {
                    setTestResultsOpen(false);
                    setTimeout(() => {
                      testResultsHeaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 100);
                  }}
                  className="w-full px-6 py-3 border-t border-white/8 flex items-center justify-center gap-2 text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/[0.02] transition-colors text-xs font-medium"
                >
                  <span>Collapse Test Results</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
        </>
      ) : null}

      {/* Duration footer — `duration_ms && (...)` would render a literal "0"
          when a pipeline_error run ends with duration_ms === 0, so we coerce
          to boolean explicitly. */}
      {typeof testRun.duration_ms === 'number' && testRun.duration_ms > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="text-center text-[#4A6280] text-xs pb-4">
          Total run duration: {(testRun.duration_ms / 1000).toFixed(2)}s
        </motion.div>
      )}
    </motion.div>
  );
}
