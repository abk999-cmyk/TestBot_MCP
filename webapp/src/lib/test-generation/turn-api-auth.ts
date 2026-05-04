import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkTokenBalance } from '@/lib/tokens'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkAiGuard } from '@/lib/ai-guard'
import { logBlockedRequest } from '@/lib/security-logger'

export async function authenticateTurnRequest(
  request: NextRequest,
  body: Record<string, unknown>,
  endpoint: string,
) {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false as const, response: NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 }) }
  }

  const rawKey = request.headers.get('x-api-key') ?? null
  const apiKey = typeof rawKey === 'string' ? rawKey : typeof body?.api_key === 'string' ? body.api_key : ''
  if (!apiKey) {
    logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint })
    return { ok: false as const, response: NextResponse.json({ error: 'Missing api_key' }, { status: 401 }) }
  }

  const keyHash = hashApiKey(apiKey)
  const [apiKeyRecord] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      isActive: apiKeys.isActive,
      revoked: apiKeys.revoked,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1)

  if (!apiKeyRecord) {
    logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint })
    return { ok: false as const, response: NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 }) }
  }
  if (apiKeyRecord.revoked) {
    logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint })
    return { ok: false as const, response: NextResponse.json({ error: 'API key has been revoked' }, { status: 401 }) }
  }
  if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
    logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint })
    return { ok: false as const, response: NextResponse.json({ error: 'API key has expired' }, { status: 401 }) }
  }

  const userId = apiKeyRecord.userId
  const rate = await checkRateLimit({ keyHash, userId, endpoint })
  if (!rate.allowed) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'RATE_LIMIT_EXCEEDED' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 1) } }),
    }
  }

  const concurrency = await checkConcurrencyLimit({ userId, endpoint })
  if (!concurrency.allowed) {
    return { ok: false as const, response: NextResponse.json({ error: 'CONCURRENT_LIMIT_EXCEEDED' }, { status: 429 }) }
  }

  const aiGuard = await checkAiGuard({ userId, endpoint })
  if (!aiGuard.allowed) {
    return { ok: false as const, response: NextResponse.json({ error: 'RATE_LIMIT_EXCEEDED' }, { status: 429 }) }
  }

  const tokenCheck = await checkTokenBalance({ userId, endpoint })
  if (!tokenCheck.allowed) {
    return { ok: false as const, response: NextResponse.json({ error: 'No tokens remaining. Please renew your plan.' }, { status: 402 }) }
  }

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, apiKeyRecord.id))

  return { ok: true as const, apiKeyRecord, userId }
}
