/**
 * POST /api/optimize — 优化用户输入的提示词
 * Body: { prompt: string }
 * Response: { optimized: string }
 */

import Anthropic, { APIConnectionError } from '@anthropic-ai/sdk'
import { readActiveProviderManagedEnv } from '../services/providerRuntimeEnv.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { getUserAgent } from '../../utils/http.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

/** 优化规则：作为 system prompt 注入 */
const OPTIMIZE_SYSTEM_PROMPT = `You are a prompt optimization assistant. Your task is to improve the user's prompt to make it clearer, more specific, and more likely to produce high-quality results.

Rules:
1. Preserve the original intent — do NOT change what the user is asking for
2. Add necessary context and specificity if the prompt is vague
3. Remove ambiguity and clarify any unclear requests
4. Structure the prompt logically (e.g., numbered steps for multi-part requests)
5. Keep the optimized prompt concise — only add what's truly needed
6. Output ONLY the optimized prompt text — no explanations, no markdown fences, no prefixes`

export async function handleOptimizeApi(req: Request): Promise<Response> {
  // 1) 只接受 POST
  if (req.method !== 'POST') {
    return errorResponse(new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED'))
  }

  // 2) 从服务商配置读取 baseURL / 密钥 / 模型（不依赖 .env，避免代理端口不匹配）
  const configDir = getClaudeConfigHomeDir()
  const managedEnv = readActiveProviderManagedEnv(configDir)
  if (!managedEnv?.ANTHROPIC_BASE_URL) {
    return errorResponse(
      ApiError.internal('No active provider configured. Please set up a provider in Settings.'),
    )
  }

  const baseURL = managedEnv.ANTHROPIC_BASE_URL
  const authToken = managedEnv.ANTHROPIC_AUTH_TOKEN || undefined
  const apiKey = managedEnv.ANTHROPIC_API_KEY || undefined
  const model =
    managedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
    managedEnv.ANTHROPIC_MODEL ||
    'claude-haiku-4-5-20251001'

  try {
    // 3) 解析请求体
    const body = await req.json() as { prompt?: string }
    if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
      throw ApiError.badRequest('Missing or empty "prompt" field')
    }

    // 4) 创建 Anthropic 兼容客户端（直连服务商配置的 baseURL）
    const client = new Anthropic({
      baseURL,
      apiKey: apiKey || authToken ? undefined : 'optimize-dummy',
      authToken,
      maxRetries: 1,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
      dangerouslyAllowBrowser: true,
      fetchOptions: getProxyFetchOptions({
        forAnthropicAPI: true,
        targetUrl: baseURL,
      }) as Anthropic.ClientOptions['fetchOptions'],
      defaultHeaders: {
        'x-app': 'cli',
        'User-Agent': getUserAgent(),
      },
    })

    // 5) 调用模型
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      system: OPTIMIZE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Improve the following prompt. Make it clearer, more specific, and more detailed while preserving the original intent.\n\nOutput ONLY the improved prompt text — no explanations or prefixes.\n\nPrompt to improve:\n${body.prompt.trim()}`,
        },
      ],
    })

    // 6) 兼容推理模型（DeepSeek v4 等）：跳过 thinking block，取 text block
    const textContent = response.content.find((c) => c.type === 'text') as
      | { type: 'text'; text: string }
      | undefined
    const optimized = textContent ? textContent.text : body.prompt

    return Response.json({ optimized })
  } catch (error) {
    // 7) 代理不可达时给出明确提示
    if (error instanceof APIConnectionError) {
      const hint = `Cannot connect to API endpoint at ${baseURL}. Check your provider settings and network.`
      return errorResponse(new ApiError(502, hint, 'API_CONNECTION_ERROR'))
    }
    return errorResponse(error)
  }
}
