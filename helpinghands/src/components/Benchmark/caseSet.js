/** The case set view model: what a member reads of a benchmark (GET benchmarks/{id}) before running it or reading its results. Private references never arrive. */

export const KIND_LABELS = {answer: 'Answer', refuse: 'Refuse'};

/** `{task: {id, kind, description}, context, cases: [{id, kind, input, expectedError}]}`: the cases in the case set's order, each input as indented JSON. */
export function caseSetView(benchmark) {
  return {
    task: {id: benchmark.task_id, kind: benchmark.task?.kind ?? benchmark.task_kind, description: benchmark.task?.description ?? ''},
    context: (benchmark.context ?? '').trim(),
    cases: [...(benchmark.cases ?? [])].sort((a, b) => a.position - b.position).map(item => ({
      id: item.case_id, kind: KIND_LABELS[item.kind] ?? item.kind, input: JSON.stringify(item.arguments ?? {}, null, 2), expectedError: item.expected_error ?? null,
    })),
  };
}
