import { StyleProvider } from '@ant-design/cssinjs'
import { App as AntApp, ConfigProvider, Spin } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { lazy, Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { createBrowserRouter, Outlet } from 'react-router-dom'
import { AuthGuard } from './components/auth-guard'
import { ErrorBoundary } from './components/error-boundary'
import { Layout } from './components/layout'
import { ThemeProvider, useTheme } from './components/theme-provider'
import { useLocale } from './hooks/use-locale'
import { AntdStaticBridge } from './lib/antd-static'
import { createAntdTheme } from './lib/tokens'

const AgentDetailPage = lazy(() =>
  import('./pages/agent-detail').then((m) => ({ default: m.AgentDetailPage })),
)
const AgentsPage = lazy(() => import('./pages/agents').then((m) => ({ default: m.AgentsPage })))
const ChatAppPage = lazy(() => import('./pages/chat-app').then((m) => ({ default: m.ChatAppPage })))
const DashboardPage = lazy(() =>
  import('./pages/dashboard').then((m) => ({ default: m.DashboardPage })),
)
const LoginPage = lazy(() => import('./pages/login').then((m) => ({ default: m.LoginPage })))
const InvitePage = lazy(() => import('./pages/invite').then((m) => ({ default: m.InvitePage })))
const ShareLoginPage = lazy(() =>
  import('./pages/share-login').then((m) => ({ default: m.ShareLoginPage })),
)
const McpServersPage = lazy(() =>
  import('./pages/mcp-servers').then((m) => ({ default: m.McpServersPage })),
)
const ProviderDetailPage = lazy(() =>
  import('./pages/provider-detail').then((m) => ({ default: m.ProviderDetailPage })),
)
const ProvidersPage = lazy(() =>
  import('./pages/providers').then((m) => ({ default: m.ProvidersPage })),
)
const SetupPage = lazy(() => import('./pages/setup').then((m) => ({ default: m.SetupPage })))
const SkillsPage = lazy(() => import('./pages/skills').then((m) => ({ default: m.SkillsPage })))
const KbDocumentsPage = lazy(() =>
  import('./pages/kb-documents').then((m) => ({ default: m.KbDocumentsPage })),
)
const RunsPage = lazy(() => import('./pages/runs').then((m) => ({ default: m.RunsPage })))
const ScmSourcesPage = lazy(() =>
  import('./pages/scm-sources').then((m) => ({ default: m.ScmSourcesPage })),
)
const UsersPage = lazy(() => import('./pages/users').then((m) => ({ default: m.UsersPage })))
const AuditLogsPage = lazy(() =>
  import('./pages/audit-logs').then((m) => ({ default: m.AuditLogsPage })),
)
const ChangelogPage = lazy(() =>
  import('./pages/changelog').then((m) => ({ default: m.ChangelogPage })),
)
const WikiPage = lazy(() => import('./pages/wiki').then((m) => ({ default: m.WikiPage })))
const NotFoundPage = lazy(() =>
  import('./pages/not-found').then((m) => ({ default: m.NotFoundPage })),
)
const SettingsPage = lazy(() =>
  import('./pages/settings').then((m) => ({ default: m.SettingsPage })),
)

const antdLocales = { zh: zhCN, en: enUS } as const

function ThemedApplication({ antdLocale }: { antdLocale: typeof zhCN }) {
  const { resolvedTheme } = useTheme()
  const antdTheme = useMemo(() => createAntdTheme(resolvedTheme), [resolvedTheme])
  return (
    // StyleProvider layer: 把 antd 注入的全部样式（含 .ant-app a { color: colorLink } 这类
    // 全局 reset）包进 @layer antd。配合 globals.css 里声明的 layer 顺序，使 Tailwind 工具类
    // 稳定覆盖 antd 的 reset——否则 antd 的无 layer reset 会把所有 <a>/<Link> 染成 link 蓝。
    <StyleProvider layer>
      <ConfigProvider theme={antdTheme} locale={antdLocale} wave={{ disabled: true }}>
        {/* antd App: 提供 message/notification/modal 的 context holder（消费主题/locale）。
            cssVar 主题下 App 需一个真实 DOM 节点承载 css 变量类，故不能用 component={false}
            （否则报 "ensure component is assigned a valid React component string"）；改用默认
            div + display:contents（Tailwind contents），节点存在但不生成布局盒，仍不影响布局。 */}
        <AntApp className="contents">
          {/* 把 App 提供的 context-aware message/modal/notification 注册到 lib/antd-static
              的 live binding，供组件外（如 main.tsx）与各调用点复用，避免 antd 静态方法
              脱离 StyleProvider layer 注入无 layer 样式而破坏全局样式层叠。 */}
          <AntdStaticBridge />
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </AntApp>
      </ConfigProvider>
    </StyleProvider>
  )
}

function RootLayout() {
  const { i18n } = useTranslation()
  useLocale()
  const antdLocale = antdLocales[i18n.language as keyof typeof antdLocales] ?? zhCN

  return (
    <ThemeProvider>
      <ThemedApplication antdLocale={antdLocale} />
    </ThemeProvider>
  )
}

function ProtectedLayout() {
  return (
    <AuthGuard>
      <Layout>
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-screen">
              <Spin />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </Layout>
    </AuthGuard>
  )
}

/**
 * Authenticated but chrome-free: the chat app link opens a focused conversation
 * surface, so it keeps the AuthGuard (no anonymous access — Iron Rule 5) but drops
 * the admin console sidebar around it.
 */
function BareProtectedLayout() {
  return (
    <AuthGuard>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen">
            <Spin />
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </AuthGuard>
  )
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      // Public auth routes (no layout)
      {
        path: '/setup',
        element: (
          <Suspense fallback={null}>
            <SetupPage />
          </Suspense>
        ),
      },
      {
        path: '/login',
        element: (
          <Suspense fallback={null}>
            <LoginPage />
          </Suspense>
        ),
      },
      {
        path: '/share-login',
        element: (
          <Suspense fallback={null}>
            <ShareLoginPage />
          </Suspense>
        ),
      },
      // Invitation registration: public by necessity — the visitor has no account yet.
      {
        path: '/invite/:code',
        element: (
          <Suspense fallback={null}>
            <InvitePage />
          </Suspense>
        ),
      },
      // Authenticated, but without the console chrome
      {
        element: <BareProtectedLayout />,
        children: [{ path: '/agents/:id/chat_app', element: <ChatAppPage /> }],
      },
      // Protected routes (with auth guard + layout)
      {
        element: <ProtectedLayout />,
        children: [
          { path: '/', element: <DashboardPage /> },
          { path: '/agents', element: <AgentsPage /> },
          { path: '/agents/new', element: <AgentDetailPage /> },
          { path: '/agents/:id', element: <AgentDetailPage /> },
          { path: '/providers', element: <ProvidersPage /> },
          { path: '/providers/:id', element: <ProviderDetailPage /> },
          { path: '/mcp-servers', element: <McpServersPage /> },
          { path: '/skills', element: <SkillsPage /> },
          { path: '/kb-documents', element: <KbDocumentsPage /> },
          { path: '/runs', element: <RunsPage /> },
          { path: '/scm-sources', element: <ScmSourcesPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/users', element: <UsersPage /> },
          { path: '/audit-logs', element: <AuditLogsPage /> },
          { path: '/changelog', element: <ChangelogPage /> },
          { path: '/wiki', element: <WikiPage /> },
          { path: '/wiki/:slug', element: <WikiPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
])
