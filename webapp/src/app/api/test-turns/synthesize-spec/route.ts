import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { OpenAIClient } from '@/lib/test-generation/openai-client'
import { deductTokens } from '@/lib/tokens'
import { recordAiCall } from '@/lib/ai-guard'
import {
  SynthesizeSpecRequestSchema,
  extractJsonObject,
  sanitizeFilename,
} from '@/lib/test-generation/turn-contract'
import { authenticateTurnRequest } from '@/lib/test-generation/turn-api-auth'

const ENDPOINT = '/api/test-turns/synthesize-spec'
export const maxDuration = 240

const SpecSchema = z.object({
  filename: z.string().min(1).max(180),
  content: z.string().min(1).max(200000),
})

function buildPrompt(input: z.infer<typeof SynthesizeSpecRequestSchema>) {
  return [
    {
      role: 'system' as const,
      content: `You are the Healix sequential spec synthesizer. Return JSON only.

Convert the successful turn trace into one deterministic Playwright TypeScript spec file.
Rules:
- Import from the Healix fixture: import { test, expect } from './__healix-fixture';
- Do not invent new actions beyond the trace.
- Prefer stable locators from each action's locatorCandidates.
- Include at least one expect assertion.
- Do not use waitForTimeout, Math.random, Date.now, test.use, or swallowed catches.
- Return {"filename":"name.spec.ts","content":"full spec content"}.`,
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        testCase: input.testCase,
        trace: input.trace,
        projectInfo: input.projectInfo,
        roles: input.roles,
      }).slice(0, 30000),
    },
  ]
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await request.json()
    const auth = await authenticateTurnRequest(request, body, ENDPOINT)
    if (!auth.ok) return auth.response

    const parsed = SynthesizeSpecRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_SYNTHESIS_REQUEST', issues: parsed.error.issues }, { status: 422 })
    }

    const client = new OpenAIClient({
      apiKey: process.env.OPENAI_API_KEY!,
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      timeout: Number(process.env.HEALIX_TURN_OPENAI_TIMEOUT_MS) || 120_000,
      maxTokens: 4000,
      temperature: 0,
    })

    const result = await client.callOpenAI(buildPrompt(parsed.data))
    const json = extractJsonObject(result.text) as unknown
    const specResult = SpecSchema.safeParse(json)
    if (!specResult.success) {
      return NextResponse.json(
        { error: 'INVALID_SYNTHESIZED_SPEC', issues: specResult.error.issues },
        { status: 422 },
      )
    }

    const spec = {
      filename: sanitizeFilename(specResult.data.filename, `${parsed.data.testCase.id}.spec.ts`),
      content: specResult.data.content,
    }

    if (result.usage.totalTokens > 0) {
      await deductTokens({ userId: auth.userId, tokensUsed: result.usage.totalTokens })
      await recordAiCall({
        userId: auth.userId,
        apiKeyId: auth.apiKeyRecord.id,
        endpoint: ENDPOINT,
        agent: 'sequential-synthesis',
        latencyMs: Date.now() - startedAt,
        modelUsed: result.modelUsed,
        tokensPrompt: result.usage.promptTokens,
        tokensCompletion: result.usage.completionTokens,
        tokensTotal: result.usage.totalTokens,
        success: true,
        runId: request.headers.get('x-healix-run-id') || null,
      })
    }

    return NextResponse.json({ success: true, spec, source: 'openai', tokenUsage: result.usage })
  } catch (error) {
    console.error('[test-turns/synthesize-spec] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
