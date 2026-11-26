/** API / Web base URL，读自环境变量，方便 worktree 多端口并行。 */
const API_PORT = Number(process.env.PORT) || 3502
const WEB_PORT = Number(process.env.WEB_PORT) || 3501
// The API listener binds IPv4. Using localhost can resolve only to ::1 in
// recent Node runtimes and make direct E2E fetches fail while the server is healthy.
export const API_BASE = `http://127.0.0.1:${API_PORT}`
export const WEB_BASE = `http://localhost:${WEB_PORT}`

export const ROUTES = {
  dashboard: '/',
  agents: '/agents',
  providers: '/providers',
  mcpServers: '/mcp-servers',
  skills: '/skills',
  kbDocuments: '/kb-documents',
  scmSources: '/scm-sources',
  runs: '/runs',
  settings: '/settings',
  users: '/users',
  auditLogs: '/audit-logs',
  changelog: '/changelog',
  wiki: '/wiki',
  login: '/login',
  setup: '/setup',
} as const

/** Routes that need an id; kept here so specs never hardcode the path shape. */
export const AGENT_ROUTES = {
  detail: (agentId: string) => `/agents/${agentId}`,
  chatApp: (agentId: string) => `/agents/${agentId}/chat_app`,
  publishTab: (agentId: string, tab: string) => `/agents/${agentId}?tab=publish&publishTab=${tab}`,
} as const

/** Localized prefix of the channel footer summary; the channel names follow it. */
export const PUBLISH_PENDING_CHANGES = '当前有未提交的变更'

/** 导航项名称，与 zh locale (apps/web/src/locales/zh.json nav) 一致 */
export const NAV_ITEMS = [
  { name: '仪表盘', path: ROUTES.dashboard },
  { name: 'Agents', path: ROUTES.agents },
  { name: 'Providers', path: ROUTES.providers },
  { name: 'MCP', path: ROUTES.mcpServers },
  { name: 'Skills', path: ROUTES.skills },
  { name: '代码源', path: ROUTES.scmSources },
  { name: '运行记录', path: ROUTES.runs },
] as const

/**
 * User-menu entry labels (bottom-left avatar menu), aligned with the zh locale.
 * The user manual lives here rather than in the sidebar, directly above "About".
 */
export const USER_MENU_ITEMS = {
  wiki: '使用手册',
  about: '关于',
  logout: '退出登录',
} as const

/** ARIA landmark names, aligned with `common` in the zh locale. */
export const NAV_LANDMARKS = {
  main: '主导航',
} as const

/** Admin-only 导航项（仅管理员可见） */
export const ADMIN_NAV_ITEMS = [
  { name: '设置', path: ROUTES.settings },
  { name: '用户管理', path: ROUTES.users },
  { name: '审计日志', path: ROUTES.auditLogs },
] as const

/**
 * E2E admin 密码 — 必须通过 E2E_ADMIN_PASSWORD 环境变量提供。
 * playwright.config.ts webServer.env 会自动注入。
 */
export function getE2ePassword(): string {
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!password) {
    throw new Error('E2E_ADMIN_PASSWORD env var is required. Set it in .env or pass it via CLI.')
  }
  return password
}

/** E2E：`data-testid` 与 Web 一致，避免绑定 i18n 文案 */
export const TEST_IDS = {
  userMenuPopover: 'user-menu-popover',
  agentDetailMoreActions: 'agent-detail-more-actions',
  agentDiagnoseMenuItem: 'agent-diagnose-menu-item',
  agentDiagnoseModal: 'agent-diagnose-modal',
  agentDiagnoseTitle: 'agent-diagnose-title',
  agentDiagnoseCopy: 'agent-diagnose-copy',
} as const
