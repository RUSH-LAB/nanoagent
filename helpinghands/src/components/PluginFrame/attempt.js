/** A Harness tab session's attempt (GET runs/{id}) as people read it: what it is doing or did. */

const EXECUTION_LABELS = {
  answered: 'Answered', refused: 'Refused', execution_failed: 'Execution failed', build_failed: 'Build failed', canceled: 'Canceled', interrupted: 'Interrupted', ended: 'Ended',
};

/** What an attempt is doing or did: `Queued`, `Running`, or its execution status. */
export function attemptStatus(attempt) {
  if (attempt.state === 'queued') return 'Queued';
  if (attempt.state === 'leased') return attempt.cancel_requested ? 'Canceling' : 'Running';
  return attempt.execution ? EXECUTION_LABELS[attempt.execution.status] ?? attempt.execution.status : 'Finished';
}
