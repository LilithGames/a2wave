/**
 * The agent guide's prose, plus the generated command map.
 *
 * Everything a CONSUMING agent needs and nothing a contributor needs — no
 * directory layout, no release flow, no gate scripts. Kept under 400 lines on
 * purpose: this is read into a context window, and a guide nobody can afford to
 * read is a guide nobody reads.
 *
 * Each group in the map carries NEGATIVE routing ("not this — that"), because
 * the failure an agent actually makes is reaching for a plausible neighbour,
 * not failing to find anything.
 */

/**
 * Per-group prose. The leaf list under each heading is generated, so a command
 * added or removed upstream cannot leave the map describing a CLI that is gone.
 */
const GROUPS = [
  {
    prefix: 'agents',
    title: 'agents — the unit everything else hangs off',
    notFor: [
      '`agents update` changes SINGLE fields (name, description, one skill). Full config changes go to `agents apply` with a YAML — a sequence of `update` calls is not equivalent and will not converge.',
      '`agents get` is not a health check. For "why does this fail", use `agents diagnose`.',
      '`agents stats` returns the object directly, NOT wrapped in `{data}` — the one endpoint that differs.',
    ],
  },
  {
    prefix: 'runs',
    title: 'runs — what an Agent actually did',
    notFor: [
      '`runs logs` is untruncated NDJSON and can reach 256 MiB. Do NOT use it to check status — use `runs get <id> --fields data.status`.',
      '`runs list --status` narrows the CURRENT PAGE only; the API has no status filter. Read `filter.matchedOnPage`, never treat it as a total.',
      '`runs rerun` replays the original intent. To run something new, use `runs trigger` or `chat send`.',
    ],
  },
  {
    prefix: 'chat',
    title: 'chat — conversational invocation',
    notFor: [
      'The `run_xxx` id from `chat list` and the `chat-id` are DIFFERENT. Passing a run id to `--chat-id` silently starts a new conversation instead of resuming.',
      '`chat send --json` implies `--no-stream` and requires `-m`; an interactive session has no single payload.',
    ],
  },
  {
    prefix: 'skills',
    title: 'skills — reusable instruction packages',
    notFor: [
      '`skills update` edits an existing Skill in place. To pull a newer upstream version, use `skills check-update` then `skills update-remote`.',
    ],
  },
  {
    prefix: 'mcp',
    title: 'mcp — tool servers',
    notFor: [
      'Use `--endpoint`, not `--url`, for an sse/http server address. `--url` targets the a2wave instance.',
      'The `group` type has no flags; pass `--config-file <json>`.',
    ],
  },
  {
    prefix: 'scm',
    title: 'scm — code checkouts',
    notFor: [
      '`scm sync` is async and answers 202. It does not mean the checkout is ready — poll `scm status`.',
      '`scm check` tests connectivity only; it changes nothing.',
    ],
  },
  {
    prefix: 'kb',
    title: 'kb — knowledge base documents',
    notFor: ['`kb create` is for a Feishu/Notion SOURCE. For a local file use `kb upload`.'],
  },
  {
    prefix: 'eval',
    title: 'eval — replay a case set against the current config',
    notFor: [
      '`eval run` returns immediately with a task id. Add `--wait` for a CI gate, and `--fail-on-fail` to also fail on a case verdict — `--wait` alone passes a task whose cases all errored.',
      'Evaluations write NO `runs` rows. Do not look for them in `runs list`.',
    ],
  },
  {
    prefix: 'providers',
    title: 'providers — read-only preset entities',
    notFor: [
      'There is no `providers create` or `update`. Providers have no editable field; model catalogs are probed per credential, never stored.',
    ],
  },
  {
    prefix: 'config',
    title: 'config — which instance and which credential',
    notFor: [
      'Prefer `--url` per command over changing global config: an agent that mutates shared config affects every other caller on the machine.',
    ],
  },
  {
    prefix: 'api',
    title: 'api — the raw escape hatch',
    notFor: [
      'Reach for this LAST. A typed command validates parameters, resolves names to IDs and carries usage guidance that `api` cannot.',
      'Any non-GET requires `--yes`. The CLI cannot know what an arbitrary write does, so it assumes the worst.',
      'The path must start with `/api/`. To hit another instance use `--url`, never a full URL in the path.',
    ],
  },
]

/** Groups with no dedicated prose still appear, just without negative routing. */
function groupFor(path) {
  const first = path.split(' ')[0]
  return GROUPS.find((g) => g.prefix === first)
}

function renderCommandMap(leafPaths) {
  const seen = new Set()
  const lines = []

  for (const group of GROUPS) {
    const paths = leafPaths.filter((p) => p.split(' ')[0] === group.prefix)
    if (paths.length === 0) continue
    for (const p of paths) seen.add(p)
    lines.push(`### ${group.title}`, '')
    lines.push('```')
    for (const p of paths) lines.push(`a2wave ${p}`)
    lines.push('```', '')
    lines.push('Not for:', '')
    for (const note of group.notFor) lines.push(`- ${note}`)
    lines.push('')
  }

  const rest = leafPaths.filter((p) => !seen.has(p) && !groupFor(p))
  if (rest.length > 0) {
    lines.push('### everything else', '')
    lines.push('```')
    for (const p of rest) lines.push(`a2wave ${p}`)
    lines.push('```', '')
  }

  return lines.join('\n')
}

export function buildGuideMarkdown(leafPaths) {
  return `# a2wave CLI — agent guide

You are the intended caller of this tool. It is designed for a program, not a
person: every read answers in JSON, every failure carries a machine-readable
type, and every command declares what it will do before you run it.

Read this once. Then use \`a2wave schema <command> --brief\` for specifics —
this guide covers the rules that hold across ALL commands, which is what a
per-command lookup cannot tell you.

## The loop

Four steps, in order. Skipping step 2 is the most common cause of a wasted call.

1. \`a2wave --help\` — find the command group.
2. \`a2wave schema <command> --brief\` — get the parameter spec, the risk label
   and the required arguments. \`--brief\` is the default on wide commands
   because a full spec can cost more context than the answer you wanted.
3. \`a2wave <command> ... --dry-run\` — where the command offers it
   (\`agents apply\` does), see the diff before writing anything.
4. Call it, with \`--json --fields <paths>\` so the reply fits.

Prefer a **typed command over \`api\`**, always. \`api\` is the escape hatch for
routes with no typed command yet: it cannot resolve a name to an ID, cannot
validate a parameter, and requires \`--yes\` for every write because it has no
idea what the route does.

## The output contract

- \`--json\` — compact single-line JSON, the raw API payload. Indentation is
  9-25% of the bytes and buys you nothing, so it is off by default.
- \`--json-pretty\` — the same payload, indented. For a human.
- \`--fields <paths>\` — comma-separated dot paths, \`[]\` to map an array:
  \`data[].id,data[].name\`. Implies \`--json\`. **This is the single biggest
  token lever available**: >90% smaller on a list projection. A path that
  matches nothing is omitted rather than fatal, and comes back under
  \`_meta.unmatchedFields\` so you can correct without another round trip.
- \`--show-secrets\` — credentials print as \`********\` by default, because CLI
  output lands in scrollback and CI logs. Pass this only when piping to a secure
  consumer.

Human-readable output stays the default for a bare invocation. JSON is opt-in.

### The error envelope

Errors always go to **stderr** and always exit non-zero, so a caller piping
stdout into a parser never gets the payload and the failure interleaved. Under
any JSON flag, stderr carries one object:

\`\`\`json
{"ok":false,"error":{"type":"auth","subtype":"expired","message":"Session expired or invalid.","hint":"a2wave login"}}
\`\`\`

Branch on \`type\`, never on the message text. Absent fields are **omitted, not
null**.

| \`type\` | What to do |
|---|---|
| \`auth\` | Your credential. Run the \`hint\` (usually \`a2wave login\`). |
| \`permission\` | Authenticated but not allowed. Do not retry. |
| \`not_found\` | The id or name does not exist here. Re-list. |
| \`conflict\` | State prevents it (a 409 — e.g. deleting a referenced resource). |
| \`rate_limit\` | Back off and retry. |
| \`validation\` | Bad input. Fix the argument; retrying unchanged will not help. |
| \`server\` | 5xx. Retrying may help. |
| \`network\` | The instance is unreachable. Check \`a2wave status\`. |
| \`confirmation\` | Needs \`--yes\`. **The error you will hit most**, since you have no TTY. |
| \`cli\` | A deliberate CLI failure; read the message. |
| \`internal\` | A bug in this CLI. Report it. |

\`hint\` is a runnable next step, not advice. If there is one, it is the thing to
try.

## Risk labels and the \`--yes\` rule

Every command declares its risk. \`a2wave schema <command>\` reports it, and
\`--help\` prints a \`Risk:\` line.

| Label | Meaning |
|---|---|
| \`read\` | Changes nothing server-side. Safe to call speculatively. |
| \`write\` | Changes state, as intended. Runs without confirmation. |
| \`high-risk-write\` | Irreversible, or of unknowable effect. **Requires \`--yes\`.** |

The high-risk set is small and specific: deletes, an \`agents apply\` whose diff
removes things, and \`api\` with any non-GET method.

**You have no TTY.** A \`high-risk-write\` without \`--yes\` therefore does not
prompt and does not proceed — it throws a \`confirmation\` error. That is
deliberate: an irreversible action must never happen silently in unattended
automation. \`--force\` is the same flag; \`--yes\` is its alias.

## Names, IDs, and the hidden fetch

Every \`<id|name>\` argument accepts either form, but they do not cost the same.

- An **ID** (\`agt_\`, \`skl_\`, \`mcp_\`, \`scm_\`, \`kbd_\`, \`run_\`, \`prv_\`) goes
  straight to the API: one request.
- A **name** does not. The CLI first fetches up to **100 rows** of that resource
  and matches exactly on \`name\` — so every name-based call is silently two
  requests, and on an instance with more than 100 of that resource the
  resolution may be incomplete (the CLI warns when it hits the cap).

So: **resolve once, then pass IDs.** \`a2wave agents list --fields
'data[].id,data[].name'\` gives you the mapping in one call; every subsequent
command should use the \`agt_\` id.

Duplicate names are an **error, not a coin flip**: \`name\` has no uniqueness
constraint, so an ambiguous name lists the candidates and refuses rather than
acting on whichever row sorted first. Passing an ID is how you avoid that
entirely.

## Pagination

List commands take \`--limit\` (1-100, clamped rather than rejected) and
\`--page\` (1-based). Defaults differ on purpose: \`runs list\` uses 20, the six
resource lists (\`agents\`/\`skills\`/\`mcp\`/\`scm\`/\`kb\`/\`providers\`) use the 100
they have always fetched.

There is no cursor and no auto-paging. To walk everything, increment \`--page\`
until a page comes back short. Integer flags accept plain decimals only —
\`0x10\` and \`1e3\` are rejected rather than reinterpreted.

Anything unbounded is capped in the HUMAN output only and says so; \`--json\`
gets the whole payload, because silently dropping entries from a machine payload
would corrupt it with no error.

## Command map

${renderCommandMap(leafPaths)}
## Getting unstuck

- \`a2wave whoami\` — one request: who am I, against which instance? Cheap enough
  to call before a risky write.
- \`a2wave doctor\` — every precondition as an addressable checklist. Exits 1 on
  any failure. Use this, not \`status\`, when you need to branch on a result.
- \`a2wave schema\` — with no argument, the list of every command path.
- \`a2wave docs <topic>\` — one section of this guide instead of all of it.
`
}
