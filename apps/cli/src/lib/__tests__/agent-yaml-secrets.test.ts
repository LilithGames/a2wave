import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliError } from '../../errors.js'
import { expandEnvVars, parseAgentYaml } from '../agent-yaml.js'

/**
 * Secret inputs for `agents apply`: `file:<path>` references and `${ENV}`
 * placeholders. A pasted OAuth token once arrived with a header line and a
 * line-wrapped body, and the CLI stored the garbage verbatim — publish
 * succeeded and the Agent could not run. These pin the hardening.
 */
describe('agent yaml secret inputs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a2wave-yaml-secrets-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeYaml(content: string, name = 'agent.yaml'): string {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  }

  describe('file:<path> references', () => {
    it('reads providerApiKey from a file relative to the YAML directory', () => {
      writeFileSync(join(dir, 'key.txt'), 'sk-ant-api03-abc\n')
      const p = writeYaml('name: bot\nproviderApiKey: file:key.txt\n')
      expect(parseAgentYaml(p, {}).providerApiKey).toBe('sk-ant-api03-abc')
    })

    it('resolves a nested relative path against the YAML directory, not cwd', () => {
      mkdirSync(join(dir, 'secrets'))
      writeFileSync(join(dir, 'secrets', 'oauth.txt'), 'sk-ant-oat01-xyz')
      const p = writeYaml('name: bot\nproviderOauthToken: file:./secrets/oauth.txt\n')
      expect(parseAgentYaml(p, {}).providerOauthToken).toBe('sk-ant-oat01-xyz')
    })

    it('accepts an absolute path', () => {
      const abs = join(dir, 'embed.txt')
      writeFileSync(abs, 'emb-key-123')
      const p = writeYaml(`name: bot\nembeddingApiKey: file:${abs}\n`)
      expect(parseAgentYaml(p, {}).embeddingApiKey).toBe('emb-key-123')
    })

    it('expands ~ to the home directory', () => {
      const home = join(dir, 'home')
      mkdirSync(home)
      writeFileSync(join(home, 'k.txt'), 'sk-ant-home')
      const p = writeYaml('name: bot\nproviderApiKey: file:~/k.txt\n')
      expect(parseAgentYaml(p, {}, { homeDir: home }).providerApiKey).toBe('sk-ant-home')
    })

    it('accepts a single-line token surrounded by blank lines and a trailing newline', () => {
      writeFileSync(join(dir, 'k.txt'), '\n\n   sk-ant-oat01-AAAA-BBBB  \n\n')
      const p = writeYaml('name: bot\nproviderOauthToken: file:k.txt\n')
      expect(parseAgentYaml(p, {}).providerOauthToken).toBe('sk-ant-oat01-AAAA-BBBB')
    })

    it('keeps a non-Anthropic token whole', () => {
      writeFileSync(join(dir, 'k.txt'), '  gsk_live_123\n')
      const p = writeYaml('name: bot\nproviderApiKey: file:k.txt\n')
      expect(parseAgentYaml(p, {}).providerApiKey).toBe('gsk_live_123')
    })

    it('rejects a header line before the token, naming the file and the field', () => {
      writeFileSync(join(dir, 'oauth.txt'), 'Your OAuth token is:\nsk-ant-oat01-AAAA\n')
      const p = writeYaml('name: bot\nproviderOauthToken: file:oauth.txt\n')
      expect(() => parseAgentYaml(p, {})).toThrow(CliError)
      expect(() => parseAgentYaml(p, {})).toThrow(/providerOauthToken.*oauth\.txt.*single line/s)
      expect(() => parseAgentYaml(p, {})).toThrow(/join/i)
    })

    it('rejects a token wrapped across two lines instead of fusing it', () => {
      writeFileSync(join(dir, 'oauth.txt'), 'sk-ant-oat01-AAAA\nBBBB-CCCC\n')
      const p = writeYaml('name: bot\nproviderOauthToken: file:oauth.txt\n')
      expect(() => parseAgentYaml(p, {})).toThrow(/single line/)
    })

    it('rejects a single-line token with an internal space', () => {
      writeFileSync(join(dir, 'k.txt'), 'sk-ant api03-abc\n')
      const p = writeYaml('name: bot\nproviderApiKey: file:k.txt\n')
      expect(() => parseAgentYaml(p, {})).toThrow(/providerApiKey.*whitespace/)
    })

    it('resolves chain-entry credentials inside config.providerChain[]', () => {
      writeFileSync(join(dir, 'a.txt'), 'sk-ant-api03-chainA\n')
      writeFileSync(join(dir, 'b.txt'), 'sk-ant-oat01-chainB\n')
      const p = writeYaml(`name: bot
config:
  providerChain:
    - providerId: prv_a
      providerApiKey: file:a.txt
    - providerId: prv_b
      providerOauthToken: file:b.txt
`)
      const chain = parseAgentYaml(p, {}).config?.providerChain as Array<Record<string, unknown>>
      expect(chain[0].providerApiKey).toBe('sk-ant-api03-chainA')
      expect(chain[1].providerOauthToken).toBe('sk-ant-oat01-chainB')
    })

    it('leaves non-secret fields alone even when they start with file:', () => {
      const p = writeYaml('name: bot\ndescription: "file:not-a-secret.txt"\n')
      expect(parseAgentYaml(p, {}).description).toBe('file:not-a-secret.txt')
    })

    it('fails clearly when the file is missing', () => {
      const p = writeYaml('name: bot\nproviderApiKey: file:missing.txt\n')
      expect(() => parseAgentYaml(p, {})).toThrow(CliError)
      expect(() => parseAgentYaml(p, {})).toThrow(/providerApiKey.*missing\.txt/)
    })

    it('fails clearly when the file is empty or whitespace only', () => {
      writeFileSync(join(dir, 'empty.txt'), '\n  \n')
      const p = writeYaml('name: bot\nproviderApiKey: file:empty.txt\n')
      expect(() => parseAgentYaml(p, {})).toThrow(/empty/)
    })

    it('fails when the file content still holds non-printable characters', () => {
      writeFileSync(join(dir, 'bad.txt'), 'sk-ant-\u0007bell')
      const p = writeYaml('name: bot\nproviderApiKey: file:bad.txt\n')
      expect(() => parseAgentYaml(p, {})).toThrow(/non-printable/)
    })

    it('lets the path itself use an ENV placeholder', () => {
      writeFileSync(join(dir, 'env-key.txt'), 'sk-ant-from-env-path')
      const p = writeYaml(`name: bot\nproviderApiKey: file:\${KEY_FILE}\n`)
      expect(parseAgentYaml(p, { KEY_FILE: 'env-key.txt' }).providerApiKey).toBe(
        'sk-ant-from-env-path',
      )
    })
  })

  describe('ENV placeholders', () => {
    it('fails naming the variable when it is not set (never expands to empty)', () => {
      const p = writeYaml(`name: bot\nproviderApiKey: \${A2WAVE_UNSET_KEY}\n`)
      expect(() => parseAgentYaml(p, {})).toThrow(
        /Environment variable A2WAVE_UNSET_KEY referenced by the YAML is not set/,
      )
    })

    it('fails when a credential references an exported-but-empty variable', () => {
      const p = writeYaml(`name: bot\nproviderApiKey: \${EMPTY}\n`)
      expect(() => parseAgentYaml(p, { EMPTY: '' })).toThrow(/EMPTY/)
    })

    it('fails when a chain-entry credential references an exported-but-empty variable', () => {
      const p = writeYaml(`name: bot
config:
  providerChain:
    - providerId: prv_a
      providerOauthToken: \${EMPTY}
`)
      expect(() => parseAgentYaml(p, { EMPTY: '' })).toThrow(/EMPTY/)
    })

    it('expands an exported-but-empty variable to "" for a non-credential field', () => {
      const p = writeYaml(`name: bot
env:
  OPTIONAL_FLAG:
    value: \${EMPTY}
description: "prefix-\${EMPTY}-suffix"
`)
      const doc = parseAgentYaml(p, { EMPTY: '' })
      expect((doc.env as Record<string, { value: string }>).OPTIONAL_FLAG.value).toBe('')
      expect(doc.description).toBe('prefix--suffix')
    })

    it('still fails on a truly unset variable in a non-credential field', () => {
      const p = writeYaml(`name: bot\nenv:\n  X:\n    value: \${A2WAVE_UNSET_FLAG}\n`)
      expect(() => parseAgentYaml(p, {})).toThrow(/A2WAVE_UNSET_FLAG/)
    })

    it('expandEnvVars by itself keeps the empty-is-a-value contract', () => {
      expect(expandEnvVars(`\${EMPTY}`, { EMPTY: '' })).toBe('')
    })
  })

  describe('secret value validation (any source)', () => {
    it('rejects an ENV-sourced secret containing a newline', () => {
      const p = writeYaml(`name: bot\nproviderOauthToken: \${TOK}\n`)
      expect(() => parseAgentYaml(p, { TOK: 'sk-ant-oat01-abc\n' })).toThrow(
        /providerOauthToken.*whitespace/,
      )
    })

    it('rejects a literal secret containing an inner space', () => {
      const p = writeYaml('name: bot\nembeddingApiKey: "abc def"\n')
      expect(() => parseAgentYaml(p, {})).toThrow(/embeddingApiKey.*whitespace/)
    })

    it('rejects a chain-entry secret containing whitespace, naming the entry', () => {
      const p = writeYaml(`name: bot
config:
  providerChain:
    - providerId: prv_a
      providerApiKey: "sk-ant x"
`)
      expect(() => parseAgentYaml(p, {})).toThrow(/providerChain\[0\]\.providerApiKey/)
    })

    it('accepts a clean literal secret', () => {
      const p = writeYaml('name: bot\nproviderApiKey: sk-ant-api03-clean\n')
      expect(parseAgentYaml(p, {}).providerApiKey).toBe('sk-ant-api03-clean')
    })
  })
})
