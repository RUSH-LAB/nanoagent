# Review: books/programming/3-cuda-and-gpu/3-optimization.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 3, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 3, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Findings
- [resolved] Correctness and Grounding: The arithmetic-intensity table is now internally consistent under the FP32 4-bytes-per-read convention. Naive 1 FLOP / 4 bytes = 0.25 FLOPS/byte; generic tiled T FLOPS / 4 bytes = T/4; T=16 -> 16/4 = 4 FLOPS/byte; T=32 -> 32/4 = 8 FLOPS/byte. All rows match their own FLOPS-per-read columns.
- [resolved] Correctness and Grounding: The corrected T=16 value of 4 FLOPS/byte sits below the ~20 FLOPS/byte H100 FP32 ridge point, so the memory-bound conclusion holds, and the "16x reduction" prose stays consistent with the unchanged reads column (2N vs 2N/T at T=16).
- [resolved] Notation Consistency and Component Discipline: The truncated caption for code-optimization-4 is replaced with a descriptive caption referencing __shfl_down_sync and the skipped __syncthreads for the final 32 threads.
- [minor] Notation Consistency and Component Discipline: Captions for code-optimization-1, code-optimization-2, code-optimization-3, and code-optimization-5 still echo the preceding prose sentence rather than naming the technique demonstrated (e.g., "Warp divergence: divergent branch vs warp-aligned branch"). Non-gating.
- [minor] Correctness and Grounding: matmul_tiled still assumes N is an exact multiple of TILE and omits boundary guards on row/col. A one-line caveat in prose would prevent a reader from copying an out-of-bounds kernel for non-multiple N. Non-gating.
- [minor] Motivation and Conceptual Framing: The Parallel Reduction section still opens with a four-word lead-in ("Summing an array in parallel:") and a near-cold code block. One or two sentences on why a log-depth tree reduction beats a sequential sum would match the motivation given for tiling and divergence. Non-gating.

## Verdict rationale
The gate (Correctness and Grounding) now passes: both arithmetic blockers and the major reconciliation finding are resolved, and the remaining issues are all minor caption/motivation polish that do not affect correctness or grounding. No em-dash or en-dash characters are present; the only "--" occurrences are frontmatter delimiters, table separator rows, and the literal ncu --set flag inside a code block, all required syntax.

## Remaining issues after repair
- [minor] Captions for code-optimization-1, 2, 3, 5 repeat surrounding prose instead of naming the technique.
- [minor] matmul_tiled lacks a note that N must be a multiple of TILE (no boundary guards).
- [minor] Parallel Reduction section opens cold without motivating the tree (log-depth) approach.
