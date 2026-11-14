import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleOptimizeApi } from '../api/optimize.js'
import { handleApiRequest } from '../router.js'

const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
let tmpDir = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimize-api-test-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeActiveProvider(baseUrl: string, overrides: Record<string, unknown> = {}) {
  await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
  await fs.writeFile(
    path.join(tmpDir, 'cc-haha', 'providers.json'),
    JSON.stringify({
      activeId: 'optimize-test',
      providers: [{
        id: 'optimize-test',
        presetId: 'custom',
        name: 'Optimize Test',
        apiKey: 'test-key',
        baseUrl,
        apiFormat: 'anthropic',
        models: {
          main: 'optimize-main',
          haiku: 'optimize-haiku',
          sonnet: 'optimize-main',
          opus: 'optimize-main',
        },
        ...overrides,
      }],
    }, null, 2),
  )
}

function request(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/optimize', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
}

function call(req: Request, segments: string[] = ['api', 'optimize']) {
  return handleOptimizeApi(req, new URL(req.url), segments)
}

describe('optimize API', () => {
  test('rejects non-POST requests', async () => {
    const res = await call(request(undefined, 'GET'))
    expect(res.status).toBe(405)
    expect(await res.json()).toMatchObject({ error: 'METHOD_NOT_ALLOWED' })
  })

  test('rejects an empty prompt', async () => {
    const res = await call(request({ prompt: '   ' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'BAD_REQUEST' })
  })

  test('rejects a prompt longer than 8000 characters', async () => {
    const res = await call(request({ prompt: 'a'.repeat(8001) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'BAD_REQUEST' })
  })

  test('returns 409 when no provider is active', async () => {
    const res = await call(request({ prompt: 'add login' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'NO_ACTIVE_PROVIDER' })
  })

  test('returns the optimized prompt and sends the expected request', async () => {
    let body: Record<string, unknown> | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        body = await req.json() as Record<string, unknown>
        return Response.json({ content: [{ type: 'text', text: '  Build a login form with validation  ' }] })
      },
    })
    try {
      await writeActiveProvider(`http://127.0.0.1:${server.port}/anthropic`)
      const res = await call(request({ prompt: 'add login', sessionId: 'session-1' }))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ optimized: 'Build a login form with validation' })
      expect(body?.model).toBe('optimize-haiku')
      expect(body?.thinking).toEqual({ type: 'disabled' })
      expect(String(body?.system)).toContain('Preserve the original intent')
      expect(JSON.stringify(body?.messages)).toContain('<prompt>\\nadd login\\n</prompt>')
    } finally {
      server.stop(true)
    }
  })

  test('is reachable through the real router', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ content: [{ type: 'text', text: 'Refined prompt' }] }),
    })
    try {
      await writeActiveProvider(`http://127.0.0.1:${server.port}/anthropic`)
      const req = request({ prompt: 'add login' })
      const res = await handleApiRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ optimized: 'Refined prompt' })
    } finally {
      server.stop(true)
    }
  })

  test('surfaces the upstream status when authentication fails', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ error: 'invalid x-api-key' }, { status: 401 }),
    })
    try {
      await writeActiveProvider(`http://127.0.0.1:${server.port}/anthropic`)
      const res = await call(request({ prompt: 'add login' }))
      expect(res.status).toBe(502)
      const json = await res.json() as { error: string; message: string }
      expect(json.error).toBe('OPTIMIZE_UPSTREAM_ERROR')
      expect(json.message).toContain('HTTP 401')
    } finally {
      server.stop(true)
    }
  })

  test('returns OPTIMIZE_EMPTY_RESPONSE when the model only returns thinking', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ content: [{ type: 'thinking', thinking: 'hmm' }] }),
    })
    try {
      await writeActiveProvider(`http://127.0.0.1:${server.port}/anthropic`)
      const res = await call(request({ prompt: 'add login' }))
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ error: 'OPTIMIZE_EMPTY_RESPONSE' })
    } finally {
      server.stop(true)
    }
  })

  test('returns a 502 when the upstream body is not JSON', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('data: not json', { status: 200 }),
    })
    try {
      await writeActiveProvider(`http://127.0.0.1:${server.port}/anthropic`)
      const res = await call(request({ prompt: 'add login' }))
      expect(res.status).toBe(502)
    } finally {
      server.stop(true)
    }
  })
})
