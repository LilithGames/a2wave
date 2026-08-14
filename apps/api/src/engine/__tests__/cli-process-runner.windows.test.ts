import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CliProcessRunner } from '../cli-process-runner.js'

let testRoot: string | undefined

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true })
  testRoot = undefined
})

it.skipIf(process.platform !== 'win32')(
  'runs a bare npm-style .cmd shim and preserves shell metacharacters',
  async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'a2wave-cli-spawn-'))
    const binDir = join(testRoot, 'bin with spaces')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'fixture-cli.cmd'),
      '@echo off\r\n"%~1" -e "process.stdout.write(process.argv[1])" "%~2"\r\n',
    )

    const output: string[] = []
    const runner = new CliProcessRunner()
    const result = await runner.run({
      taskId: 'windows_cmd_fixture',
      command: 'fixture-cli',
      args: [process.execPath, 'hello & goodbye'],
      cwd: testRoot,
      env: { ...process.env, PATH: `${binDir};${process.env.PATH ?? ''}` },
      timeoutMs: 10_000,
      label: 'Windows cmd fixture',
      onStdoutLine: (line) => output.push(line),
    })

    expect(result).toMatchObject({ reason: 'completed', exitCode: 0 })
    expect(output).toEqual(['hello & goodbye'])
  },
)

it.skipIf(process.platform !== 'win32')(
  'streams multiline input through an npm-style .cmd shim without truncation',
  async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'a2wave-cli-stdin-'))
    const binDir = join(testRoot, 'bin with spaces')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'fixture-cli.cmd'),
      '@echo off\r\n"%~1" -e "process.stdin.pipe(process.stdout)"\r\n',
    )

    const input = '<system>\r\nfirst line\r\nsecond line\r\n</system>'
    const output: string[] = []
    const runner = new CliProcessRunner()
    const result = await runner.run({
      taskId: 'windows_cmd_stdin_fixture',
      command: 'fixture-cli',
      args: [process.execPath],
      stdin: input,
      cwd: testRoot,
      env: { ...process.env, PATH: `${binDir};${process.env.PATH ?? ''}` },
      timeoutMs: 10_000,
      label: 'Windows cmd stdin fixture',
      onStdoutLine: (line) => output.push(line),
    })

    expect(result).toMatchObject({ reason: 'completed', exitCode: 0 })
    expect(output).toEqual(['<system>\r', 'first line\r', 'second line\r', '</system>'])
  },
)
