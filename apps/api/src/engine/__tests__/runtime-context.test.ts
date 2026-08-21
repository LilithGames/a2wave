import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  omitRuntimeEnvKeys,
  prepareRuntimeContext,
  sanitizeAgentRuntimeEnv,
} from '../runtime-context.js'
import type { ExecuteRequest } from '../types.js'

describe('runtime-context', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'a2wave-agent-homes-'))
    vi.stubEnv('A2WAVE_AGENT_HOMES_DIR', root)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  function makeReq(agentId: string, taskId = 'feishu/run_123/rst_456'): ExecuteRequest {
    return {
      taskId,
      workDir: '/workspace',
      prompt: 'hi',
      agentConfig: { agentId } as never,
    }
  }

  it('creates an isolated writable home tree for an agent', async () => {
    const ctx = prepareRuntimeContext(makeReq('agt_Is1_YuHw09MwlZAs'))

    expect(ctx.agentId).toBe('agt_Is1_YuHw09MwlZAs')
    expect(ctx.runId).toBe('run_123')
    expect(ctx.home.dir).toBe(join(root, 'agt_Is1_YuHw09MwlZAs'))
    expect(ctx.workspace).toMatchObject({
      dir: resolve('/workspace'),
      type: 'temp',
      cleanup: 'ttl',
    })
    expect(ctx.artifacts.dir).toBe(join(resolve('/workspace'), 'artifacts', 'run_123'))
    expect(ctx.env).toMatchObject({
      HOME: ctx.home.dir,
      A2WAVE_AGENT_HOME: ctx.home.dir,
      A2WAVE_AGENT_ID: 'agt_Is1_YuHw09MwlZAs',
      A2WAVE_RUN_ID: 'run_123',
      A2WAVE_WORKSPACE_DIR: ctx.workspace.dir,
      A2WAVE_ARTIFACTS_DIR: ctx.artifacts.dir,
      XDG_CACHE_HOME: ctx.home.cacheDir,
      XDG_CONFIG_HOME: ctx.home.configDir,
      TMPDIR: ctx.home.tmpDir,
      CODEX_HOME: ctx.home.codexHomeDir,
    })

    for (const dir of [
      ctx.home.dir,
      ctx.home.cacheDir,
      ctx.home.configDir,
      ctx.home.tmpDir,
      ctx.home.claudeDir,
      ctx.home.codexHomeDir,
    ]) {
      expect(existsSync(dir)).toBe(true)
    }
  })

  it('keeps different agents in different homes', async () => {
    const first = prepareRuntimeContext(makeReq('agt_one'))
    const second = prepareRuntimeContext(makeReq('agt_two'))

    expect(first.home.dir).not.toBe(second.home.dir)
    expect(first.env.HOME).not.toBe(second.env.HOME)
  })

  it('keeps existing workDir decisions observable without changing them', async () => {
    const configured = prepareRuntimeContext({
      ...makeReq('agt_configured'),
      agentConfig: { agentId: 'agt_configured', workDir: '/configured/from-agent' } as never,
    })
    const scm = prepareRuntimeContext({
      ...makeReq('agt_scm'),
      agentConfig: { agentId: 'agt_scm', workspaceType: 'scm', scmSourceId: 'scm_1' } as never,
    })

    expect(configured.workspace).toMatchObject({
      dir: resolve('/workspace'),
      type: 'configured',
      cleanup: 'never',
    })
    expect(scm.workspace).toMatchObject({
      dir: resolve('/workspace'),
      type: 'scm-local',
      cleanup: 'never',
      sourceId: 'scm_1',
    })
  })

  it('uses engine defaultWorkDir when request workDir is empty', async () => {
    const ctx = prepareRuntimeContext(
      {
        ...makeReq('agt_default_workdir'),
        workDir: '',
      },
      { defaultWorkDir: '/engine/default-workdir' },
    )

    expect(ctx.workspace.dir).toBe(resolve('/engine/default-workdir'))
    expect(ctx.artifacts.dir).toBe(join(resolve('/engine/default-workdir'), 'artifacts', 'run_123'))
    expect(ctx.env.A2WAVE_WORKSPACE_DIR).toBe(resolve('/engine/default-workdir'))
    expect(ctx.env.A2WAVE_ARTIFACTS_DIR).toBe(
      join(resolve('/engine/default-workdir'), 'artifacts', 'run_123'),
    )
  })

  it('creates the per-run artifacts directory so the Agent can write into it at once', async () => {
    // The directory is removed when the run settles, so unlike the old flat
    // artifacts/ on a warm workspace it never pre-exists: `cp x "$A2WAVE_ARTIFACTS_DIR/"`
    // would fail on every run unless the platform creates it.
    const workDir = mkdtempSync(join(tmpdir(), 'a2wave-workspace-'))
    try {
      const ctx = prepareRuntimeContext({ ...makeReq('agt_mkdir'), workDir })

      expect(ctx.artifacts.dir).toBe(join(workDir, 'artifacts', 'run_123'))
      expect(existsSync(ctx.artifacts.dir)).toBe(true)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('still prepares the context when the artifacts directory cannot be created', async () => {
    // A read-only or otherwise unwritable workspace must not fail the run here;
    // the engine and the collector cope with a missing directory on their own.
    // A path through a plain file fails with ENOTDIR as any user on any OS.
    const parent = mkdtempSync(join(tmpdir(), 'a2wave-workspace-'))
    const blocker = join(parent, 'not-a-dir')
    writeFileSync(blocker, '')
    try {
      const workDir = join(blocker, 'workspace')
      const ctx = prepareRuntimeContext({ ...makeReq('agt_ro'), workDir })

      expect(ctx.artifacts.dir).toBe(join(workDir, 'artifacts', 'run_123'))
      expect(existsSync(ctx.artifacts.dir)).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps the artifacts directory one flat segment when the taskId carries no run id', async () => {
    // extractRunId falls back to the whole taskId, which contains separators.
    // Interpolated raw it would nest the run's artifacts under invented
    // directories — and `..` would escape the workspace entirely.
    const ctx = prepareRuntimeContext(makeReq('agt_odd_task', '../evil/task'))

    expect(ctx.artifacts.dir).toBe(join(resolve('/workspace'), 'artifacts', '___evil_task'))
  })

  it('fails fast when neither request workDir nor defaultWorkDir is available', async () => {
    expect(() =>
      prepareRuntimeContext({
        ...makeReq('agt_missing_workdir'),
        workDir: '',
      }),
    ).toThrow(/workDir or engine defaultWorkDir/)
  })

  it('removes runtime-owned env keys without dropping internal a2wave transport keys', async () => {
    const sanitized = sanitizeAgentRuntimeEnv({
      HOME: '/bad-home',
      TMPDIR: '/bad-tmp',
      XDG_CACHE_HOME: '/bad-cache',
      XDG_CONFIG_HOME: '/bad-config',
      CODEX_HOME: '/bad-codex',
      A2WAVE_AGENT_HOME: '/bad-agent-home',
      A2WAVE_AGENT_ID: 'bad-agent',
      A2WAVE_RUN_ID: 'bad-run',
      A2WAVE_WORKSPACE_DIR: '/bad-workspace',
      A2WAVE_ARTIFACTS_DIR: '/bad-artifacts',
      A2WAVE_CHANNEL_B64: 'keep-channel',
      EXTERNAL_API_TOKEN: 'keep-token',
      CUSTOM: 'keep-custom',
    })

    expect(sanitized).toEqual({
      A2WAVE_CHANNEL_B64: 'keep-channel',
      EXTERNAL_API_TOKEN: 'keep-token',
      CUSTOM: 'keep-custom',
    })
  })

  it('strips process-injection env names so agent env cannot hijack the child process (P1)', async () => {
    // claude-code/cursor override buildEnv and route agent env only through
    // sanitizeAgentRuntimeEnv (not buildCredentialEnv), so this is the single
    // chokepoint that must drop loader/interpreter-injection vars. Without it an
    // editor could set NODE_OPTIONS=--require=/tmp/x.js and get code execution.
    const sanitized = sanitizeAgentRuntimeEnv({
      PATH: '/attacker/bin',
      NODE_OPTIONS: '--require=/tmp/evil.js',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      DYLD_LIBRARY_PATH: '/tmp',
      LD_AUDIT: '/tmp/evil-audit.so',
      GIT_SSH_COMMAND: 'sh -c "id"',
      GIT_SSH: '/tmp/evil-ssh',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      GIT_CONFIG_SYSTEM: '/tmp/evil.gitconfig',
      // bare GIT_CONFIG (no trailing underscore) — `git config` reads it as a
      // config file path; the /^GIT_CONFIG_/ prefix regex would miss it.
      GIT_CONFIG: '/tmp/evil.gitconfig',
      // git env vars that each point at an executable git will spawn.
      GIT_EXTERNAL_DIFF: '/bin/sh',
      GIT_PROXY_COMMAND: '/tmp/evil',
      GIT_PAGER: 'sh -c id',
      GIT_EDITOR: '/tmp/evil',
      GIT_SEQUENCE_EDITOR: '/tmp/evil',
      GIT_ASKPASS: '/tmp/evil',
      GIT_MERGE_TOOL: '/tmp/evil',
      GIT_EXEC_PATH: '/tmp/evil-git-exec',
      SSH_ASKPASS: '/tmp/evil',
      BASH_ENV: '/tmp/evil.sh',
      ENV: '/tmp/evil.sh',
      PAGER: 'sh -c id',
      SAFE_VAR: 'keep-me',
    })

    expect(sanitized).toEqual({ SAFE_VAR: 'keep-me' })
  })

  it('strips the GIT_CONFIG_COUNT/KEY_n/VALUE_n family (env-only git config injection)', async () => {
    // git reads config directly from env when GIT_CONFIG_COUNT is set — no file
    // needed. GIT_CONFIG_KEY_0=core.hooksPath + GIT_CONFIG_VALUE_0=/tmp/evil is
    // arbitrary command execution the moment the agent runs git. These are
    // indexed names, so an exact-match denylist (GIT_CONFIG_GLOBAL only) misses
    // them; the family must be matched by pattern.
    const sanitized = sanitizeAgentRuntimeEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/evil-hooks',
      GIT_CONFIG_KEY_12: 'core.fsmonitor',
      GIT_CONFIG_VALUE_12: '/tmp/evil',
      // GIT_CONFIG_PARAMETERS is git's OTHER env config channel: a single
      // shell-quoted string of `key=value` pairs, also honored for core.hooksPath.
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/evil-hooks'",
      SAFE_VAR: 'keep-me',
    })

    expect(sanitized).toEqual({ SAFE_VAR: 'keep-me' })
  })

  it('strips the entire GIT_CONFIG_* family (defense in depth — no agent needs any of them)', async () => {
    // The whole GIT_CONFIG_* prefix is a config-injection channel; blanket-strip
    // it so a future/obscure variant can't slip through. No legitimate agent env
    // sets a GIT_CONFIG_* variable.
    const sanitized = sanitizeAgentRuntimeEnv({
      GIT_CONFIG_KEYRING: '/tmp/evil',
      GIT_CONFIG_NOSYSTEM: '1',
      SAFE_VAR: 'keep-me',
    })
    expect(sanitized).toEqual({ SAFE_VAR: 'keep-me' })
  })

  it('does not over-strip names that merely resemble a blocked family', async () => {
    // The prefix families anchor at the start of the name, so a var that only
    // CONTAINS a blocked token (or belongs to a different namespace) survives.
    const sanitized = sanitizeAgentRuntimeEnv({
      GIT_AUTHOR_NAME: 'keep', // real git var, harmless (not an executable/config channel)
      MY_GIT_CONFIG_KEY_0: 'keep', // different namespace prefix
      MY_LD_PRELOAD: 'keep',
      OLD_PATH: 'keep',
      API_KEY: 'keep', // ordinary credential/config
      MY_SERVICE_URL: 'keep',
    })
    expect(sanitized).toEqual({
      GIT_AUTHOR_NAME: 'keep',
      MY_GIT_CONFIG_KEY_0: 'keep',
      MY_LD_PRELOAD: 'keep',
      OLD_PATH: 'keep',
      API_KEY: 'keep',
      MY_SERVICE_URL: 'keep',
    })
  })

  it('strips the LD_*/DYLD_* dynamic-loader families including future variants', async () => {
    const sanitized = sanitizeAgentRuntimeEnv({
      LD_PRELOAD: '/tmp/evil.so',
      LD_AUDIT: '/tmp/a.so',
      LD_LIBRARY_PATH: '/tmp',
      LD_SOMETHING_NEW: '/tmp', // hypothetical future loader knob — caught by prefix
      DYLD_INSERT_LIBRARIES: '/tmp/e.dylib',
      DYLD_LIBRARY_PATH: '/tmp',
      DYLD_FALLBACK_LIBRARY_PATH: '/tmp',
      SAFE_VAR: 'keep-me',
    })
    expect(sanitized).toEqual({ SAFE_VAR: 'keep-me' })
  })

  it('strips the npm_config_* channel including case and dash/underscore variants', async () => {
    // npm maps env `npm_config_<key>` onto any npm config, e.g. script-shell —
    // `npm_config_script_shell=/bin/echo npm run x` runs /bin/echo. npm normalizes
    // the name (lowercase, `-`↔`_`), so exact-name matching misses variants.
    const sanitized = sanitizeAgentRuntimeEnv({
      npm_config_script_shell: '/bin/echo',
      NPM_CONFIG_SCRIPT_SHELL: '/bin/echo', // uppercase variant
      'npm_config_script-shell': '/bin/echo', // dash variant
      npm_config_shell: '/bin/echo',
      npm_config_node_gyp: '/tmp/evil',
      SAFE_VAR: 'keep-me',
    })
    expect(sanitized).toEqual({ SAFE_VAR: 'keep-me' })
  })

  it('can omit selected runtime env keys while preserving platform metadata', async () => {
    expect(
      omitRuntimeEnvKeys(
        {
          HOME: '/runtime-home',
          CODEX_HOME: '/runtime-codex',
          A2WAVE_AGENT_HOME: '/runtime-home',
          TMPDIR: '/runtime-tmp',
        },
        ['HOME', 'CODEX_HOME'],
      ),
    ).toEqual({
      A2WAVE_AGENT_HOME: '/runtime-home',
      TMPDIR: '/runtime-tmp',
    })
  })
})
