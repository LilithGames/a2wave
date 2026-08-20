import { API_BASE, getE2ePassword } from './test-constants'

// Cache the admin login promise per worker process so parallel tests share a
// single /api/auth/login call and don't trip the auth rate limiter (30/min).
let adminTokenPromise: Promise<string> | null = null

export async function getAdminToken(): Promise<string> {
  if (!adminTokenPromise) {
    adminTokenPromise = (async () => {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: getE2ePassword() }),
      })
      if (!res.ok) throw new Error(`Login failed: ${res.status}`)
      const body = (await res.json()) as { data: { token: string } }
      return body.data.token
    })().catch((err) => {
      adminTokenPromise = null
      throw err
    })
  }
  return adminTokenPromise
}

export interface RunSummary {
  id: string
  status: string
  intent: string
  result: { error?: string } | null
}

export async function listRuns(token: string, pageSize = 100): Promise<RunSummary[]> {
  const res = await fetch(`${API_BASE}/api/runs?pageSize=${pageSize}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listRuns failed: ${res.status}`)
  const body = (await res.json()) as { data: RunSummary[] }
  return body.data ?? []
}

export async function createRun(
  token: string,
  intent: string,
  initiatorAgentId: string,
): Promise<RunSummary> {
  const res = await fetch(`${API_BASE}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ intent, initiatorAgentId }),
  })
  if (!res.ok) throw new Error(`createRun failed: ${res.status}`)
  const body = (await res.json()) as { data: RunSummary }
  return body.data
}

export interface ArtifactSummary {
  id: string
  runId: string
  filename: string
  mimeType: string | null
  size: number | null
  expiresAt: string | null
}

export async function listArtifacts(token: string, runId: string): Promise<ArtifactSummary[]> {
  const res = await fetch(`${API_BASE}/api/artifacts?runId=${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listArtifacts failed: ${res.status}`)
  const body = (await res.json()) as { data: ArtifactSummary[] }
  return body.data ?? []
}

export async function deleteArtifact(token: string, artifactId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`deleteArtifact failed: ${res.status}`)
}

export interface ArtifactShareSummary {
  id: string
  artifactId: string
  accessLevel: 'public' | 'password' | 'authenticated'
  hasPassword: boolean
  url: string
  expiresAt: string
  revokedAt: string | null
  viewCount: number
}

export async function createArtifactShare(
  token: string,
  artifactId: string,
  body: {
    accessLevel: 'public' | 'password' | 'authenticated'
    password?: string
    expiryDays?: number
  },
): Promise<ArtifactShareSummary> {
  const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`createArtifactShare failed ${res.status}: ${err.error ?? ''}`)
  }
  const json = (await res.json()) as { data: ArtifactShareSummary }
  return json.data
}

export async function listArtifactShares(
  token: string,
  artifactId: string,
): Promise<ArtifactShareSummary[]> {
  const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/shares`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listArtifactShares failed: ${res.status}`)
  const json = (await res.json()) as { data: ArtifactShareSummary[] }
  return json.data ?? []
}

export async function revokeArtifactShare(
  token: string,
  artifactId: string,
  shareId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/shares/${shareId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`revokeArtifactShare failed: ${res.status}`)
}

/**
 * Seed a minimal artifact row directly via the e2e seed endpoint.
 * Falls back to null if the server doesn't expose the seed helper (non-e2e env).
 */
export async function seedArtifact(
  token: string,
  fields: { filename: string; kind?: 'file' | 'directory'; mimeType?: string },
): Promise<ArtifactSummary | null> {
  const res = await fetch(`${API_BASE}/api/e2e/seed-artifact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(fields),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { data: ArtifactSummary }
  return json.data
}

export interface AgentSummary {
  id: string
  name: string
  publishStatus: string
}

export interface ProviderSummary {
  id: string
  name: string
  kind: string
}

export interface AgentDetail extends AgentSummary {
  providerId?: string | null
  providerApiKey?: string | null
  providerBaseUrl?: string | null
  providerOauthToken?: string | null
  authMode?: 'apiKey' | 'oauth' | 'localSession'
  config?: Record<string, unknown> | null
}

export async function listAgents(token: string, page = 1, pageSize = 50): Promise<AgentSummary[]> {
  const res = await fetch(`${API_BASE}/api/agents?page=${page}&pageSize=${pageSize}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listAgents failed: ${res.status}`)
  const body = (await res.json()) as { data: AgentSummary[] }
  return body.data ?? []
}

export async function createAgent(token: string, name: string): Promise<AgentSummary> {
  const res = await fetch(`${API_BASE}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`createAgent failed: ${res.status}`)
  const body = (await res.json()) as { data: AgentSummary }
  return body.data
}

export async function createAgentWithPayload(
  token: string,
  data: Record<string, unknown>,
): Promise<AgentDetail> {
  const res = await fetch(`${API_BASE}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`createAgentWithPayload failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: AgentDetail }
  return body.data
}

/**
 * `publishStatus` is server-controlled and cannot be set through create/PATCH
 * (see the comment on `createAgentInput` in packages/shared/src/schemas/agent.ts) —
 * an Agent must go through this route to actually become `published`, which a
 * trigger channel like Feishu requires before it will process an inbound message.
 */
export async function publishAgent(
  token: string,
  agentId: string,
  data: Record<string, unknown> = {},
): Promise<AgentDetail> {
  const res = await fetch(`${API_BASE}/api/agents/${agentId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`publishAgent failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: AgentDetail }
  return body.data
}

export async function executeAgentChat(
  token: string,
  agentId: string,
  message: string,
): Promise<{ runId: string; reply: string }> {
  const res = await fetch(`${API_BASE}/api/agents/${agentId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, stream: false }),
  })
  if (!res.ok) throw new Error(`executeAgentChat failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: { runId: string; reply: string } }
  return body.data
}

export async function getRunDetail(
  token: string,
  runId: string,
): Promise<{
  id: string
  status: string
  result: { error?: unknown } | null
  messages: Array<{ id: string; role: string; content: string }>
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  steps: Array<{ output?: { usage?: Record<string, number> } | null }>
}> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`getRunDetail failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {
    data: {
      id: string
      status: string
      result: { error?: unknown } | null
      messages: Array<{ id: string; role: string; content: string }>
      inputTokens: number | null
      outputTokens: number | null
      cacheReadTokens: number | null
      cacheWriteTokens: number | null
      steps: Array<{ output?: { usage?: Record<string, number> } | null }>
    }
  }
  return body.data
}

export async function getAgent(token: string, id: string): Promise<AgentDetail> {
  const res = await fetch(`${API_BASE}/api/agents/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`getAgent failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: AgentDetail }
  return body.data
}

export async function updateAgent(
  token: string,
  agentId: string,
  data: Record<string, unknown>,
): Promise<AgentDetail> {
  const res = await fetch(`${API_BASE}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`updateAgent failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: AgentDetail }
  return body.data
}

export async function injectFeishuMessage(
  token: string,
  agentId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/e2e/feishu/${agentId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`injectFeishuMessage failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { data: Record<string, unknown> }
  return json.data
}

export async function listProviders(token: string): Promise<ProviderSummary[]> {
  const res = await fetch(`${API_BASE}/api/providers`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listProviders failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data: ProviderSummary[] }
  return body.data ?? []
}

export async function updateArtifactsPublicBaseUrl(
  token: string,
  publicBaseUrl: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ artifacts: { publicBaseUrl } }),
  })
  if (!res.ok) throw new Error(`updateArtifactsPublicBaseUrl failed: ${res.status}`)
}

export async function createMcpServer(
  token: string,
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/api/mcp-servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`createMcpServer failed: ${res.status}`)
  const body = (await res.json()) as { data: { id: string } }
  return body.data
}

export async function deleteMcpServer(token: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp-servers/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`deleteMcpServer failed: ${res.status}`)
}

export interface ScmSourceSummary {
  id: string
  name: string
  type: string
  localPath: string
}

export async function listScmSources(token: string): Promise<ScmSourceSummary[]> {
  const res = await fetch(`${API_BASE}/api/scm-sources`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listScmSources failed: ${res.status}`)
  const body = (await res.json()) as { data: ScmSourceSummary[] }
  return body.data ?? []
}

export async function deleteScmSource(token: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/scm-sources/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`deleteScmSource failed: ${res.status}`)
}

export interface CreatedUser {
  id: string
  username: string
}

/**
 * Create a non-admin user via admin token. Used by member-management e2e to
 * spin up owner / editor / viewer / stranger fixtures with a unique suffix.
 *
 * There is no admin-set-password endpoint to call: admins issue an invitation and the
 * invitee chooses their own password. So the fixture walks that same two-step flow —
 * issue a link, then accept it — rather than reaching past it into the database.
 */
export async function createTestUser(
  adminToken: string,
  data: { username: string; password: string; displayName?: string },
): Promise<CreatedUser> {
  const email = `${data.username}@e2e.local`

  const inviteRes = await fetch(`${API_BASE}/api/users/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ email, role: 'user', expiresInHours: 24 }),
  })
  if (!inviteRes.ok)
    throw new Error(
      `createTestUser ${data.username} invite failed: ${inviteRes.status} ${await inviteRes.text()}`,
    )
  const { data: invitation } = (await inviteRes.json()) as { data: { code: string } }

  // Accept is deliberately unauthenticated — the invitee has no account yet — so this
  // call carries no admin token.
  const acceptRes = await fetch(`${API_BASE}/api/auth/invitations/${invitation.code}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: data.username,
      displayName: data.displayName,
      email,
      password: data.password,
      confirmPassword: data.password,
    }),
  })
  if (!acceptRes.ok)
    throw new Error(
      `createTestUser ${data.username} accept failed: ${acceptRes.status} ${await acceptRes.text()}`,
    )
  const body = (await acceptRes.json()) as { data: { user: CreatedUser } }
  return body.data.user
}

/** Best-effort cleanup. Swallows errors so afterAll never blocks. */
export async function deleteTestUser(adminToken: string, userId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/users/${userId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
  } catch {
    // ignore
  }
}

/** Login with arbitrary credentials and return the JWT plus user id. */
export async function loginByApi(
  username: string,
  password: string,
): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`loginByApi ${username} failed: ${res.status}`)
  const body = (await res.json()) as { data: { token: string; user: { id: string } } }
  return { token: body.data.token, userId: body.data.user.id }
}

/**
 * Create an agent with a specific user's token (so that user becomes owner).
 * Mirrors `createAgent` but kept distinct in name to make intent obvious at
 * the call site.
 */
export async function createAgentAs(
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return createAgent(token, name)
}

export async function deleteAgentAs(token: string, agentId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    // ignore
  }
}

/** Add a user as agent member (viewer | editor) using the owner's token. */
export async function addAgentMember(
  ownerToken: string,
  agentId: string,
  member: { userId: string; role: 'viewer' | 'editor' },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agents/${agentId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify(member),
  })
  if (!res.ok) {
    throw new Error(`addAgentMember failed: ${res.status} ${await res.text()}`)
  }
}

export async function createScmSource(
  token: string,
  name: string,
  localPath = `/tmp/e2e-scm-${Date.now()}`,
): Promise<ScmSourceSummary> {
  const res = await fetch(`${API_BASE}/api/scm-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name,
      type: 'git',
      localPath,
      config: { type: 'git', repoUrl: 'https://github.com/example/repo.git', branch: 'main' },
    }),
  })
  if (!res.ok) throw new Error(`createScmSource failed: ${res.status}`)
  const body = (await res.json()) as { data: ScmSourceSummary }
  return body.data
}

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

/** Start a device login the way a headless CLI would. No auth: that is the point. */
export async function startDeviceLogin(): Promise<DeviceCodeResponse> {
  const res = await fetch(`${API_BASE}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'User-Agent': 'a2wave-cli/e2e' },
  })
  if (!res.ok) throw new Error(`Device code request failed: ${res.status}`)
  const body = (await res.json()) as { data: DeviceCodeResponse }
  return body.data
}

/** Poll once, returning either the issued token or the RFC 8628 error code. */
export async function pollDeviceToken(
  deviceCode: string,
): Promise<{ token?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  })
  const body = (await res.json()) as { data?: { token: string }; error?: string }
  return res.ok ? { token: body.data?.token } : { error: body.error }
}
