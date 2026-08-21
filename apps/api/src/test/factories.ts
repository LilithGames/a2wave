/**
 * Shared test factories for creating entity fixtures.
 * Use these instead of inline fixture objects to keep tests DRY.
 *
 * Usage:
 *   const agent = createTestAgent({ name: 'My Agent' })
 *   const run = createTestRun({ initiatorAgentId: agent.id })
 */

import type { ProviderKind } from '@a2wave/shared'

const NOW = new Date('2025-01-01T00:00:00.000Z')

let idCounter = 0
function nextId(prefix: string): string {
  idCounter++
  return `${prefix}_test${idCounter}`
}

/** Reset the ID counter — call in beforeEach if deterministic IDs matter. */
export function resetIdCounter(): void {
  idCounter = 0
}

// ---- Agent ----

export interface TestAgent {
  id: string
  name: string
  description: string | null
  type: string
  config: Record<string, unknown> | null
  status: string
  icon: string
  systemPrompt: string | null
  skills: string[]
  skillGroupIds: string[]
  mcpServerIds: string[]
  kbDocumentIds: string[]
  publishStatus: string
  providerApiKey: string | null
  providerBaseUrl: string | null
  providerOauthToken: string | null
  authMode: 'apiKey' | 'oauth' | 'localSession'
  endpointApiKey: string | null
  publishAuthType: string | null
  publishIpWhitelist: string[] | null
  publishDescription: string | null
  publishChannels: string[] | null
  a2aSkills: unknown | null
  a2aRouteTargets: unknown | null
  showLocalChildOutput: boolean | null
  showRemoteChildOutput: boolean | null
  feishuConfig: unknown | null
  slackConfig: unknown | null
  discordConfig: unknown | null
  telegramConfig: unknown | null
  chatAppConfig: {
    displayName?: string
    welcomeMessage?: string
    suggestedQuestions?: string[]
    showCreator?: boolean
    allowAttachments?: boolean
    showThinking?: boolean
  } | null
  scheduleConfig: unknown | null
  publishedAt: Date | null
  providerId: string | null
  env: Record<string, { value: string; sensitive: boolean }> | null
  workspaceType: string
  scmSourceId: string | null
  maxConcurrency: number
  userId: string | null
  pinnedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function createTestAgent(overrides: Partial<TestAgent> = {}): TestAgent {
  return {
    id: nextId('agt'),
    name: 'Test Agent',
    description: 'A test agent',
    type: 'cursor',
    config: null,
    status: 'active',
    icon: '🤖',
    systemPrompt: 'You are a helpful assistant.',
    skills: [],
    skillGroupIds: [],
    mcpServerIds: [],
    kbDocumentIds: [],
    publishStatus: 'draft',
    providerApiKey: null,
    providerBaseUrl: null,
    providerOauthToken: null,
    authMode: 'apiKey',
    endpointApiKey: null,
    publishAuthType: 'api_key',
    publishIpWhitelist: [],
    publishDescription: null,
    publishChannels: ['api'],
    a2aSkills: null,
    a2aRouteTargets: null,
    showLocalChildOutput: null,
    showRemoteChildOutput: null,
    feishuConfig: null,
    slackConfig: null,
    discordConfig: null,
    telegramConfig: null,
    chatAppConfig: null,
    scheduleConfig: null,
    publishedAt: null,
    providerId: 'prv_default',
    env: null,
    workspaceType: 'temp',
    scmSourceId: null,
    maxConcurrency: 1,
    userId: 'usr_admin',
    pinnedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---- Run ----

export interface TestRun {
  id: string
  intent: string
  status: string
  result: Record<string, unknown> | null
  triggerSource: string | null
  triggerSessionId: string | null
  initiatorAgentId: string | null
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

export function createTestRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: nextId('run'),
    intent: 'Test intent',
    status: 'pending',
    result: null,
    triggerSource: 'debug',
    triggerSessionId: null,
    initiatorAgentId: null,
    userId: 'usr_admin',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---- User ----

export interface TestUser {
  id: string
  username: string
  displayName: string | null
  role: string
  passwordHash: string | null
  locale: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export function createTestUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: nextId('usr'),
    username: 'testuser',
    displayName: 'Test User',
    role: 'user',
    passwordHash: '$argon2id$hash',
    locale: 'zh',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---- Provider ----

export interface TestProvider {
  id: string
  kind: ProviderKind
  name: string
  description: string | null
  isPreset: boolean
  initScript: string | null
  checkScript: string | null
  skillsDir: string | null
  mcpConfigPath: string | null
  config: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export function createTestProvider(overrides: Partial<TestProvider> = {}): TestProvider {
  return {
    id: nextId('prv'),
    kind: 'cursor',
    name: 'Test Provider',
    description: 'A test provider',
    isPreset: false,
    initScript: null,
    checkScript: null,
    skillsDir: null,
    mcpConfigPath: null,
    config: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---- MCP Server ----

export interface TestMcpServer {
  id: string
  name: string
  description: string | null
  type: string
  command: string | null
  args: string[]
  cwd: string | null
  url: string | null
  headers: Record<string, string> | null
  env: Record<string, string> | null
  groupConfig: unknown | null
  isEnabled: boolean
  usageScope: 'admin-only' | 'all-users'
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

export function createTestMcpServer(overrides: Partial<TestMcpServer> = {}): TestMcpServer {
  return {
    id: nextId('mcp'),
    name: 'Test MCP Server',
    description: null,
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    cwd: null,
    url: null,
    headers: null,
    env: null,
    groupConfig: null,
    isEnabled: true,
    usageScope: 'admin-only',
    userId: 'usr_admin',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---- Skill ----

export interface TestSkill {
  id: string
  name: string
  description: string | null
  content: string | null
  storagePath: string | null
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

export function createTestSkill(overrides: Partial<TestSkill> = {}): TestSkill {
  return {
    id: nextId('skl'),
    name: 'Test Skill',
    description: 'A test skill',
    content: '# Test Skill\n\nDo something useful.',
    storagePath: null,
    userId: 'usr_admin',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}
