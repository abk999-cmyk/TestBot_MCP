import { z } from 'zod'

export const ACTION_TYPES = [
  'goto',
  'click',
  'fill',
  'select',
  'assertVisible',
  'assertText',
  'assertURL',
  'apiRequest',
  'finish',
] as const

export const SequentialActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  url: z.string().optional(),
  path: z.string().optional(),
  method: z.string().optional(),
  locatorCandidates: z.array(z.union([
    z.string(),
    z.object({
      type: z.string().optional(),
      value: z.string().optional(),
      name: z.string().optional(),
      selector: z.string().optional(),
      exact: z.boolean().optional(),
    }).passthrough(),
  ])).optional(),
  value: z.string().optional(),
  text: z.string().optional(),
  pattern: z.string().optional(),
  expectedStatus: z.number().optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().min(500).max(30000).optional(),
  rationale: z.string().max(1000).optional(),
  summary: z.string().max(1000).optional(),
}).passthrough()

export type SequentialAction = z.infer<typeof SequentialActionSchema>

export const TestCaseSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(300),
  kind: z.string().max(80).optional(),
  path: z.string().max(500).optional(),
  role: z.string().nullable().optional(),
  objective: z.string().max(4000).optional(),
  acIds: z.array(z.string()).optional(),
  source: z.string().optional(),
}).passthrough()

export const ObservationSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  controls: z.array(z.unknown()).optional(),
  screenshotPath: z.string().nullable().optional(),
}).passthrough()

export const TurnHistorySchema = z.array(z.object({
  turn: z.number().optional(),
  action: z.unknown().optional(),
  status: z.string().optional(),
  error: z.string().nullable().optional(),
  source: z.string().optional(),
}).passthrough()).max(50)

export const NextActionRequestSchema = z.object({
  testCase: TestCaseSchema,
  observation: ObservationSchema,
  history: TurnHistorySchema.optional().default([]),
  lastError: z.string().nullable().optional(),
  projectInfo: z.record(z.unknown()).optional().default({}),
  roles: z.array(z.unknown()).optional().default([]),
  options: z.record(z.unknown()).optional().default({}),
})

export const SynthesizeSpecRequestSchema = z.object({
  testCase: TestCaseSchema,
  trace: z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    turns: z.array(z.unknown()).optional().default([]),
  }).passthrough(),
  projectInfo: z.record(z.unknown()).optional().default({}),
  roles: z.array(z.unknown()).optional().default([]),
  options: z.record(z.unknown()).optional().default({}),
})

export function extractJsonObject(text: string): unknown {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('empty response')
  try {
    return JSON.parse(raw)
  } catch {
    // fall through
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // fall through
    }
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1))
  }
  throw new Error('response did not contain a JSON object')
}

export function fallbackActionForRequest(input: z.infer<typeof NextActionRequestSchema>): SequentialAction {
  const turnCount = input.history?.length || 0
  const kind = String(input.testCase.kind || 'ui')
  if (kind === 'api') {
    if (turnCount === 0) {
      return { type: 'apiRequest', method: 'GET', path: input.testCase.path || '/', rationale: 'Probe API endpoint.' }
    }
    return { type: 'finish', summary: 'API endpoint probe completed.' }
  }
  if (turnCount === 0) {
    return { type: 'goto', path: input.testCase.path || '/', rationale: 'Open target page.' }
  }
  if (turnCount === 1) {
    return { type: 'assertVisible', locatorCandidates: ['main', 'body'], rationale: 'Verify page content is visible.' }
  }
  return { type: 'finish', summary: 'Sequential smoke case completed.' }
}

export function sanitizeFilename(value: string, fallback: string): string {
  const base = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback
  return /\.spec\.(ts|js)$/i.test(base) ? base : `${base}.spec.ts`
}
