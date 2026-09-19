/**
 * Prompt optimization API — rewrites the composer's text into a clearer, more
 * specific prompt before the user sends it.
 *
 * The model call goes through `providerCompletion`, which is the same path the
 * session-title generator uses. Going straight at `baseUrl/v1/messages` with an
 * Anthropic SDK client looks simpler and is wrong for every provider whose
 * preset speaks OpenAI's wire format, and for the OAuth-backed official
 * providers.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  completeWithProvider,
  resolveCompletionProvider,
  type CompletionFailure,
} from '../services/providerCompletion.js'

/** Roughly a screenful of prose — past this the model is rewriting an essay. */
const MAX_PROMPT_LENGTH = 8000
const OPTIMIZE_MAX_OUTPUT_TOKENS = 4096
const OPTIMIZE_TIMEOUT_MS = 60_000

const OPTIMIZE_SYSTEM_PROMPT = `You are a prompt optimization assistant. Your task is to improve the user's prompt to make it clearer, more specific, and more likely to produce high-quality results.

Rules:
1. Preserve the original intent — do NOT change what the user is asking for
2. Add necessary context and specificity if the prompt is vague
3. Remove ambiguity and clarify any unclear requests
4. Structure the prompt logically (e.g., numbered steps for multi-part requests)
5. Keep the optimized prompt concise — only add what's truly needed
6. Stay in the language the user wrote in
7. Output ONLY the optimized prompt text — no explanations, no markdown fences, no prefixes`

export async function handleOptimizeApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'POST') {
      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    }

    const body = await parseJsonBody(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) {
      throw ApiError.badRequest('Missing or empty "prompt" field')
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw ApiError.badRequest(`Prompt is too long (limit ${MAX_PROMPT_LENGTH} characters)`)
    }

    const resolved = await resolveCompletionProvider()
    if (!resolved) {
      // Distinct from a transport failure: there is nothing to call, and the
      // user has to go configure a provider before retrying.
      throw new ApiError(
        409,
        'No active provider configured. Set one up in Settings, then try again.',
        'NO_ACTIVE_PROVIDER',
      )
    }

    const result = await completeWithProvider(resolved, {
      system: OPTIMIZE_SYSTEM_PROMPT,
      userContent: buildOptimizeUserPrompt(prompt),
      maxTokens: OPTIMIZE_MAX_OUTPUT_TOKENS,
      sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined,
      timeoutMs: OPTIMIZE_TIMEOUT_MS,
    })

    if (!result.ok) {
      // A single "did not return a prompt" for every cause sends the user to
      // check settings that are usually fine. Log the detail and say which
      // failure it was.
      console.error('[Optimize] provider call failed', {
        provider: resolved.kind === 'openai-official' ? 'openai-official' : `${resolved.id} (${resolved.model})`,
        failure: result.failure,
      })
      throw describeFailure(result.failure)
    }

    return Response.json({ optimized: result.text.trim() })
  } catch (error) {
    return errorResponse(error)
  }
}

function describeFailure(failure: CompletionFailure): ApiError {
  switch (failure.kind) {
    case 'http': {
      const upstream = failure.detail ? ` Upstream said: ${failure.detail}` : ''
      return new ApiError(
        502,
        `The provider rejected the request (HTTP ${failure.status}).${upstream}`,
        'OPTIMIZE_UPSTREAM_ERROR',
      )
    }
    case 'no-text':
      return new ApiError(
        502,
        `The provider returned no text (${failure.detail ?? 'empty response'}). A reasoning-only model may not answer this request.`,
        'OPTIMIZE_EMPTY_RESPONSE',
      )
    default:
      return new ApiError(
        502,
        failure.detail ?? 'The provider call failed before it produced a response.',
        'OPTIMIZE_FAILED',
      )
  }
}

function buildOptimizeUserPrompt(prompt: string): string {
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

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}
