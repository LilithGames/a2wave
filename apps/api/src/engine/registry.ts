import { env } from '../env.js'
import { logger } from '../lib/logger.js'
import { ClaudeCodeEngine } from './claude-code.js'
import { cliProcessRunner } from './cli-process-runner.js'
import { CodexAgentEngine } from './codex-agent.js'
import { CursorAgentEngine } from './cursor-agent.js'
import { KimiAgentEngine } from './kimi-agent.js'
import { OpencodeAgentEngine } from './opencode-agent.js'
import { PiAgentEngine } from './pi-agent.js'
import { providerCatalog } from './provider-catalog.js'
import { QoderAgentEngine } from './qoder-agent.js'
import { TraeAgentEngine } from './trae-agent.js'
import type { AgentEngine } from './types.js'

/**
 * How long an aggregate health probe stays valid.
 *
 * Every probe spawns one CLI per registered Provider (`<cli> --version`, 10s
 * timeout each) and `GET /api/health` is unauthenticated and mounted ahead of
 * the rate limiter — without a cache, a trivial request loop turns into an
 * unbounded process fan-out. 30s is short enough that an operator watching the
 * probe still sees a newly installed/removed CLI promptly.
 */
export const ENGINE_HEALTH_CACHE_TTL_MS = 30_000

class EngineRegistry {
  private readonly engines = new Map<string, AgentEngine>()
  private healthCache: { at: number; results: Record<string, boolean> } | null = null
  private healthInFlight: Promise<Record<string, boolean>> | null = null

  register(engine: AgentEngine): void {
    this.engines.set(engine.type, engine)
    // A cached aggregate no longer describes the registry.
    this.healthCache = null
    logger.info({ type: engine.type }, 'Registered agent engine')
  }

  get(type: string): AgentEngine | undefined {
    return this.engines.get(type)
  }

  getOrThrow(type: string): AgentEngine {
    const engine = this.engines.get(type)
    if (!engine) {
      throw new Error(
        `No engine registered for type "${type}". Available: [${[...this.engines.keys()].join(', ')}]`,
      )
    }
    return engine
  }

  /**
   * Aggregate every engine's health, memoized for {@link ENGINE_HEALTH_CACHE_TTL_MS}
   * and coalesced across concurrent callers, so N simultaneous requests cost one
   * probe round instead of N × (one CLI spawn per engine).
   */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const cached = this.healthCache
    if (cached && Date.now() - cached.at < ENGINE_HEALTH_CACHE_TTL_MS) {
      return { ...cached.results }
    }
    if (this.healthInFlight) return { ...(await this.healthInFlight) }

    const probe = this.probeAllEngines()
    this.healthInFlight = probe
    try {
      const results = await probe
      this.healthCache = { at: Date.now(), results }
      return { ...results }
    } finally {
      if (this.healthInFlight === probe) this.healthInFlight = null
    }
  }

  private async probeAllEngines(): Promise<Record<string, boolean>> {
    const entries = [...this.engines]
    // Parallel: the probes are independent spawns, and a sequential loop made the
    // worst case the SUM of every CLI's 10s timeout.
    const states = await Promise.all(
      entries.map(([, engine]) => engine.healthCheck().catch(() => false)),
    )
    return Object.fromEntries(entries.map(([type], i) => [type, states[i] ?? false]))
  }

  /** Cancel the active CLI process by taskId, regardless of its Provider. */
  cancel(taskId: string): Promise<boolean> {
    return cliProcessRunner.cancelAndWait(taskId)
  }

  /** Gracefully terminate every active CLI process and wait for cleanup. */
  shutdown(): Promise<void> {
    return cliProcessRunner.shutdown()
  }

  get types(): string[] {
    return [...this.engines.keys()]
  }
}

export const engineRegistry = new EngineRegistry()

function registerProviderEngine(engine: AgentEngine): void {
  providerCatalog.attachEngine(engine)
  engineRegistry.register(engine)
}

registerProviderEngine(
  new CursorAgentEngine({
    path: env.CURSOR_AGENT_PATH,
    apiKey: env.CURSOR_API_KEY,
    timeoutMinutes: env.CURSOR_AGENT_TIMEOUT_MINUTES,
    agentForce: env.CURSOR_AGENT_FORCE,
    approveMcps: env.CURSOR_AGENT_APPROVE_MCPS,
    defaultWorkDir: env.CURSOR_AGENT_WORK_DIR,
  }),
)

registerProviderEngine(
  new ClaudeCodeEngine({
    path: env.CLAUDE_CODE_PATH,
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    timeoutMinutes: env.CLAUDE_CODE_TIMEOUT_MINUTES,
    force: env.CLAUDE_CODE_FORCE,
    approveMcps: env.CLAUDE_CODE_APPROVE_MCPS,
    defaultWorkDir: env.CLAUDE_CODE_WORK_DIR,
  }),
)

registerProviderEngine(
  new CodexAgentEngine({
    path: env.CODEX_PATH,
    apiKey: env.OPENAI_API_KEY || env.CODEX_API_KEY,
    timeoutMinutes: env.CODEX_TIMEOUT_MINUTES,
    force: env.CODEX_FORCE,
    approveMcps: env.CODEX_APPROVE_MCPS,
    defaultWorkDir: env.CODEX_WORK_DIR,
  }),
)

registerProviderEngine(
  new OpencodeAgentEngine({
    path: env.OPENCODE_PATH,
    timeoutMinutes: env.OPENCODE_TIMEOUT_MINUTES,
    defaultWorkDir: env.OPENCODE_WORK_DIR,
  }),
)

registerProviderEngine(
  new QoderAgentEngine({
    path: env.QODER_PATH,
    apiKey: env.QODER_PERSONAL_ACCESS_TOKEN,
    timeoutMinutes: env.QODER_TIMEOUT_MINUTES,
    force: env.QODER_FORCE,
    approveMcps: env.QODER_APPROVE_MCPS,
    defaultWorkDir: env.QODER_WORK_DIR,
  }),
)

registerProviderEngine(
  new KimiAgentEngine({
    path: env.KIMI_PATH,
    timeoutMinutes: env.KIMI_TIMEOUT_MINUTES,
    defaultWorkDir: env.KIMI_WORK_DIR,
  }),
)

registerProviderEngine(
  new PiAgentEngine({
    path: env.PI_PATH,
    timeoutMinutes: env.PI_TIMEOUT_MINUTES,
    defaultWorkDir: env.PI_WORK_DIR,
    agentDir: env.PI_CODING_AGENT_DIR,
  }),
)

registerProviderEngine(
  new TraeAgentEngine({
    path: env.TRAE_PATH,
    apiKey: env.TRAECLI_PERSONAL_ACCESS_TOKEN,
    host: env.TRAECLI_HOST,
    timeoutMinutes: env.TRAE_TIMEOUT_MINUTES,
    force: env.TRAE_FORCE,
    approveMcps: env.TRAE_APPROVE_MCPS,
    defaultWorkDir: env.TRAE_WORK_DIR,
  }),
)

function shutdownOnSignal(signal: 'SIGTERM' | 'SIGINT'): void {
  logger.info({ signal }, 'Received shutdown signal, terminating all Agent CLI processes')
  void engineRegistry.shutdown().catch((error) => {
    logger.error({ signal, error }, 'Failed to shut down Agent CLI processes cleanly')
  })
}

process.on('SIGTERM', () => shutdownOnSignal('SIGTERM'))
process.on('SIGINT', () => shutdownOnSignal('SIGINT'))

export { providerCatalog }
