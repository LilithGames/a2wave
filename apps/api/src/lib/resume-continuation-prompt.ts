/**
 * The turn sent when continuing an interrupted run.
 *
 * Every supported CLI treats resume as "this session, plus a new turn", and
 * appends whatever prompt it is handed — `codex exec resume <id> ... <prompt>`,
 * `claude --resume <id> ... <prompt>`. Handing back the original instruction
 * would ask for the whole task again, repeating side effects the session had
 * already committed, which is precisely what resuming is meant to avoid.
 *
 * The session itself carries the task: the CLI replays its own transcript, so
 * the model already has the instruction, the work done, and the tool results.
 * All this turn has to supply is why it is being asked again.
 *
 * Deliberately does not restate the original prompt. Anything repeated here
 * reads as a fresh instruction and reintroduces the replay.
 */
export function buildResumeContinuationPrompt(_originalPrompt: string): string {
  return [
    'Your previous turn was interrupted by a server restart, not by an error.',
    'Review what you had already completed in this session before doing anything.',
    'Continue from where you stopped, and do not repeat work or tool calls that already succeeded.',
    'If the task was already finished, say so instead of redoing it.',
  ].join(' ')
}
