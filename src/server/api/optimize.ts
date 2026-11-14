/**
 * Prompt optimization API
 *
 * POST /api/optimize — rewrite the composer's prompt with the active provider's
 * small model, preserving the original intent and language.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { ProviderService } from '../services/providerService.js'
import { providerTextCompletion } from '../services/providerTextCompletion.js'
import { isOpenAIOfficialProviderId } from '../services/openaiOfficialProvider.js'
import { isDeepSeekAccountProviderId } from '../services/deepseekAccountProvider.js'
import type { SavedProvider } from '../types/provider.js'

const MAX_PROMPT_LENGTH = 8000
const OPTIMIZE_MAX_OUTPUT_TOKENS = 4096
const OPTIMIZE_TIMEOUT_MS = 60_000

const SYSTEM_PROMPT = [
  'You are a prompt editor. Rewrite the user\'s prompt so it is clearer, more specific and more detailed.',
  'Preserve the original intent and the original language.',
  'Add missing context only when it can be inferred from the prompt; do not invent requirements.',
  'Structure multi-part requests. Resolve ambiguous wording.',
  'Output ONLY the improved prompt text — no explanations, prefixes, or quotes.',
].join('\n')

function buildUserContent(prompt: string): string {
  return [
    'Improve the following prompt. Make it clearer, more specific, and more detailed while preserving the original intent.',
    '',
    'Output ONLY the improved prompt text — no explanations or prefixes.',
    '',
    '<prompt>',
    prompt,
    '</prompt>',
  ].join('\n')
}

async function resolveActiveProvider(): Promise<SavedProvider | null> {
  const providerService = new ProviderService()
  const { activeId, providers } = await providerService.listProviders()
  if (!activeId) return null

  if (isOpenAIOfficialProviderId(activeId) || isDeepSeekAccountProviderId(activeId)) {
    return providerService.getProvider(activeId)
  }
  return providers.find((provider) => provider.id === activeId) ?? null
}

export async function handleOptimizeApi(req: Request, _url: URL, _segments: string[]): Promise<Response> {
  try {
    if (req.method !== 'POST') {
      return Response.json(
        { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
        { status: 405 },
      )
    }

    const body = await parseJsonBody(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw ApiError.badRequest('prompt is required')
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw ApiError.badRequest(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
    }
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined

    const provider = await resolveActiveProvider()
    if (!provider) {
      return Response.json(
        { error: 'NO_ACTIVE_PROVIDER', message: 'No active provider is configured' },
        { status: 409 },
      )
    }

    const result = await providerTextCompletion({
      provider,
      modelId: provider.models.haiku || provider.models.main,
      system: SYSTEM_PROMPT,
      user: buildUserContent(prompt),
      maxTokens: OPTIMIZE_MAX_OUTPUT_TOKENS,
      timeoutMs: OPTIMIZE_TIMEOUT_MS,
      // The default per-attempt limit is 15s (sized for titles); a rewrite can
      // legitimately take longer, and the overall budget is the real deadline.
      attemptTimeoutMs: OPTIMIZE_TIMEOUT_MS,
      sessionId,
    })

    if (!result.ok) {
      console.error('[Optimize] provider call failed', {
        provider: provider.id,
        reason: result.reason,
        status: result.status,
        message: result.message,
      })
      const status = result.status ? `HTTP ${result.status}: ` : ''
      return Response.json(
        {
          error: 'OPTIMIZE_UPSTREAM_ERROR',
          message: `${status}${result.message}`,
        },
        { status: 502 },
      )
    }

    const optimized = result.text.trim()
    if (!optimized) {
      console.error('[Optimize] provider returned no text block', { provider: provider.id })
      return Response.json(
        { error: 'OPTIMIZE_EMPTY_RESPONSE', message: 'The provider did not return an optimized prompt' },
        { status: 502 },
      )
    }

    return Response.json({ optimized })
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw ApiError.badRequest('Invalid JSON body')
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid JSON body')
  }
}
