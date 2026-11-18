/** A Harness tab session's attempt (GET runs/{id}) as people read it: what it is doing or did, its verdict and its explanation. */

const EXECUTION_LABELS = {
  answered: 'Answered', refused: 'Refused', execution_failed: 'Execution failed', build_failed: 'Build failed', canceled: 'Canceled', interrupted: 'Interrupted', ended: 'Ended',
};

/** The verifier's explanation codes, as people read them. */
const EXPLANATION_LABELS = {
  invalid_answer: 'The answer does not have the shape the task requires.',
  refused_answer_case: 'The harness refused a case that has an answer.',
  answered_refusal_case: 'The harness answered a case it should have refused.',
  execution_failed: 'The harness did not produce a result.',
};

const VERDICT_LABELS = {pass: 'Pass', fail: 'Fail'};

/** What an attempt is doing or did: `Queued`, `Running`, or its execution status. */
export function attemptStatus(attempt) {
  if (attempt.state === 'queued') return 'Queued';
  if (attempt.state === 'leased') return attempt.cancel_requested ? 'Canceling' : 'Running';
  return attempt.execution ? EXECUTION_LABELS[attempt.execution.status] ?? attempt.execution.status : 'Finished';
}

/** An explanation code as text (an unknown code is shown as it is), or `''` for none. */
export const explanationText = code => (code ? EXPLANATION_LABELS[code] ?? code : '');

/** A case's verdict as text: `Pass`, `Fail`, or `Verifier error` when the verifier crashed, else `–`. */
export const verdictText = attempt => VERDICT_LABELS[attempt.verdict] ?? (attempt.verifier_error ? 'Verifier error' : '–');
