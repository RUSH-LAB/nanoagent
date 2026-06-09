# Review: books/programming/2-torch/4-data-loading.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 4
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 5

## Re-review scores (after revision)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 5

## Findings
- [resolved] Correctness and Grounding: prefetch_factor default. The parameter table (line 121) now reads `None (effective 2 when num_workers > 0)` and adds "Setting it with num_workers=0 raises an error"; the DataLoader code comment (line 99) was updated to "only valid when num_workers > 0". Matches current PyTorch 2.x behavior.
- [resolved] Correctness and Grounding: runnable StreamingDataset snippet. Lines 174-176 add `import glob`, `import json`, `import torch`; the undefined `process_line(line)` is replaced with `json.loads(line)` (line 202). The usage block at line 205 now runs given valid input files.
- [resolved] Worked Examples and Illustration: missing step-by-step computation. A new fully worked `<Example id="ex-padding-savings">` (lines 304-326) counts padded tokens for six sequences (10/40/60/90/480/500) under fixed-max, dynamic-random, and bucketed padding. Arithmetic independently verified: fixed 3072, dynamic 2140, bucket 1260, reduction 41%, vs fixed 59%. This grounds the previously bare 30-50% claim, and line 301 was reworded to point to the example.
- [resolved] Notation Consistency and Component Discipline: prose em-dashes. All four prose `--` occurrences removed (intro line 7, two inline comments, prefetch area). Independent scan confirms the only remaining `--` matches are markdown table separator rows (lines 75, 117, 392) and YAML frontmatter delimiters (lines 1, 3). No em-dash characters present.
- [minor, open] Correctness and Grounding: pin_memory overhead figure. Line 162 still asserts "The extra copy adds ~30% overhead. Always use pin_memory=True when training on GPU" and the table (line 120) still says "10-30% faster". The mechanism is correct, but the single number is workload-dependent and uncited. Soften to "often 10-30% depending on batch size and transfer pattern" or cite a benchmark.
- [minor, open] Correctness and Grounding: per_worker sharding edge case. Line 192 `per_worker = len(self.file_paths) // worker_info.num_workers` yields 0 when files < workers, silently giving early workers empty shards and the last worker everything. Worth a one-line guard or round-robin note (self.file_paths[worker_id::num_workers]).
- [minor, open] Correctness and Grounding: BucketSampler re-batching. The sampler (line 295) does `yield from batch`, so DataLoader's batch_size re-batches the flat indices; bucket boundaries are only preserved when length is divisible by batch_size, and it conflicts with the default sampler. Implementing as a batch_sampler (yielding lists) would guarantee bucket-aligned batches; otherwise note the constraint.

## Verdict rationale
Both major findings from the original review (prefetch_factor correctness and the absent worked example) are fully resolved, the correctness gate passes, all prose em-dashes are gone, and tags are balanced (Example 1/1, Remark 6/6). The three remaining items are minor, were correctly logged as residuals, and do not block publication. Verdict raised from REVISE to ACCEPT.

## Left for human
- The 30-50% padding-savings range is grounded by one verified worked example (41%) but the range band itself is uncited; attach a benchmark if one exists.
- The three minor open correctness items above (pin_memory figure, per_worker edge case, BucketSampler re-batching) are optional polish a maintainer may choose to address.

## Remaining issues after repair
- pin_memory ~30% / 10-30% figure is uncited and workload-dependent (lines 120, 162).
- per_worker integer-division sharding unbalances load when file count < worker count (line 192).
- BucketSampler yields flat indices and is re-batched by DataLoader; bucket boundaries only hold when length divides evenly by batch_size (line 295).
