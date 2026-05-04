import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { OpenAIClient } from '@/lib/test-generation/openai-client'
import { deductTokens } from '@/lib/tokens'
import { recordAiCall } from '@/lib/ai-guard'
import {
  NextActionRequestSchema,
  SequentialActionSchema,
  extractJsonObject,
  fallbackActionForRequest,
} from '@/lib/test-generation/turn-contract'
import { authenticateTurnRequest } from '@/lib/test-generation/turn-api-auth'

const ENDPOINT = '/api/test-turns/next-action'
export const maxDuration = 240

function buildPrompt(input: z.infer<typeof NextActionRequestSchema>) {
  return [
    {
      role: 'system' as const,
      content: `You are the Healix sequential test driver. Return JSON only.

Choose exactly one next browser/API action for the current test case based on the live observation and prior failures.
Allowed action types: goto, click, fill, select, assertVisible, assertText, assertURL, apiRequest, finish.
Rules:
- Prefer repairable, small actions. Do not generate a full test file.
- Use locatorCandidates as an ordered array. Prefer stable CSS, role/text, label, placeholder, and testid selectors.
- For same-app navigation, prefer relative path values like "/login" instead of absolute localhost URLs.
- If the case is already proven, return {"type":"finish","summary":"..."}.
- If lastError is present, propose a repaired action, not the same failing action.
- Do not include credentials unless the current case is an auth setup case and the client already supplied them in context.

Return shape:
{"action":{"type":"goto","path":"/login","rationale":"..."}}`,
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        testCase: input.testCase,
        observation: input.observation,
        history: input.history,
        lastError: input.lastError || null,
        projectInfo: input.projectInfo,
        roles: input.roles,
      }).slice(0, 24000),
    },
  ]
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await request.json()
    const auth = await authenticateTurnRequest(request, body, ENDPOINT)
    if (!auth.ok) return auth.response

    const parsed = NextActionRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_TURN_REQUEST', issues: parsed.error.issues }, { status: 422 })
    }

    const client = new OpenAIClient({
      apiKey: process.env.OPENAI_API_KEY!,
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      timeout: Number(process.env.HEALIX_TURN_OPENAI_TIMEOUT_MS) || 120_000,
      maxTokens: 1800,
      temperature: 0.1,
    })

    let action = fallbackActionForRequest(parsed.data)
    let source = 'fallback'
    let tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let modelUsed: string | null = null

    try {
      const result = await client.callOpenAI(buildPrompt(parsed.data))
      tokenUsage = result.usage
      modelUsed = result.modelUsed
      const json = extractJsonObject(result.text) as { action?: unknown }
      const candidate = SequentialActionSchema.safeParse(json.action ?? json)
      if (candidate.success) {
        action = candidate.data
        source = 'openai'
      }
    } catch (err) {
      source = `fallback:${err instanceof Error ? err.message : 'openai_error'}`
    }

    if (tokenUsage.totalTokens > 0) {
      await deductTokens({ userId: auth.userId, tokensUsed: tokenUsage.totalTokens })
      await recordAiCall({
        userId: auth.userId,
        apiKeyId: auth.apiKeyRecord.id,
        endpoint: ENDPOINT,
        agent: 'sequential-turn',
        latencyMs: Date.now() - startedAt,
        modelUsed: modelUsed ?? undefined,
        tokensPrompt: tokenUsage.promptTokens,
        tokensCompletion: tokenUsage.completionTokens,
        tokensTotal: tokenUsage.totalTokens,
        success: source === 'openai',
        errorCode: source === 'openai' ? null : 'TURN_FALLBACK',
        runId: request.headers.get('x-healix-run-id') || null,
      })
    }

    return NextResponse.json({ success: true, action, source, tokenUsage })
  } catch (error) {
    console.error('[test-turns/next-action] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
