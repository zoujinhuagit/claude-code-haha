/**
 * Provider Completion — one-shot text generation against the active provider.
 *
 * Extracted from `titleService`, which was the server's only caller until the
 * prompt-optimize endpoint arrived. Talking to a provider is not as simple as
 * POSTing to `baseUrl/v1/messages`: the preset decides the wire format, some
 * formats only work through the in-process proxy, and the OpenAI-official
 * provider answers on a completely different protocol over OAuth. Every one of
 * those branches lived in titleService and would have been re-derived — wrong —
 * by the next caller.
 */

import { ProviderService } from './providerService.js'
import { normalizeAnthropicBaseUrl } from '../../services/api/anthropicBaseUrl.js'
import {
  getPresetAuthStrategy,
  providerNeedsProxy,
  resolveProviderApiFormat,
} from './providerRuntimeEnv.js'
import { handleProxyRequest } from '../proxy/handler.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings, type NetworkSettings } from './networkSettings.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { isOpenAIOfficialProviderId } from './openaiOfficialProvider.js'
import { OPENAI_CODEX_API_ENDPOINT } from '../../services/openaiAuth/client.js'
import { resolveOpenAICodexModel } from '../../services/openaiAuth/models.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesStreamToAnthropicResponse } from '../proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'
import type { ProviderAuthStrategy } from '../types/provider.js'

/** Matches what titleService used before this module existed. */
const DEFAULT_COMPLETION_TIMEOUT_MS = 15_000
/** Enough of an upstream error body to identify it, not enough to flood a toast. */
const FAILURE_DETAIL_MAX_LENGTH = 300

/**
 * Why a completion failed. Callers that only care whether it worked can read
 * `ok`; callers that have to tell the user something actionable need the rest.
 * Collapsing every cause into `null` is what made the first version of the
 * optimize endpoint answer "did not return a prompt" for a 401, a 400 and an
 * empty reasoning-only response alike.
 */
export type CompletionFailure =
  | { kind: 'http'; status: number; detail?: string }
  | { kind: 'no-text'; status: number; detail?: string }
  | { kind: 'exception'; detail?: string }

export type CompletionResult =
  | { ok: true; text: string }
  | { ok: false; failure: CompletionFailure }

export type ResolvedCompletionProvider =
  | { kind: 'openai-official'; model: string }
  | {
      kind: 'anthropic'
      id: string
      baseUrl: string
      apiKey: string
      authStrategy: ProviderAuthStrategy
      /** Preset needs the in-process proxy rather than a direct HTTP call. */
      usesLocalProxy: boolean
      model: string
    }

export type CompletionRequest = {
  system: string
  userContent: string
  maxTokens: number
  /** Forwarded to the proxy so gateways can route the call with the session. */
  sessionId?: string
  timeoutMs?: number
}

/** Anthropic Messages body, before the per-path `thinking` handling. */
type MessageBody = {
  model: string
  max_tokens: number
  system: string
  messages: Array<{ role: 'user'; content: string }>
}

/**
 * Resolve the provider to call. `providerId` omitted means "the active one";
 * an explicit `null` means the caller has already decided not to call anyone,
 * and is answered with `null` rather than a fall-through to the active
 * provider.
 *
 * Returns `null` — never throws — when nothing is configured or the provider
 * record is unusable, so callers can treat "no provider" and "broken provider"
 * the same way.
 */
export async function resolveCompletionProvider(
  providerId?: string | null,
): Promise<ResolvedCompletionProvider | null> {
  if (providerId === null) return null

  try {
    const providerService = new ProviderService()
    let provider = providerId ? await providerService.getProvider(providerId) : null

    if (!provider) {
      // Looked up in the list rather than by id because the active id can name
      // a built-in that `getProvider` only serves as a constant.
      const { activeId, providers } = await providerService.listProviders()
      provider = activeId
        ? isOpenAIOfficialProviderId(activeId)
          ? await providerService.getProvider(activeId)
          : providers.find((entry) => entry.id === activeId) ?? null
        : null
    }

    if (!provider) return null

    const model = provider.models.haiku || provider.models.main
    if (!model) return null

    if (isOpenAIOfficialProviderId(provider.id)) {
      return { kind: 'openai-official', model }
    }

    if (!provider.baseUrl || !provider.apiKey) return null

    return {
      kind: 'anthropic',
      id: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      authStrategy: provider.authStrategy ?? getPresetAuthStrategy(provider.presetId),
      usesLocalProxy: providerNeedsProxy(
        resolveProviderApiFormat(provider),
        provider.supportsNestedToolResultMedia,
      ),
      model,
    }
  } catch {
    return null
  }
}

/** Generate text once, carrying enough failure detail to be diagnosable. */
export async function completeWithProvider(
  resolved: ResolvedCompletionProvider,
  request: CompletionRequest,
): Promise<CompletionResult> {
  if (!resolved) {
    return { ok: false, failure: { kind: 'exception', detail: 'No provider to call' } }
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS
  const requestBody: MessageBody = {
    model: resolved.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user', content: request.userContent }],
  }

  try {
    if (resolved.kind === 'openai-official') {
      return await requestViaOpenAIOfficial(resolved.model, requestBody, timeoutMs)
    }

    if (resolved.usesLocalProxy) {
      // The proxy owns the per-model protocol and the preset's upstream
      // headers. Talking to these providers in Anthropic Messages directly
      // would ignore both — and it also owns its own timeouts.
      return await requestViaLocalProxy(resolved.id, request.sessionId, requestBody)
    }

    const url = `${normalizeAnthropicBaseUrl(resolved.baseUrl.replace(/\/+$/, ''))}/v1/messages`
    const headers = buildProviderRequestHeaders(resolved.apiKey, resolved.authStrategy)
    const networkSettings = await loadNetworkSettings()
    return await requestViaDirectAnthropic(url, headers, requestBody, networkSettings, timeoutMs)
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'exception',
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function buildProviderRequestHeaders(
  apiKey: string,
  authStrategy: ProviderAuthStrategy,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }

  switch (authStrategy) {
    case 'api_key':
      headers['x-api-key'] = apiKey
      break
    case 'auth_token':
    case 'auth_token_empty_api_key':
      headers.Authorization = `Bearer ${apiKey}`
      break
    case 'dual_same_token':
      headers['x-api-key'] = apiKey
      headers.Authorization = `Bearer ${apiKey}`
      break
    case 'dual_dummy':
      headers['x-api-key'] = 'dummy'
      headers.Authorization = 'Bearer dummy'
      break
  }

  return headers
}

/**
 * Direct Anthropic Messages call. Unsupported `thinking` is the common 4xx
 * here, so one retry without it — cheaper than probing capabilities per model.
 */
async function requestViaDirectAnthropic(
  url: string,
  headers: Record<string, string>,
  requestBody: MessageBody,
  networkSettings: NetworkSettings,
  timeoutMs: number,
): Promise<CompletionResult> {
  const send = (body: MessageBody | (MessageBody & { thinking: { type: string } })) => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    ...getNetworkProxyFetchOptions(networkSettings, url),
  })

  let response = await send({ ...requestBody, thinking: { type: 'disabled' } })
  if (!response.ok && response.status >= 400 && response.status < 500) {
    response = await send(requestBody)
  }
  if (!response.ok) return { ok: false, failure: await httpFailure(response) }

  return readAnthropicText(response)
}

async function requestViaLocalProxy(
  providerId: string,
  sessionId: string | undefined,
  requestBody: MessageBody,
): Promise<CompletionResult> {
  const url = `http://127.0.0.1/proxy/providers/${encodeURIComponent(providerId)}/v1/messages`
  const send = (body: MessageBody | (MessageBody & { thinking: { type: string } })) => handleProxyRequest(
    new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    }),
    new URL(url),
  )

  let response = await send({ ...requestBody, thinking: { type: 'disabled' } })
  if (!response.ok && response.status >= 400 && response.status < 500) {
    response = await send(requestBody)
  }
  if (!response.ok) return { ok: false, failure: await httpFailure(response) }

  return readAnthropicText(response)
}

async function requestViaOpenAIOfficial(
  model: string,
  requestBody: MessageBody,
  timeoutMs: number,
): Promise<CompletionResult> {
  const tokens = await hahaOpenAIOAuthService.ensureFreshTokens()
  if (!tokens?.accessToken) {
    return { ok: false, failure: { kind: 'exception', detail: 'No OpenAI OAuth token; sign in again' } }
  }

  const mappedModel = resolveOpenAICodexModel(model)
  const networkSettings = await loadNetworkSettings()
  const openaiBody = anthropicToOpenaiResponses({
    model: mappedModel,
    max_tokens: requestBody.max_tokens,
    system: requestBody.system,
    messages: requestBody.messages,
    stream: true,
    thinking: { type: 'disabled' },
  })
  openaiBody.stream = true
  openaiBody.max_output_tokens = requestBody.max_tokens

  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${tokens.accessToken}`)
  if (tokens.accountId) {
    headers.set('ChatGPT-Account-Id', tokens.accountId)
  }

  const response = await fetch(OPENAI_CODEX_API_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(openaiBody),
    signal: AbortSignal.timeout(timeoutMs),
    ...getNetworkProxyFetchOptions(networkSettings, OPENAI_CODEX_API_ENDPOINT),
  })

  if (!response.ok) return { ok: false, failure: await httpFailure(response) }
  if (!response.body) {
    return { ok: false, failure: { kind: 'no-text', status: response.status, detail: 'empty response body' } }
  }

  const body = await openaiResponsesStreamToAnthropicResponse(response.body, mappedModel)
  const text = body.content.find((block) => block.type === 'text')?.text
  if (!text?.trim()) {
    const blockTypes = body.content.map((block) => block.type).join(', ') || 'none'
    return { ok: false, failure: { kind: 'no-text', status: response.status, detail: `content blocks: ${blockTypes}` } }
  }
  return { ok: true, text }
}

/**
 * Reads the body once as text, then parses: `.json()` would throw away the raw
 * body that makes an unexpected content type or an SSE stream identifiable.
 */
async function readAnthropicText(response: Response): Promise<CompletionResult> {
  const raw = await response.text()

  let body: { content?: Array<{ type: string; text?: string }> }
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    return {
      ok: false,
      failure: { kind: 'no-text', status: response.status, detail: `unparsable body: ${truncate(raw)}` },
    }
  }

  const text = body.content?.find((block) => block.type === 'text')?.text
  if (!text?.trim()) {
    // A reasoning model can answer with only thinking blocks, which reads as an
    // empty answer unless the block types are reported.
    const blockTypes = body.content?.map((block) => block.type).join(', ') || 'none'
    return {
      ok: false,
      failure: { kind: 'no-text', status: response.status, detail: `content blocks: ${blockTypes}` },
    }
  }

  return { ok: true, text }
}

async function httpFailure(response: Response): Promise<CompletionFailure> {
  let detail: string | undefined
  try {
    detail = truncate(await response.text())
  } catch {
    // Body already consumed or unreadable — the status alone still helps.
  }
  return { kind: 'http', status: response.status, detail }
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > FAILURE_DETAIL_MAX_LENGTH
    ? `${flat.slice(0, FAILURE_DETAIL_MAX_LENGTH)}…`
    : flat
}
