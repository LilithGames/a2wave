/**
 * 飞书文档获取服务
 * 使用飞书 Open API 获取云文档内容
 */
import { createHash } from 'node:crypto'
import * as lark from '@larksuiteoapi/node-sdk'
import { logger } from './logger.js'

const SUPPORTED_FEISHU_DOC_TYPES = ['docx', 'wiki']
const FEISHU_HTTP_TIMEOUT_MS = 60 * 1000

// Typed via lark's own HttpInstance['request'] rather than axios generics: axios >= 1.19
// resolves `request<T, R, D>` to `Promise<AxiosResponseResult<T, R, D, P>>`, which tsc cannot
// prove assignable to the `Promise<R>` lark declares while `R` is still an unbound generic.
const boundedFeishuHttpInstance = Object.assign(Object.create(lark.defaultHttpInstance), {
  request: ((options) =>
    lark.defaultHttpInstance.request({
      ...options,
      timeout: FEISHU_HTTP_TIMEOUT_MS,
    })) as lark.HttpInstance['request'],
}) as lark.HttpInstance

/** 解析飞书文档 URL，提取 token 和类型 */
export function parseFeishuDocUrl(url: string): { token: string; type: string } {
  // Supported URL patterns:
  // https://xxx.feishu.cn/docx/TOKEN
  // https://xxx.feishu.cn/wiki/TOKEN
  // https://xxx.larksuite.com/docx/TOKEN
  const parsed = new URL(url)
  const pathParts = parsed.pathname.split('/').filter(Boolean)

  if (pathParts.length < 2) {
    throw new Error(`Invalid Feishu document URL: ${url}`)
  }

  const type = pathParts[0]
  const token = pathParts[1]

  if (!token) {
    throw new Error(`Cannot extract document token from URL: ${url}`)
  }

  if (!SUPPORTED_FEISHU_DOC_TYPES.includes(type)) {
    throw new Error(
      `Unsupported Feishu document type: "${type}". Supported types: ${SUPPORTED_FEISHU_DOC_TYPES.join(', ')}`,
    )
  }

  return { token, type }
}

/** 创建飞书 API 客户端 */
export function createFeishuClient(appId: string, appSecret: string): lark.Client {
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    httpInstance: boundedFeishuHttpInstance,
  })
}

/** 获取飞书文档纯文本内容 */
export async function fetchFeishuDocContent(
  client: lark.Client,
  token: string,
  type: string,
): Promise<{ title: string; content: string }> {
  try {
    // For wiki type, we need to get the actual document node first
    let docToken = token
    if (type === 'wiki') {
      const wikiRes = await client.wiki.space.getNode({
        params: { token },
      })
      const nodeObjToken = (wikiRes?.data?.node as Record<string, unknown>)?.obj_token as
        | string
        | undefined
      if (nodeObjToken) {
        docToken = nodeObjToken
      }
    }

    // Get raw text content
    const res = await client.docx.document.rawContent({
      path: { document_id: docToken },
      params: { lang: 0 },
    })

    const content = ((res?.data as Record<string, unknown>)?.content as string) ?? ''
    // Try to get document title from the first line
    const firstLine = content.split('\n')[0]?.trim() ?? ''
    const title = firstLine || 'Untitled'

    return { title, content }
  } catch (err) {
    logger.error({ err, token, type }, 'Failed to fetch Feishu document')
    const feishuMsg = parseFeishuErrorMessage(err)
    throw new Error(
      feishuMsg ??
        `Failed to fetch Feishu document: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** 从飞书 API 错误响应中提取用户友好的错误信息 */
function parseFeishuErrorMessage(err: unknown): string | null {
  const response = (err as { response?: { data?: { code?: number; msg?: string } } })?.response
  if (!response?.data) return null

  const { code, msg } = response.data

  if (code === 99991672 && msg) {
    const scopeMatch = msg.match(/\[([^\]]+)\]/)
    const scopes = scopeMatch?.[1] ?? ''
    return `飞书应用权限不足，需要开通以下任一权限: ${scopes}。请在飞书开放平台「应用权限」中申请后重试。`
  }

  if (code === 99991668) {
    return '飞书应用凭证无效，请检查 App ID 和 App Secret 是否正确。'
  }

  if (code === 99991663) {
    return '飞书访问令牌过期，请重试。'
  }

  if (msg) return `飞书 API 错误 (${code}): ${msg}`
  return null
}

/** 计算内容哈希 (SHA-256) */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/** 从飞书 URL 获取文档内容（便捷函数） */
export async function fetchFeishuDocByUrl(
  url: string,
  appId: string,
  appSecret: string,
): Promise<{ title: string; content: string; contentHash: string; token: string; type: string }> {
  const { token, type } = parseFeishuDocUrl(url)
  const client = createFeishuClient(appId, appSecret)
  const { title, content } = await fetchFeishuDocContent(client, token, type)
  const contentHash = computeContentHash(content)
  return { title, content, contentHash, token, type }
}
