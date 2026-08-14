/**
 * The outcome vocabulary shared by the removal protocol and its callers.
 *
 * Lives in its own leaf module because both sides need it: the guarded remover
 * raises the signal, and the cleanup boundary decides whether a workload lease
 * may be released on the strength of it. Importing it from either of those
 * would make them import each other.
 */

/**
 * The worktree is still on disk, but a durable removal reservation exists and
 * is no longer owned by this process — the reconciler will finish it.
 *
 * This is a **positive signal, raised only after the reservation was actually
 * committed**, never an inference from "cleanup threw". That distinction is
 * load-bearing: everything before the reservation insert (reading the run, the
 * Agent, the source row, building the SCM handle) can also fail, and those
 * failures leave no durable mark at all. Treating them as a handoff would
 * release the workload lease while nothing blocks the worktree — the exact
 * race the reservation exists to prevent.
 */
export class WorkspaceRemovalHandedOffError extends Error {
  constructor(
    readonly reservationId: string,
    options: { cause: unknown },
  ) {
    super(`Workspace removal handed off to the reconciler: ${reservationId}`)
    this.name = 'WorkspaceRemovalHandedOffError'
    this.cause = options.cause
  }
}
