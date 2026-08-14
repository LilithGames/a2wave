# Evaluation

You changed the prompt, or switched models — did the Agent actually get better? Evaluation answers that: pin down a set of conversations with what should be asked and how it should be answered, replay them after every config change, and compare.

Evaluation lives in the **Evaluation** tab of the Agent detail page (after Channels), with two sub-tabs: **Evaluation Sets** and **Evaluation Tasks**.

## Two concepts

| Concept | What it is |
|---------|-----------|
| **Evaluation set** | A collection of cases, e.g. "customer support" or "code review". |
| **Evaluation case** | One conversation: one or more turns of request + expected reply. |
| **Evaluation task** | One replay of a set against the Agent's current config, recording every actual reply. |

## Building sets and cases

1. Open the Agent detail page → **Evaluation** → **Evaluation Sets**.
2. Click **New Set** and give it a name (e.g. "Refund flows").
3. Click **New Case**, name it, then fill in the first turn:
   - **Request**: what the user says.
   - **Expected reply**: what the Agent should say back. Leaving it empty means the turn only sets up context.
4. To evaluate a multi-turn exchange, click **Add turn**. Turns can be moved up, moved down, or removed.

> [!TIP]
> Expected replies don't need to be word-perfect — just capture the key points. You compare them against the actual reply yourself; nothing does string matching.

### Writing multi-turn cases

Multi-turn cases verify that the Agent keeps track of context. For example:

| Turn | Request | Expected reply |
|------|---------|---------------|
| 1 | I want a refund for order #123 | Ask for the order date first, don't agree yet |
| 2 | I bought it 40 days ago | Explain it's past the 30-day window, offer credit instead |

These turns are sent in sequence **within one session**, so turn 2 builds on the context from turn 1.

## Running a task

1. Switch to the **Evaluation Tasks** sub-tab and click **Run Evaluation**.
2. Pick a set and optionally name the task (e.g. "baseline", "trying Sonnet").
3. Click **Run**. Cases execute one by one in the background and the page refreshes progress automatically.

While a task runs, its detail page shows a **progress bar and completed count**, and names the case currently executing. In the case list, the running case carries a spinner and cases still awaiting their turn read "Waiting".

**Queueing**: each Agent runs **exactly one** evaluation task at a time, and this is **not configurable**. A task holds its own workspace until every case has been replayed, so running two at once would let them interfere and make the results incomparable. Anything beyond that sits in **Queued** and starts on its own once the running task finishes — no need to submit it again. Agents queue independently, so a long evaluation on one never blocks another.

A task can be **cancelled** while it runs: a queued task is cancelled immediately, while a running one stops after the current case finishes, so a conversation is never cut off midway. Once a task ends — cancelled or failed — the cases it never reached are marked **Not run** rather than left reading "Waiting".

> [!NOTE]
> If the service restarts mid-evaluation, the interrupted task is marked **Failed** with the reason "Interrupted by a server restart" rather than being left stuck on "Running". Just start it again — finished tasks and recorded verdicts are unaffected.

> [!NOTE]
> A task freezes the **provider, model and prompt** in use when it was created and runs against that snapshot, so editing the Agent while a task is queued cannot change what it measures. If the snapshotted provider is removed from the Agent before the task starts, the task **fails** and names the missing provider — rather than quietly running on a different one and filing the results under the original.

> [!NOTE]
> Evaluation uses the Agent's **currently saved** config — publishing is not required. If you just edited the config, save it before running. Evaluation runs do not appear in [Run History](/wiki/runs) and are excluded from statistics and leaderboards.

## Reviewing results

Once a task finishes, open it and expand any case to see **request / expected reply / actual reply** side by side for each turn.

Mark it ✓ **Passed** if it looks right, ✗ **Failed** if it doesn't. Unreviewed cases sort to the top so you can work straight down the list.

The header tracks **passed / failed / unreviewed** counts and the pass rate. Pass rate counts reviewed cases only — right after a run it shows "—" rather than 0%.

## Comparing configurations

This is where evaluation pays off. Every task freezes a **config snapshot** recording:

- **Provider** (execution engine)
- **Model**
- **System prompt**

Expand "Config snapshot" in the task detail to view it. The task list is ordered newest first, so comparing pass rates across tasks shows which configuration performs best.

When a task's config differs from the previous one, the list flags **model changed** or **prompt changed**:

| Task | Model | Pass rate | Flag |
|------|-------|-----------|------|
| regression | Sonnet | 11/12 92% | |
| prompt v2 | Sonnet | 9/12 75% | ⚠ prompt changed |
| baseline | Opus | 11/12 92% | ⚠ model changed |

> [!IMPORTANT]
> These flags are what let you read a score change correctly. Above, "prompt v2" dropped because the prompt changed, not because the model regressed — without the flag it's easy to blame the wrong thing.

> [!NOTE]
> The snapshot records only provider, model and prompt. **No credentials are ever stored** (API keys, OAuth tokens and the like never reach the snapshot). Mounted Skills, MCP servers and knowledge bases are outside its scope.

## Permissions

Evaluation follows the Agent's own [member permissions](/wiki/members):

| Role | What they can do |
|------|-----------------|
| Viewer | View sets, cases, tasks and results |
| Editor | All of the above, plus manage sets/cases, run and cancel tasks, and record verdicts |
| Owner | Everything |

## Troubleshooting

**A case shows "Execution failed"**
Expand it to see the error. The usual cause is an invalid Provider credential or an unavailable model — check the Config tab and verify with a [debug chat](/wiki/agents).

**A multi-turn case only ran the first few turns**
When a turn fails, the rest of that case is skipped: later requests depend on context the failed turn was meant to establish, so sending them would only produce meaningless replies. Fix the cause and run the task again.

**I deleted the set — is the task history gone?**
No. Tasks keep the set name and all results so you can still review them.
