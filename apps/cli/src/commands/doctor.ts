import { defineCommand } from 'citty'
import { urlArg } from '../client.js'
import { type Check, runChecks } from '../lib/checks.js'
import { emit, jsonArg } from '../lib/output.js'

/**
 * `status` renders a narrative for a human; `doctor` renders a checklist.
 *
 * They share `runChecks()`, so there is one place a probe can be wrong. The
 * difference is the shape of the answer: every row here is individually
 * addressable by a stable `name`, so an agent can test one precondition
 * (`instance.health`) or the rollup (`ok`) without parsing prose, and every
 * non-pass row carries the command that clears it.
 *
 * Three states, not two. A `warn` must not fail the run — an optional or
 * cosmetic issue reading as a broken install is how a caller learns to ignore
 * an exit code.
 */
const ICON: Record<Check['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
}

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    agentMeta: { risk: 'read' },
    description: 'Run the CLI self-diagnosis as an addressable checklist (exit 1 on any failure)',
  },
  args: { ...jsonArg, ...urlArg },
  run: async ({ args }) => {
    const report = await runChecks({ urlOverride: args.url as string | undefined })

    // Set the exit code BEFORE emit(), which returns as soon as it prints:
    // deciding it afterwards would make `doctor --json | jq` exit 0 on a red
    // report. Same trap `agents diagnose` and `eval run --wait` guard against.
    if (!report.ok) process.exitCode = 1
    if (emit(args, report)) return

    for (const check of report.checks) {
      console.log(`${ICON[check.status]} ${check.name}: ${check.message}`)
      // A warn that does not say how to clear it is just noise.
      if (check.hint) console.log(`    → ${check.hint}`)
    }

    const count = (status: Check['status']) =>
      report.checks.filter((c) => c.status === status).length
    const warned = count('warn')
    const failed = count('fail')
    const summary = [
      `${count('pass')} passed`,
      warned ? `${warned} warned` : null,
      failed ? `${failed} failed` : null,
    ]
      .filter(Boolean)
      .join(', ')
    console.log(`\n${report.ok ? '✓' : '✗'} ${summary}`)
  },
})
