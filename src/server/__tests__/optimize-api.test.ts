import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { handleOptimizeApi } from '../api/optimize.js'
import { handleApiRequest } from '../router.js'

const PROVIDERS_FIXTURE = {
  schemaVersion: 1,
  activeId: 'test-provider',
  providers: [
    {
      id: 'test-provider',
      presetId: 'custom',
      name: 'test',
      baseUrl: 'https://api.invalid',
      apiKey: 'sk-test',
      authStrategy: 'api_key',
      apiFormat: 'anthropic',
      models: { main: 'test-model', haiku: 'test-model', sonnet: 'test-model', opus: 'test-model' },
    },
  ],
}

describe('optimize API', () => {
  let configDir: string
  let originalConfigDir: string | undefined

  beforeEach(() => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-optimize-test-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  function writeProviderConfig() {
    fs.mkdirSync(path.join(configDir, 'cc-haha'), { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'cc-haha', 'providers.json'),
      JSON.stringify(PROVIDERS_FIXTURE),
    )
  }

  it('rejects non-POST requests with 405', async () => {
    const res = await handleOptimizeApi(new Request('http://localhost/api/optimize', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns a clear error when no active provider is configured', async () => {
    const res = await handleOptimizeApi(
      new Request('http://localhost/api/optimize', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'hello' }),
      }),
    )
    expect(res.status).toBe(500)
    const body = await res.json() as { message?: string }
    expect(body.message ?? '').toContain('provider')
  })

  it('is reachable through the router with a sandboxed config dir', async () => {
    const url = new URL('http://localhost/api/optimize')
    const res = await handleApiRequest(
      new Request(url.toString(), { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) }),
      url,
    )
    // No provider in the sandbox -> the handler answers with the provider hint
    // (500), which proves the route dispatched instead of 404ing.
    expect(res.status).toBe(500)
    const body = await res.json() as { message?: string }
    expect(body.message ?? '').toContain('provider')
  })

  it('rejects an empty prompt with 400 before any model call', async () => {
    writeProviderConfig()
    const res = await handleOptimizeApi(
      new Request('http://localhost/api/optimize', {
        method: 'POST',
        body: JSON.stringify({ prompt: '   ' }),
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { message?: string }
    expect(body.message ?? '').toContain('prompt')
  })
})
