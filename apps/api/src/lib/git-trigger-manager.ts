/**
 * Poll loop for the `glab` / `gh` repository trigger channels.
 *
 * Mirrors `schedule-trigger.ts` in lifecycle (start / stop / restoreAll, driven
 * by publish) but differs in the one way that matters: a cron schedule fires
 * the Agent unconditionally, whereas this manager does the cheap comparison
 * itself and starts a Run only when a watched merge/pull request actually
 * moved. The polling is a plain `setInterval` shelling out to a CLI — costing
 * no tokens — so an idle repository is effectively free, and the Agent's
 * context is spent only on real events.
 */
import {
  GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS,
  GIT_TRIGGER_MAX_PAGE_BUDGET,
  GIT_TRIGGER_MAX_RUNS_PER_TICK,
  type GitTriggerConfig,
  type GitTriggerEvent,
  type GitTriggerProvider,
  type GitTriggerRepo,
  type GitTriggerRepoState,
  gitTriggerConfigSchemaFor,
} from '@a2wave/shared'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, gitTriggerStates, runs } from '../db/schema.js'
import { hasAdmissionCapacity, tryAcquireSlot } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { logBackgroundAudit } from './audit.js'
import { executeChatRun } from './execute-chat-run.js'
import { GitTriggerCliError, listOpenRequests } from './git-trigger-cli.js'
import {
  diffRepoState,
  type GitTriggerFiredEvent,
  matchesFilters,
  type ObservedRequest,
  renderGitTriggerIntent,
  repoStateKey,
  rollbackUnhandled,
} from './git-trigger-diff.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { registerPendingContext, takePendingContext } from './pending-job-registry.js'
import { buildGitTriggerChannel } from './run-channel.js'

/**
 * The per-tick run allowance, as a value that can only be used correctly.
 *
 * This started as a bare `let` counter and was wrong three times in three
 * different directions — never decremented, decremented for work that never
 * happened, then decremented so eagerly that one busy repository starved the
 * rest. Every version was a plausible reading of "the budget", because a raw
 * number does not say *what* it counts, and the same variable was being read
 * both as "how much Agent capacity is left" and "may I visit another
 * repository".
 *
 * Naming the concept fixes the ambiguity: it counts **dispatched runs**, one
 * thing, and `spend()` accepts only what was actually dispatched. A refused
 * dispatch writes nothing and costs nothing, so there is no second question for
 * this value to answer.
 */
class RunBudget {
  private remaining: number

  constructor(limit: number) {
    this.remaining = limit
  }

  /** How many more runs may be dispatched; also the diff's per-repo cap. */
  get available(): number {
    return this.remaining
  }

  get exhausted(): boolean {
    return this.remaining <= 0
  }

  /** Charges only runs that actually took a slot. */
  spend(dispatched: number): void {
    this.remaining -= dispatched
  }
}

/** Key for the in-memory timer map: an agent may run glab and gh independently. */
function jobKey(agentId: string, provider: GitTriggerProvider): string {
  return `${agentId}:${provider}`
}

async function readState(
  agentId: string,
  channel: GitTriggerProvider,
  repoKey: string,
): Promise<GitTriggerRepoState | null> {
  const [row] = await db
    .select()
    .from(gitTriggerStates)
    .where(
      and(
        eq(gitTriggerStates.agentId, agentId),
        eq(gitTriggerStates.channel, channel),
        eq(gitTriggerStates.repoKey, repoKey),
      ),
    )
    .limit(1)
  return row?.state ?? null
}

async function writeState(
  agentId: string,
  channel: GitTriggerProvider,
  repoKey: string,
  state: GitTriggerRepoState,
  lastError: string | null,
): Promise<void> {
  await db
    .insert(gitTriggerStates)
    .values({ agentId, channel, repoKey, state, lastError, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [gitTriggerStates.agentId, gitTriggerStates.channel, gitTriggerStates.repoKey],
      set: { state, lastError, updatedAt: new Date() },
    })
}

async function recordFailure(
  agentId: string,
  channel: GitTriggerProvider,
  repoKey: string,
  message: string,
): Promise<void> {
  const existing = await readState(agentId, channel, repoKey)

  // No prior state means the baseline was never established, so there is
  // nothing to preserve — and writing a placeholder would actively destroy the
  // cold-start protection. `diffRepoState` decides "is this a cold start?" with
  // `!previous || !previous.requests`, and an empty-but-present `{requests:{}}`
  // is truthy: the next successful poll would treat every open request as brand
  // new and fire an `opened` Run for each one. A failed *first* poll (CLI not
  // yet installed, forge 5xx, a project path typo since corrected) is exactly
  // when that happens, so the row is left absent and only the error is logged.
  if (!existing) {
    logger.warn(
      { agentId, channel, repo: repoKey, message },
      'git-trigger: first poll failed before a baseline existed; leaving state unseeded',
    )
    return
  }

  // Preserve the fingerprint on failure. Resetting it would make the next
  // successful poll look like a cold start and silently swallow every event
  // that happened during the outage.
  await writeState(agentId, channel, repoKey, existing, message)
}

/**
 * Drop state rows for repositories no longer in the config.
 *
 * Without this, removing a repository leaves its fingerprint behind forever —
 * harmless for correctness (nothing reads it) but an unbounded leak, and
 * re-adding the repository later would silently resume from a stale baseline
 * instead of seeding a fresh one.
 */
async function pruneRemovedRepoStates(
  agentId: string,
  channel: GitTriggerProvider,
  repos: GitTriggerRepo[],
): Promise<void> {
  const active = new Set(repos.map((repo) => repoStateKey(repo)))
  const rows = await db
    .select()
    .from(gitTriggerStates)
    .where(and(eq(gitTriggerStates.agentId, agentId), eq(gitTriggerStates.channel, channel)))

  for (const row of rows) {
    if (active.has(row.repoKey)) continue
    await db
      .delete(gitTriggerStates)
      .where(
        and(
          eq(gitTriggerStates.agentId, agentId),
          eq(gitTriggerStates.channel, channel),
          eq(gitTriggerStates.repoKey, row.repoKey),
        ),
      )
    logger.info(
      { agentId, channel, repo: row.repoKey },
      'git-trigger: pruned state for repository removed from config',
    )
  }
}

/**
 * Clear the `queued` marker on a run that took a slot immediately.
 *
 * Best-effort: failing to clear it only costs that run one redundant forge
 * probe, which must never be worth failing a dispatch over.
 */
async function markGitTriggerRunUnqueued(runId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ executionMetadata: runs.executionMetadata })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    const origin = row?.executionMetadata?.gitTriggerOrigin
    if (!origin) return
    await db
      .update(runs)
      .set({
        executionMetadata: {
          ...row.executionMetadata,
          gitTriggerOrigin: { ...origin, queued: false },
        },
      })
      .where(eq(runs.id, runId))
  } catch (err) {
    logger.warn(
      { err, runId },
      'git-trigger: could not clear the queued marker; run will be probed',
    )
  }
}

class GitTriggerManager {
  private jobs = new Map<string, NodeJS.Timeout>()
  /** Guards against a slow poll overlapping the next tick on the same channel. */
  private inFlight = new Set<string>()
  /** Round-robin cursor per channel, so a shared run budget cannot starve later repos. */
  private repoOffsets = new Map<string, number>()
  /**
   * Config generation per channel, bumped by every `start()`. A tick captures
   * the value at entry and abandons its results if it no longer matches, so a
   * poll begun under a replaced config cannot act on it.
   */
  private owners = new Map<string, object>()

  start(agentId: string, provider: GitTriggerProvider, rawConfig: unknown): void {
    this.stop(agentId, provider)

    // Parsed against the provider-bound schema, so a mismatched config fails
    // here as an ordinary validation error rather than needing its own check.
    // The separate `config.provider !== provider` branch this replaces was the
    // last hand-written copy of that rule, and it was also the thing that made
    // the failure invisible: it returned quietly, leaving a channel that read as
    // published while never polling once.
    const parsed = gitTriggerConfigSchemaFor(provider).safeParse(rawConfig)
    if (!parsed.success) {
      logger.warn(
        { agentId, provider, issues: parsed.error.flatten() },
        'git-trigger: invalid config, not starting poll',
      )
      return
    }
    const config = parsed.data

    const intervalMs = (config.intervalSeconds ?? GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS) * 1000
    const key = jobKey(agentId, provider)

    // Identity for this configuration. Every poll it launches carries the token
    // and re-checks it at each checkpoint, so a poll from a replaced config
    // retires instead of acting on a repo list the user has already changed.
    const token = {}
    this.owners.set(key, token)

    const timer = setInterval(() => {
      void this.tick(agentId, provider, config, token)
    }, intervalMs)
    // Never hold the event loop open for a poll timer; shutdown should not wait.
    timer.unref?.()
    this.jobs.set(key, timer)

    logger.info(
      { agentId, provider, intervalSeconds: config.intervalSeconds, repos: config.repos.length },
      'git-trigger: poll started',
    )

    // Seed the baseline immediately rather than waiting a full interval. If a
    // poll from the previous config is still running this one is skipped, and
    // the timer picks it up an interval later — the stale poll cannot do damage
    // in the meantime because it no longer owns the channel.
    void this.tick(agentId, provider, config, token)
  }

  stop(agentId: string, provider: GitTriggerProvider): void {
    const key = jobKey(agentId, provider)
    // Revoke ownership first: clearing the timer does nothing to a poll already
    // running, which previously went on to fire Runs against repositories the
    // user had just removed — `isStillLive()` could not catch it because the
    // agent was still published with the channel still enabled.
    this.owners.delete(key)
    // Cleared unconditionally: the rotation cursor is the one piece of manager
    // state with no other removal path, so leaving it behind both leaks for the
    // process lifetime and makes a re-published channel resume mid-rotation
    // instead of at the configured first repository.
    this.repoOffsets.delete(key)
    const timer = this.jobs.get(key)
    if (!timer) return
    clearInterval(timer)
    this.jobs.delete(key)
    logger.info({ agentId, provider }, 'git-trigger: poll stopped')
  }

  stopAgent(agentId: string): void {
    this.stop(agentId, 'glab')
    this.stop(agentId, 'gh')
  }

  stopAll(): void {
    for (const key of [...this.jobs.keys()]) {
      const timer = this.jobs.get(key)
      if (timer) clearInterval(timer)
      this.jobs.delete(key)
    }
    this.repoOffsets.clear()
    this.owners.clear()
  }

  getActiveJobKeys(): string[] {
    return [...this.jobs.keys()]
  }

  /** Advances and returns this channel's round-robin start index. */
  private nextRepoOffset(key: string, length: number): number {
    if (length <= 1) return 0
    const current = (this.repoOffsets.get(key) ?? 0) % length
    this.repoOffsets.set(key, (current + 1) % length)
    return current
  }

  /** Whether a tick is currently running; exposed for deterministic tests. */
  isPolling(agentId: string, provider: GitTriggerProvider): boolean {
    return this.inFlight.has(jobKey(agentId, provider))
  }

  /** Re-arm polls for every published agent after a restart. */
  async restoreAll(): Promise<void> {
    const published = await db.select().from(agents).where(eq(agents.publishStatus, 'published'))

    for (const agent of published) {
      const channels = (agent.publishChannels as string[]) ?? []
      if (channels.includes('glab') && agent.glabConfig) {
        this.start(agent.id, 'glab', agent.glabConfig)
      }
      if (channels.includes('gh') && agent.ghConfig) {
        this.start(agent.id, 'gh', agent.ghConfig)
      }
    }
    logger.info(`git-trigger: restored ${this.jobs.size} active polls`)
  }

  /**
   * Runs one poll, unless one is already running for this channel.
   *
   * Never waits and never overlaps. An earlier version let a newer config's seed
   * tick wait for the in-flight one, bounded at 10s — but a tick can legitimately
   * run far longer than that, so the wait expired and the two ran concurrently,
   * after which the older tick's cleanup released the guard while the newer one
   * was still going and a third could start. Two concurrent polls read the same
   * fingerprint, fire the same events twice, and race on the same state row.
   *
   * The replacement carries no timing assumption: a poll owns its channel from
   * start to finish, identified by the token it was launched with. A config
   * change replaces the token, so the in-flight poll becomes an ex-owner and
   * retires at its next checkpoint without touching any state. Nothing waits,
   * so nothing can time out and proceed anyway.
   */
  private async tick(
    agentId: string,
    provider: GitTriggerProvider,
    config: GitTriggerConfig,
    token: object,
  ): Promise<void> {
    const key = jobKey(agentId, provider)
    if (this.inFlight.has(key)) {
      logger.debug({ agentId, provider }, 'git-trigger: previous poll still running, skipping tick')
      return
    }
    // A poll launched by a superseded config must not start at all.
    if (this.owners.get(key) !== token) return

    this.inFlight.add(key)
    try {
      await this.poll(agentId, provider, config, token)
    } catch (err) {
      logger.error({ err, agentId, provider }, 'git-trigger: poll tick failed')
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** Whether this poll still owns its channel, i.e. no newer config replaced it. */
  private stillOwns(agentId: string, provider: GitTriggerProvider, token: object): boolean {
    return this.owners.get(jobKey(agentId, provider)) === token
  }

  private async poll(
    agentId: string,
    provider: GitTriggerProvider,
    config: GitTriggerConfig,
    token: object,
  ): Promise<void> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
    if (!agent || agent.publishStatus !== 'published') {
      this.stop(agentId, provider)
      logger.info({ agentId, provider }, 'git-trigger: stopped, agent not published or deleted')
      return
    }
    if (!((agent.publishChannels as string[]) ?? []).includes(provider)) {
      this.stop(agentId, provider)
      logger.info({ agentId, provider }, 'git-trigger: stopped, channel disabled')
      return
    }
    if (agent.status === 'inactive') {
      logger.info({ agentId, provider }, 'git-trigger: skipped, agent inactive')
      return
    }

    const events = (config.events ?? []) as GitTriggerEvent[]
    const filters = {
      targetBranches: config.targetBranches ?? [],
      ignoreDrafts: config.ignoreDrafts ?? true,
    }

    await pruneRemovedRepoStates(agentId, provider, config.repos as GitTriggerRepo[])

    /**
     * Repositories are fetched one at a time, immediately before being
     * processed — no prefetch, no concurrency.
     *
     * The previous version fetched all of them in parallel first. That made a
     * tick's wall clock shorter but created a window of up to ~100s between
     * reading a repository and acting on it, and every concurrency defect on
     * this branch lived in that window: a config replaced mid-flight, a stale
     * poll pruning the new config's state, two polls racing on one state row.
     *
     * Serial fetching removes the window rather than guarding it. The cost is a
     * longer worst-case tick, which `MAX_REPOS_PER_CHANNEL` bounds directly:
     * with a smaller repository cap the worst case fits inside the minimum
     * interval, so `inFlight` skips are the exception rather than routine.
     */
    const order = this.nextRepoOffset(jobKey(agentId, provider), config.repos.length)
    const repos = config.repos as GitTriggerRepo[]
    const listings = [...repos.slice(order), ...repos.slice(0, order)]

    // One allowance for the whole tick, shared across repositories. See
    // `RunBudget` for why this is a type rather than a bare counter.
    const budget = new RunBudget(GIT_TRIGGER_MAX_RUNS_PER_TICK)

    /**
     * List pages left for this tick, shared across entries.
     *
     * Without a shared budget the per-entry page cap and the entry cap multiply:
     * five group entries at five pages each is 25 serial CLI calls, ~500s at the
     * poll timeout, against a 30s minimum interval. That is the worst-case tick
     * `GIT_TRIGGER_MAX_REPOS` exists to bound, so the pages are spent from one
     * pool and the bound holds no matter how the entries are configured.
     * Round-robin ordering means a namespace that consumes the pool does not
     * permanently starve the entries behind it.
     */
    let pageBudget = GIT_TRIGGER_MAX_PAGE_BUDGET

    for (const repo of listings) {
      const repoKey = repoStateKey(repo)

      // Ownership and liveness are re-checked before each repository, and both
      // are cheap. A poll can span several CLI timeouts, and during that time
      // the config may be replaced, the channel disabled or the Agent stopped —
      // each of which previously let the poll go on to fire Runs against a repo
      // list the user had already changed.
      if (!this.stillOwns(agentId, provider, token)) {
        logger.info(
          { agentId, provider },
          'git-trigger: configuration replaced mid-poll, retiring this poll',
        )
        return
      }
      if (!(await this.isStillLive(agentId, provider))) {
        logger.info(
          { agentId, provider },
          'git-trigger: agent stopped or channel disabled mid-poll, discarding the rest',
        )
        return
      }

      let listing: Awaited<ReturnType<typeof listOpenRequests>>
      try {
        listing = await listOpenRequests(provider, repo.project, repo.host, repo.scope, pageBudget)
        pageBudget -= listing.pagesFetched
      } catch (err) {
        const message =
          err instanceof GitTriggerCliError ? err.message : String((err as Error)?.message ?? err)
        // A failing repository must not abort the others in the same config.
        await recordFailure(agentId, provider, repoKey, message)
        logger.warn({ agentId, provider, repo: repoKey, err }, 'git-trigger: poll failed for repo')
        continue
      }

      // Re-checked AFTER the fetch as well as before it. The fetch itself is
      // the long part — up to a full CLI timeout — so a stop or config change
      // most often lands precisely here, and acting on a listing retrieved for
      // an Agent that has since been stopped is what produced Runs appearing
      // after the UI reported it stopped.
      if (
        !this.stillOwns(agentId, provider, token) ||
        !(await this.isStillLive(agentId, provider))
      ) {
        logger.info(
          { agentId, provider, repo: repoKey },
          'git-trigger: agent stopped or configuration replaced during fetch, discarding results',
        )
        return
      }

      const observed: ObservedRequest[] = listing.requests

      const listingComplete = listing.complete

      // One repository's failure must not abort the tick: an exception here
      // would skip every repository ordered after it, leaving their state rows
      // neither advanced nor marked with an error — an invisible failure.
      try {
        const filtered = observed.filter((request) => matchesFilters(request, filters))
        const previous = await readState(agentId, provider, repoKey)
        const result = diffRepoState({
          previous,
          observed: filtered,
          // Filters decide what the Agent is woken *for*; they must not decide
          // what counts as closed. Passing the raw listing keeps "closed" meaning
          // "gone from the forge" rather than "stopped matching the filter".
          observedUnfiltered: observed,
          // Suppresses `closed` inference when the forge returned a full page, so
          // a request paged out of a busy repository is never mistaken for merged.
          listingComplete,
          events,
          polledAt: new Date().toISOString(),
          maxRunsPerTick: budget.available,
        })

        if (result.seeded) {
          await writeState(agentId, provider, repoKey, result.nextState, null)
          logger.info(
            { agentId, provider, repo: repoKey, tracked: filtered.length },
            'git-trigger: baseline seeded, no runs triggered',
          )
          continue
        }
        if (result.deferred.length > 0) {
          logger.warn(
            { agentId, provider, repo: repoKey, deferred: result.deferred.length },
            'git-trigger: per-tick run cap reached, deferring the rest to the next poll',
          )
        }

        /**
         * Dispatch BEFORE persisting the advanced fingerprint.
         *
         * The old order committed the new state first, so a throw in
         * `triggerRun` (SQLITE_BUSY on the runs insert, a constraint failure)
         * left the fingerprint past the change with no Run ever created — the
         * event was gone for good with no retry. Launching first means a
         * failure leaves the old fingerprint intact and the next tick re-detects
         * the same delta.
         *
         * The accepted cost is duplication: if the third of five events throws,
         * the first two Runs exist but the fingerprint never advances, so all
         * five replay next tick. A duplicate wake is visible and recoverable;
         * a silently dropped event is neither, which is why this direction was
         * chosen.
         */
        // Rejected for a full queue: the change was never acted on, so its
        // fingerprint must not advance. `rollbackUnhandled` applies the same
        // rule the diff uses for a deferred request, rather than this call site
        // re-deriving it — the two copies had already drifted apart once.
        // Sequential rather than filter(): dispatching now awaits a slot, and
        // the per-tick budget depends on how many runs actually landed, so these
        // cannot be started concurrently without over-committing the queue.
        const unhandled: GitTriggerFiredEvent[] = []
        for (const fired of result.fired) {
          if ((await this.triggerRun(agent, provider, config, repo, fired)) === 'rejected') {
            unhandled.push(fired)
          }
        }
        const nextState = rollbackUnhandled(result.nextState, previous, unhandled)

        // Only dispatched runs are charged; a refusal writes nothing, so it
        // costs nothing. See `RunBudget` for why that distinction is a type
        // rather than a convention.
        budget.spend(result.fired.length - unhandled.length)

        await writeState(agentId, provider, repoKey, nextState, null)

        if (budget.exhausted) {
          const skipped = listings.slice(listings.indexOf(repo) + 1).map(repoStateKey)
          logger.warn(
            { agentId, provider, skipped },
            'git-trigger: per-tick run budget exhausted; the listed repositories were not processed this tick and go first on the next one',
          )
          return
        }
      } catch (err) {
        await recordFailure(agentId, provider, repoKey, String((err as Error)?.message ?? err))
        logger.error(
          { err, agentId, provider, repo: repoKey },
          'git-trigger: failed to process repository; its state is unchanged and will retry',
        )
      }
    }
  }

  /** Re-reads the Agent to confirm the channel should still be polling. */
  private async isStillLive(agentId: string, provider: GitTriggerProvider): Promise<boolean> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
    if (!agent || agent.publishStatus !== 'published' || agent.status === 'inactive') return false
    return ((agent.publishChannels as string[]) ?? []).includes(provider)
  }

  /**
   * Creates and dispatches a Run for one fired event.
   *
   * Returns whether the Run actually took a slot. A `queue_full` rejection means
   * the change was never acted on, so the caller must roll that request's
   * fingerprint back — otherwise the state advances past a change no Run ever
   * processed and it is never retried, the same loss the deferral path exists to
   * prevent.
   */
  private async triggerRun(
    agent: typeof agents.$inferSelect,
    provider: GitTriggerProvider,
    config: GitTriggerConfig,
    repo: GitTriggerRepo,
    fired: GitTriggerFiredEvent,
  ): Promise<'dispatched' | 'rejected'> {
    const { request, event } = fired
    /**
     * The repository this specific request lives in, not the entry that found
     * it. Under a `group` or `all` scope those differ: the entry names a
     * namespace, while every request belongs to one repository underneath it.
     * Rendering the entry's path would hand the Agent a namespace where it
     * expects a repository — and for `all` an empty string — so the Run would
     * name no reachable target at all.
     */
    const project = request.project || repo.project
    const intent = renderGitTriggerIntent(config.intent, {
      event,
      repo: project,
      host: repo.host,
      number: request.number,
      title: request.title,
      url: request.url,
      author: request.author,
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
      sha: request.sha,
    })

    /**
     * Check admission BEFORE writing anything.
     *
     * `tryAcquireSlot` requires an existing row, so the previous order inserted
     * the run and its audit entry and only then discovered the queue was full —
     * leaving a `failed` row plus an audit entry per rejected attempt, every
     * tick, for as long as the Agent stayed busy. A poll running on a timer must
     * not manufacture history that way: when there is no capacity it declines
     * without writing, and the change is rolled back for the next tick.
     */
    if (!(await hasAdmissionCapacity(taskQueueDb, agent.id, agent.maxConcurrency ?? 1))) {
      logger.info(
        { agentId: agent.id, provider, event, number: request.number },
        'git-trigger: agent queue is full, deferring this change to the next poll',
      )
      return 'rejected'
    }

    const runId = createId('run')
    const channelResult = buildGitTriggerChannel({
      provider,
      event,
      project,
      host: repo.host,
      number: request.number,
      url: request.url,
      sha: request.sha,
      authorName: request.author,
    })

    await db.insert(runs).values({
      id: runId,
      intent,
      initiatorAgentId: agent.id,
      // No end user triggers a poll, so attribute to the agent owner — same
      // rule the schedule channel uses — otherwise the run is invisible to
      // every non-admin in the run list.
      userId: agent.userId ?? undefined,
      status: 'pending',
      triggerSource: provider,
      triggerUserName: channelResult.displayName ?? undefined,
      /**
       * Persisted so the pre-execution staleness check can still identify the
       * request after the poll's process is gone. A queued run executes in a
       * later lifetime, where the in-memory channel context no longer exists —
       * and the whole point of that check is to catch a request merged during
       * exactly that gap.
       */
      executionMetadata: {
        gitTriggerOrigin: {
          provider,
          event,
          project,
          ...(repo.host ? { host: repo.host } : {}),
          number: request.number,
          // Overwritten below once the queue's verdict is known. Defaults to
          // true so a crash between the insert and that update leaves the run
          // probed rather than silently unchecked — one extra CLI call is the
          // cheaper mistake.
          queued: true,
        },
      },
    })

    registerPendingContext(runId, { channel: channelResult.ctx })

    logBackgroundAudit({
      userId: agent.userId ?? undefined,
      action: 'agent.git_trigger',
      resource: 'agent',
      resourceId: agent.id,
      details: {
        provider,
        event,
        project,
        ...(repo.host ? { host: repo.host } : {}),
        // Recorded alongside the project so the audit trail says which watch
        // entry produced the Run — a group entry and a direct one on the same
        // repository are otherwise indistinguishable after the fact.
        ...(repo.scope && repo.scope !== 'project' ? { scope: repo.scope } : {}),
        number: request.number,
        runId,
      },
    })

    const slotResult = await tryAcquireSlot(taskQueueDb, agent.id, runId, agent.maxConcurrency ?? 1)

    if (slotResult === 'queue_full') {
      /**
       * Lost the race between the advisory pre-check and the real acquisition.
       *
       * The pre-check exists so a full queue produces no rows at all, but it is
       * not atomic: another channel can take the slot in between. Leaving the
       * row as `failed` would reinstate exactly what the pre-check removed —
       * one `failed` run plus one audit entry per tick, forever, because the
       * rolled-back change re-fires every tick while the queue stays full.
       *
       * The row is therefore withdrawn rather than kept. Nothing observed it:
       * it never ran, never queued, and its change is retried on the next tick.
       * The audit entry stays, so the attempt is still traceable.
       */
      await db.delete(runs).where(eq(runs.id, runId))
      // Discards the context registered above so it does not linger until the sweeper.
      takePendingContext(runId)
      logger.warn(
        { agentId: agent.id, provider, runId },
        'git-trigger: queue filled between the admission check and acquisition; withdrawing the run and retrying next tick',
      )
      return 'rejected'
    }

    if (slotResult === 'queued') {
      logger.info({ agentId: agent.id, provider, runId }, 'git-trigger: run queued')
      return 'dispatched'
    }

    /**
     * Dispatched immediately, so the request cannot have gone stale: execution
     * starts milliseconds after the poll listed it as open. Recording that
     * spares this run the pre-execution forge probe, which would otherwise
     * double the channel's call volume to re-answer a question the poll just
     * answered.
     */
    await markGitTriggerRunUnqueued(runId)

    executeChatRun(agent.id, runId).catch((err) =>
      logger.error({ err, agentId: agent.id, runId }, 'git-trigger: run execution failed'),
    )
    logger.info(
      { agentId: agent.id, provider, runId, event, number: request.number },
      'git-trigger: run acquired and executing',
    )
    return 'dispatched'
  }
}

export const gitTriggerManager = new GitTriggerManager()
