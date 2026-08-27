# Review: books/programming/1-intro-to-comp/1-comp-machine.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 146
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 2, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores (after revision)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings (verified against the revised file)
- [resolved][blocker] Correctness and Grounding: the invented `torch.cuda.memory_map` symbol is gone. Line 288 now describes the real mechanism: CUDA managed memory via `cudaMallocManaged`, reached in PyTorch through a custom `torch.cuda.CUDAPluggableAllocator`. Accurate.
- [resolved][blocker] Notation Consistency and Component Discipline: no dash-as-punctuation "--" remains in prose, lists, code comments, or remarks. The 12 surviving "--" tokens are all structural: YAML frontmatter delimiters (lines 1, 3), Markdown table separator rows (lines 48, 97, 300), and ASCII diagram borders/arrows (lines 24, 270, 272, 273, 275, 276, 277). Altering those would break rendering, so leaving them is correct.
- [resolved][major] Correctness and Grounding: line 133 SSD sequential-read figure updated from 1 ms to 200,000 ns (200 us), now consistent with the table's stated 3-7 GB/s NVMe bandwidth and the "2024 hardware" label.
- [resolved][major] Worked Examples and Illustration: two new <Example> blocks added (ex-cache-miss-count and ex-effective-bandwidth). Both walk a derivation step by step with faded boxed-? guidance and a revealed solution, using only numbers already present in the file (64-byte line, float32, N = 1M, 50 GB/s DRAM). The first grounds the ~10x observed speedup against a derived 16x ceiling; the second is a harder effective-bandwidth derivation. The arithmetic checks out (N/16 = 65,536; 16x ratio; 50/16 = 3.125 GB/s).
- [open][minor] Correctness and Grounding: line 39 prose still says a misprediction wastes "10-20 cycles". The latency table (line 127) gives a 5 ns penalty, which is ~20 cycles at 4 GHz, so the top of the prose range matches; the two figures are now internally consistent. Deep 20-stage pipelines can exceed 20 cycles, but the file does not claim otherwise. Non-blocking.
- [open][minor] Notation Consistency and Component Discipline: the table lists DRAM bandwidth as 50-100 GB/s (line 102) while rmk-ml-latency-implications cites ~50 GB/s on CPU (line 149). These are loosely consistent (50 sits inside 50-100) and the example explicitly anchors to the 50 GB/s end. Could be tightened to a single CPU-DRAM figure, but does not mislead. Non-blocking.

## Assessment of the repair
The two blockers and both majors flagged in the original review are fully resolved and verified in-file. The two remaining items are minor, internally consistent, and do not gate publication. Correctness now clears the gate. Worked-example coverage and component discipline both rise from 2 to 4. The section reads as motivated, correctly grounded, and complete.

## Remaining issues after repair
- [minor] Reconcile or annotate the branch-mispredict "10-20 cycles" prose (line 39) with the implied ~20-cycle / 5 ns figure (line 127), ideally stating the assumed pipeline depth.
- [minor] Pick one CPU-DRAM bandwidth figure across the table (line 102) and rmk-ml-latency-implications (line 149) to avoid the 50-vs-50-100 GB/s split.
- [note] The new <Example> blocks use <details><summary>Solution</summary> for the faded-answer reveal, matching the book's existing component vocabulary. If the MDX system later gains a dedicated fade/spoiler convention, a human may want to swap these in.
