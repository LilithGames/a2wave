/**
 * Git repository trigger channels (`glab` / `gh`).
 *
 * These two channels poll a repository through the vendor CLI, fingerprint the
 * merge/pull requests they see, and start a Run only when that fingerprint
 * actually moves. The distinction from the `schedule` channel is the whole
 * point: a cron fires the Agent unconditionally, burning tokens on every tick
 * even when the repository has not changed. Here the cheap, deterministic
 * polling happens *outside* the Agent, so the expensive part runs only on a
 * real event.
 *
 * The two channels are deliberately one schema shape. GitLab and GitHub differ
 * in vocabulary (MR/PR, `iid`/`number`) but not in the state we track, and
 * modelling them separately would duplicate every validation rule and every
 * piece of trigger logic for no gain. `provider` discriminates where it matters
 * — CLI binary, API path, host env var — and nowhere else.
 */
import { z } from 'zod'

/** Which vendor CLI drives the polling. */
export const gitTriggerProviderEnum = z.enum(['glab', 'gh'])
export type GitTriggerProvider = z.infer<typeof gitTriggerProviderEnum>

/**
 * Trackable repository events.
 *
 * Chosen to be *derivable from one list call* — `glab api merge_requests` and
 * `gh pr list` both return the opened requests with their update timestamp,
 * head SHA and comment count in a single response. Every event below is a diff
 * over those fields, so a poll costs exactly one API call per repository no
 * matter how many events are selected, and adding a second event to a config
 * costs nothing extra at runtime.
 *
 * Deliberately NOT included: per-request CI status and per-request review
 * threads. Both require an extra API call *per open request*, turning one cheap
 * poll into an N+1 sweep against the forge — at a 30s floor that is a self-
 * inflicted rate-limit incident. They belong to a future opt-in "deep poll",
 * not to the default path.
 */
export const gitTriggerEventEnum = z.enum([
  /** A merge/pull request the previous poll had never seen. */
  'opened',
  /** New commits pushed to a tracked request (head SHA moved). */
  'updated',
  /** The comment count on a tracked request went up. */
  'commented',
  /** A tracked request left the open set (merged or closed). */
  'closed',
])
export type GitTriggerEvent = z.infer<typeof gitTriggerEventEnum>

export const GIT_TRIGGER_EVENTS: readonly GitTriggerEvent[] = gitTriggerEventEnum.options

/**
 * Poll interval bounds, in seconds.
 *
 * The 30s floor is a forge-protection limit, not a UI preference: every
 * repository in the config costs one API call per tick, and both GitLab and
 * GitHub apply per-token rate limits that a tighter loop would walk straight
 * into. The 10min ceiling keeps the channel meaningfully "near real-time" —
 * past that, a cron schedule is the honest tool.
 */
export const GIT_TRIGGER_MIN_INTERVAL_SECONDS = 30
export const GIT_TRIGGER_MAX_INTERVAL_SECONDS = 600
export const GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS = 60

/**
 * Max Runs a single poll tick may start.
 *
 * Without a cap, one push touching twenty requests — or a misconfigured filter
 * suddenly matching a busy repository — would fan out into twenty concurrent
 * Runs. Overflow is not dropped: the fingerprint for a skipped request is left
 * un-advanced, so it is picked up on the next tick and only the *rate* is
 * bounded, never the delivery.
 */
export const GIT_TRIGGER_MAX_RUNS_PER_TICK = 5

/**
 * Upper bound on watch entries per channel config.
 *
 * Lowered from 20 when repository fetching became serial. Entries are fetched
 * one at a time, immediately before being processed, so the worst-case tick is
 * `calls × POLL_TIMEOUT`; at 5 that is ~100s, which stays close enough to the
 * interval that a skipped tick is an exception rather than routine.
 *
 * The previous 20 relied on parallel prefetch to stay inside the interval, and
 * the window that opened between fetching a repository and acting on it is where
 * every concurrency defect on this channel lived. A smaller cap buys the
 * simplicity of having no window at all; a deployment needing more repositories
 * should watch a group (see `gitTriggerScopeEnum`) rather than lengthening the
 * tick.
 *
 * Note that with wide scopes an entry is no longer one call, which is why the
 * page budget below is spent across the whole tick rather than per entry —
 * `calls` in the bound above stays `GIT_TRIGGER_MAX_PAGE_BUDGET`, not
 * `entries × pages`.
 */
export const GIT_TRIGGER_MAX_REPOS = 5

/**
 * How wide a single watch entry reaches.
 *
 * Enumerating repositories one by one is the thing this exists to avoid: a
 * product line is a *namespace*, its membership changes as repositories are
 * created, and a per-repository list is stale the moment someone adds one. The
 * wider scopes name the namespace instead, so new repositories are picked up
 * with no config change.
 *
 * GitLab is the only provider that can serve these. `GET /groups/:id/
 * merge_requests` recurses through subgroups and returns exactly the fields the
 * fingerprint needs, so a group costs the same single call shape as a project.
 * GitHub has no equivalent that carries head SHA and comment counts together —
 * its org-wide search returns neither — so widening there would mean an N+1
 * sweep, which is precisely what this channel exists to avoid.
 */
/**
 * There is deliberately no instance-wide scope.
 *
 * `merge_requests?scope=all` exists and was implemented, but measuring it
 * against a real deployment showed it cannot work here: that instance returned
 * 402 open merge requests spanning nine unrelated top-level namespaces, which
 * exhausts the tick's entire page budget on its own. A scope that can never
 * page to the end can never prove the open set was seen, so `closed` inference
 * would be permanently suspended — and the Agent would be woken by hundreds of
 * repositories nobody configured it for. A group is the widest scope that stays
 * both bounded and intentional.
 */
export const gitTriggerScopeEnum = z.enum([
  /** One repository, addressed by its full path. */
  'project',
  /** A namespace and everything beneath it, subgroups included. */
  'group',
])
export type GitTriggerScope = z.infer<typeof gitTriggerScopeEnum>

/**
 * Upper bound on list pages fetched for one watch entry per tick.
 *
 * Applies to the wide scopes only — a `project` deliberately stays at exactly
 * one call, since a single repository holding more than a page of open requests
 * is pathological and paging every ordinary repository to cover it would tax the
 * common case for the rare one.
 *
 * For a namespace, paging is what makes `closed` inference possible at all —
 * absence only proves closure when the whole open set was seen — but unbounded
 * paging turns one tick into a sweep whose cost the interval cannot bound. Five
 * pages (500 requests) covers the real namespaces this was built for while
 * keeping the worst case near the measured ~1.7s per page; beyond it the listing
 * is marked incomplete and `closed` detection suspends itself rather than firing
 * on partial evidence.
 */
export const GIT_TRIGGER_MAX_PAGES = 5

/**
 * Total list pages one tick may fetch, across every watch entry.
 *
 * `GIT_TRIGGER_MAX_PAGES` bounds a single entry; this bounds the tick. Without
 * it the two caps multiply — five group entries at five pages each is 25 serial
 * CLI calls, ~500s at `POLL_TIMEOUT_MS`, against a 30s minimum interval. That
 * silently invalidates the worst-case tick `GIT_TRIGGER_MAX_REPOS` was chosen to
 * satisfy and makes overlapping-tick skips routine rather than exceptional.
 *
 * Set to the same 5, so the tick's call budget is unchanged from before scopes
 * existed: five single-project entries cost five calls, and one group entry may
 * spend the whole budget on itself. An entry that runs out is reported
 * incomplete exactly as if it had hit the per-entry cap, so `closed` inference
 * suspends rather than firing on partial evidence.
 */
export const GIT_TRIGGER_MAX_PAGE_BUDGET = 5

/**
 * A watch entry: one repository, or one namespace of them.
 *
 * `project` is the forge's own full path (`group/sub/repo` on GitLab,
 * `owner/repo` on GitHub) rather than a numeric id, because that is what a user
 * can read off a browser URL and what both CLIs accept directly. Under the
 * `group` scope the same field holds a namespace path, which may legitimately be
 * a single segment; under `all` it is empty because there is nothing to name.
 */
export const gitTriggerRepoSchema = z
  .object({
    /**
     * Defaulted rather than required, because every config written before scopes
     * existed omits it. Anything but `project` as the default would silently
     * widen those configs — a change to what an Agent watches that nobody made.
     */
    scope: gitTriggerScopeEnum.default('project'),
    /** Full project path, or a namespace path under the `group` scope. */
    project: z.string().trim().max(300).default(''),
    /**
     * Self-hosted forge host, e.g. `gitlab.example.com`. Blank uses the CLI's
     * default host. Stored per entry because one Agent may legitimately watch
     * repositories on two different forges.
     */
    host: z.string().trim().max(300).optional(),
  })
  .refine((repo) => repo.project.length > 0, {
    // Every scope names something. A blank path used to mean "the whole
    // instance", which made the widest possible scope reachable by leaving a
    // box empty — the opposite of what an empty field should ever mean.
    message: 'A project or group path is required',
    path: ['project'],
  })
export type GitTriggerRepo = z.infer<typeof gitTriggerRepoSchema>

/**
 * Placeholders substituted into `intent` when an event fires. Kept in sync with
 * `renderGitTriggerIntent` on the API side; documented here because the config
 * form renders this list as inline help.
 */
export const GIT_TRIGGER_INTENT_PLACEHOLDERS = [
  '{{event}}',
  '{{repo}}',
  '{{host}}',
  '{{number}}',
  '{{title}}',
  '{{url}}',
  '{{author}}',
  '{{source_branch}}',
  '{{target_branch}}',
  '{{sha}}',
] as const

export const gitTriggerConfigSchema = z.object({
  provider: gitTriggerProviderEnum,
  repos: z.array(gitTriggerRepoSchema).min(1).max(GIT_TRIGGER_MAX_REPOS),
  /**
   * At least one event, or the poll could never fire and the channel would sit
   * green while doing nothing — the most expensive kind of silent misconfig.
   */
  events: z.array(gitTriggerEventEnum).min(1),
  intervalSeconds: z
    .number()
    .int()
    .min(GIT_TRIGGER_MIN_INTERVAL_SECONDS)
    .max(GIT_TRIGGER_MAX_INTERVAL_SECONDS)
    .default(GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS),
  /** Prompt template sent to the Agent; supports the placeholders above. */
  intent: z.string().trim().min(1).max(5000),
  /**
   * Only watch requests targeting these branches. Empty = every branch.
   * Applied client-side over the list response, so it costs no extra API call.
   */
  targetBranches: z.array(z.string().trim().min(1)).max(20).default([]),
  /** Skip draft/WIP requests — they usually are not ready for an Agent to act on. */
  ignoreDrafts: z.boolean().default(true),
})
export type GitTriggerConfig = z.input<typeof gitTriggerConfigSchema>

/**
 * The wide scopes are GitLab-only.
 *
 * The `gh` listing is a per-repository GraphQL query, chosen because it is the
 * only shape returning head SHA and both comment counters in one call. There is
 * no org-wide query carrying those fields, so a `group` config would validate,
 * save, publish green — and then fail every poll. The rule is applied by
 * `ghTriggerConfigSchema` below.
 */

/**
 * Provider-bound variants of the config.
 *
 * The two channels share one shape, so a `provider: 'glab'` config validated
 * cleanly when written into the `gh` column — and then the poller refused to arm
 * on the mismatch, leaving a channel that read as configured while never running
 * once. That got fixed three separate times, at three separate write paths,
 * because each entry point had to remember to call the guard.
 *
 * Narrowing `provider` to a literal makes the mismatch a *type* error at every
 * call site that knows which column it is writing, so the guard is no longer
 * something a fourth write path can forget. `gitTriggerConfigSchemaFor` gives
 * the runtime half for input that arrives untyped.
 */
export const glabTriggerConfigSchema = gitTriggerConfigSchema.extend({
  provider: z.literal('glab'),
})

/**
 * GitHub additionally rejects the wide scopes; see `refineProviderScopes`.
 *
 * The rule lives on the `repos` field rather than wrapping the config, because
 * both `.refine()` and `.superRefine()` turn a `ZodObject` into a `ZodEffects` —
 * silently losing `.extend()`, `.pick()`, `.omit()` and `.shape`, so this
 * variant would stop composing the way `glabTriggerConfigSchema` still does.
 * Constraining the field keeps the config object a plain object, and the rule
 * applies at exactly the place the offending value is written.
 */
export const ghTriggerConfigSchema = gitTriggerConfigSchema.extend({
  provider: z.literal('gh'),
  repos: z
    .array(
      gitTriggerRepoSchema.refine((repo) => (repo.scope ?? 'project') === 'project', {
        message: 'GitHub supports the project scope only; group and all are GitLab-only',
        path: ['scope'],
      }),
    )
    .min(1)
    .max(GIT_TRIGGER_MAX_REPOS),
})

export type GlabTriggerConfig = z.input<typeof glabTriggerConfigSchema>
export type GhTriggerConfig = z.input<typeof ghTriggerConfigSchema>

/** The schema that accepts only configs belonging to `provider`. */
export function gitTriggerConfigSchemaFor(provider: GitTriggerProvider) {
  return provider === 'glab' ? glabTriggerConfigSchema : ghTriggerConfigSchema
}

/**
 * One observed request, as persisted between polls.
 *
 * This is a *fingerprint*, not a cache of the request: it holds exactly the
 * fields whose movement defines an event and nothing else. Storing the full
 * payload instead would make every unrelated upstream field change (a label, a
 * pipeline id) look like an event worth waking the Agent for — precisely the
 * token waste the channel exists to avoid.
 */
export const gitTriggerRequestStateSchema = z.object({
  /** MR `iid` on GitLab, PR `number` on GitHub. */
  number: z.number().int(),
  /** Head commit SHA — moves when new commits are pushed. */
  sha: z.string(),
  /** Comment count — moves when someone comments. */
  comments: z.number().int(),
  /**
   * Whether the request was hidden by a filter when last seen.
   *
   * Without it, "draft → ready for review" fired nothing: the fingerprint was
   * retained while the request was filtered out (so it would not re-fire
   * `opened`), and on return neither the head SHA nor the comment count had
   * moved, so no event matched either. That silently dropped the single most
   * important signal this channel exists to catch.
   */
  filtered: z.boolean().optional(),
  /** Forge-reported last update, kept for observability rather than diffing. */
  updatedAt: z.string().optional(),
  /**
   * Title and URL, carried so a `closed` event can name the request it fired
   * for. Closure is inferred from *absence* — the forge no longer lists the
   * request — so at that moment the fingerprint is the only surviving record.
   * Without these the intent rendered `{{title}}` and `{{url}}` as empty
   * strings and the Agent was woken with no way to identify what had merged.
   * Not part of change detection: neither field is compared.
   */
  title: z.string().optional(),
  url: z.string().optional(),
  /**
   * The repository this request belongs to, under a scope that spans several.
   *
   * Carried for the same reason as title and URL — a closed request is gone from
   * the forge, so the fingerprint is the only surviving record of which
   * repository it was in — and additionally because it is part of the entry's
   * identity: a merge request number is unique only within its own repository.
   * Absent for a single-project watch entry, where the path is already known.
   */
  project: z.string().optional(),
})
export type GitTriggerRequestState = z.infer<typeof gitTriggerRequestStateSchema>

/** Per-repository poll state, keyed by `host/project` in the parent record. */
export const gitTriggerRepoStateSchema = z.object({
  requests: z.record(gitTriggerRequestStateSchema),
  /** ISO timestamp of the last successful poll of this repository. */
  polledAt: z.string().optional(),
})
export type GitTriggerRepoState = z.infer<typeof gitTriggerRepoStateSchema>

/** Runtime status surfaced by the config UI so a silent failure is visible. */
export const gitTriggerCliStatusSchema = z.object({
  provider: gitTriggerProviderEnum,
  /** Whether the CLI binary resolves on PATH. */
  installed: z.boolean(),
  /** Whether the CLI reports a usable credential for `host`. */
  authenticated: z.boolean(),
  /** Host the check ran against; absent means the CLI's default host. */
  host: z.string().optional(),
  /** Logged-in account, when the CLI reports one. */
  account: z.string().optional(),
  /** Human-readable reason when `installed` or `authenticated` is false. */
  detail: z.string().optional(),
})
export type GitTriggerCliStatus = z.infer<typeof gitTriggerCliStatusSchema>
