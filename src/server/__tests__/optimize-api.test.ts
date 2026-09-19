import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleOptimizeApi } from '../api/optimize.js'
import { handleApiRequest } from '../router.js'
import { ProviderService } from '../services/providerService.js'
import { hahaOpenAIOAuthService } from '../services/hahaOpenAIOAuthService.js'
import {
  clearTraceCaptureStateForTests,
  drainTraceCaptureForTests,
} from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

function makeRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return new Request('http://localhost:3456/api/optimize', init)
}

function callOptimize(method: string, body?: unknown) {
  return handleOptimizeApi(makeRequest(method, body), new URL('http://localhost:3456/api/optimize'), ['api', 'optimize'])
}

describe('optimize API', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalFetch = globalThis.fetch
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimize-api-test-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetSettingsCache()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    hahaOpenAIOAuthService.dispose()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    resetSettingsCache()
    // Same teardown `proxy-anthropic-compat.test.ts` uses: settle in-flight
    // appends, drop the cached trace index handles, then retry the removal —
    // on Windows the background projection keeps the config dir locked briefly.
    await drainTraceCaptureForTests()
    clearTraceCaptureStateForTests()
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true })
        return
      } catch (err) {
        if ((err as { code?: string }).code !== 'EBUSY') throw err
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  })

  /** Points the active provider at a local stub and returns the captured bodies. */
  async function serveProvider(
    respond: (body: Record<string, unknown>) => Response,
  ): Promise<{ bodies: Array<Record<string, unknown>>; stop: () => void }> {
    const bodies: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = await req.json() as Record<string, unknown>
        bodies.push(body)
        return respond(body)
      },
    })

    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Optimize Stub',
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
      apiFormat: 'anthropic',
      models: { main: 'test-model', haiku: 'test-model', sonnet: 'test-model', opus: 'test-model' },
    })
    await new ProviderService().activateProvider(provider.id)

    return { bodies, stop: () => server.stop(true) }
  }

  test('rejects non-POST requests', async () => {
    const res = await callOptimize('GET')
    expect(res.status).toBe(405)
    expect((await res.json() as { error: string }).error).toBe('METHOD_NOT_ALLOWED')
  })

  test('rejects an empty prompt', async () => {
    for (const body of [{}, { prompt: '' }, { prompt: '   ' }, { prompt: 42 }]) {
      const res = await callOptimize('POST', body)
      expect(res.status).toBe(400)
    }
  })

  test('rejects a prompt past the length limit', async () => {
    const res = await callOptimize('POST', { prompt: 'x'.repeat(8001) })
    expect(res.status).toBe(400)
  })

  test('reports a missing provider distinctly from a failed call', async () => {
    // No provider has been added, so there is nothing to call — the client has
    // to send the user to Settings rather than to a retry button.
    const res = await callOptimize('POST', { prompt: '写个登录功能' })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('NO_ACTIVE_PROVIDER')
  })

  test('returns the optimized prompt from the active provider', async () => {
    const { bodies, stop } = await serveProvider(() => Response.json({
      content: [{ type: 'text', text: '  写一个登录页面，包含邮箱/密码校验与错误提示。  ' }],
    }))

    try {
      const res = await callOptimize('POST', { prompt: '写个登录功能' })
      expect(res.status).toBe(200)
      // Trimmed: models like to pad, and the caller writes this back verbatim.
      expect((await res.json() as { optimized: string }).optimized)
        .toBe('写一个登录页面，包含邮箱/密码校验与错误提示。')

      expect(bodies).toHaveLength(1)
      expect(bodies[0]?.model).toBe('test-model')
      expect(String(bodies[0]?.system)).toContain('prompt optimization assistant')
      const messages = bodies[0]?.messages as Array<{ role: string; content: string }>
      expect(messages[0]?.role).toBe('user')
      expect(messages[0]?.content).toContain('写个登录功能')
    } finally {
      stop()
    }
  })

  // The reason this endpoint does not use the Anthropic SDK directly: a
  // provider preset speaking OpenAI's wire format is rejected outright by
  // `POST /v1/messages`, and only the in-process proxy knows to translate.
  test('routes an OpenAI-format provider through the proxy', async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Response.json({
        id: 'chatcmpl-optimize',
        object: 'chat.completion',
        model: 'glm-5.3-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '写一个登录页面，含表单校验与错误提示。' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }) as typeof fetch

    const provider = await new ProviderService().addProvider({
      presetId: 'opencode-go',
      name: 'OpenCode Go',
      apiKey: 'sk-opencode-optimize',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai_chat',
      models: { main: 'glm-5.3', haiku: 'glm-5.3-flash', sonnet: 'glm-5.3', opus: 'glm-5.3' },
    })
    await new ProviderService().activateProvider(provider.id)

    const res = await callOptimize('POST', { prompt: '写个登录功能', sessionId: 'optimize-session-1' })

    expect(res.status).toBe(200)
    expect((await res.json() as { optimized: string }).optimized)
      .toBe('写一个登录页面，含表单校验与错误提示。')

    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).pathname).toBe('/zen/go/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('glm-5.3-flash')
    expect(calls[0]!.headers.get('x-opencode-session')).toBe('optimize-session-1')
  })

  // The whole point of the detail: a 401 and a "the model answered with only
  // thinking blocks" used to produce the same unusable sentence.
  test('surfaces the upstream status and body instead of a generic failure', async () => {
    const { stop } = await serveProvider(() => Response.json(
      { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      { status: 401 },
    ))

    try {
      const res = await callOptimize('POST', { prompt: '写个登录功能' })
      expect(res.status).toBe(502)

      const body = await res.json() as { error: string; message: string }
      expect(body.error).toBe('OPTIMIZE_UPSTREAM_ERROR')
      expect(body.message).toContain('401')
      expect(body.message).toContain('invalid x-api-key')
    } finally {
      stop()
    }
  })

  test('reports which content blocks came back when there is no text', async () => {
    const { stop } = await serveProvider(() => Response.json({
      content: [{ type: 'thinking', thinking: '...' }],
    }))

    try {
      const res = await callOptimize('POST', { prompt: '写个登录功能' })
      expect(res.status).toBe(502)

      const body = await res.json() as { error: string; message: string }
      expect(body.error).toBe('OPTIMIZE_EMPTY_RESPONSE')
      // Naming the block type is what identifies a reasoning-only model.
      expect(body.message).toContain('thinking')
    } finally {
      stop()
    }
  })

  test('reports a non-JSON body rather than pretending there was no answer', async () => {
    const { stop } = await serveProvider(() => new Response('data: {"type":"content_block_delta"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    try {
      const res = await callOptimize('POST', { prompt: '写个登录功能' })
      expect(res.status).toBe(502)

      const body = await res.json() as { error: string; message: string }
      expect(body.error).toBe('OPTIMIZE_EMPTY_RESPONSE')
      expect(body.message).toContain('unparsable body')
    } finally {
      stop()
    }
  })

  test('rejects an invalid JSON body', async () => {
    const req = new Request('http://localhost:3456/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    const res = await handleOptimizeApi(req, new URL('http://localhost:3456/api/optimize'), ['api', 'optimize'])
    expect(res.status).toBe(400)
  })

  // Direct handler calls would keep passing if the router case were missing,
  // which is exactly the failure that makes the button do nothing.
  test('is reachable through the API router', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost:3456/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '写个登录功能' }),
      }),
      new URL('http://localhost:3456/api/optimize'),
    )

    // 409 because no provider is configured here — the point is that it routed
    // to the optimize handler rather than falling through to 404 Not Found.
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('NO_ACTIVE_PROVIDER')
  })
})
