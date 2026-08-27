# Review: books/programming/4-assembly/3-simd.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Correctness & Grounding: 4, Motivation: 5, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 2, Completeness: 4

## Re-review scores
Correctness & Grounding: 4, Motivation: 5, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 5, Completeness: 4

## Findings (verified against revised file)
- [resolved] Notation & Component Discipline: all 9 prose "--" occurrences are gone. Line 7 now reads "was not clock speed: it was SIMD" and "the same fundamental idea (data parallelism)". Line 52 reads "192 GFLOPS, comparable to a low-end GPU". Line 144 restructured with a colon. Line 204 uses periods. The four numbered items in rmk-simd-why-matters (lines 263-266) use bold-label-period format. A repo-wide grep for "--" returns only frontmatter delimiters, markdown table separator rows, and the ASCII divider inside the quantization code block (line 250); none are prose dashes. No unicode em-dash or en-dash present.
- [resolved] Correctness & Grounding: the "Divergence" CPU SIMD cell (line 217) now states "Handled by predication/masking: every lane executes, inactive lanes are masked off", consistent with the page's own _mm256_blendv_ps usage and the AVX-512 masking content. Contradiction removed.
- [resolved] Correctness & Grounding: the "Parallelism model" GPU cell (line 216) now reads "One instruction per warp-scheduler issue (pre-Volta lockstep; Volta+ has independent per-thread PCs)". Accurate.
- [minor, open] Correctness & Grounding: line 76 still annotates _mm256_loadu_ps as "~5% slower". On Haswell and later the unaligned load has the same throughput as the aligned load when the data is actually aligned; the penalty appears only on cache-line or page crossing. The fixed percentage overstates a workload-dependent effect.
- [minor, open] Correctness & Grounding: line 255 lists INT4 at "16x (with packing)". AVX-512 has no native INT4 arithmetic, so the 16x is a storage and bandwidth figure that requires unpacking to INT8 before compute. The caption frames the table as throughput, which could mislead.
- [minor, open] Correctness & Grounding: line 264 keeps "scatter/gather from random addresses is 5-10x slower" without a source. This is a load-bearing quantitative claim and is hardware and access-pattern dependent.
- [minor, open] Worked Examples: the single fully-worked dot-product kernel (code-simd-fma-dot) is solid but there is still no Example component with faded guidance for a second, harder case (for example the horizontal-sum derivation or a matrix-vector kernel). Adequate, not exemplary.

## Assessment
Both prior blockers (prose "--" usage and the self-contradicting SIMD-vs-SIMT table cells) are fully resolved. The Correctness gate passes: no factual errors remain that would mislead a reader; the open items are quantitative softenings and a sourcing nit, all minor. Notation discipline is now clean. Motivation, scaffolding, and completeness remain strong. Verdict raised from REJECT to ACCEPT.

## Remaining issues after repair
- Soften or source the "~5% slower" unaligned-load figure (line 76).
- Add an unpacking caveat to the INT4 "16x" row, or relabel the column as bandwidth (line 255).
- Cite or soften the "5-10x slower" scatter/gather figure (line 264).
- Optional consistency: rmk-simd-simt-mental-model (line 227) and the GPU "Divergence" cell (line 217) still use the "lockstep" / "serialized branches" framing affected by Volta independent thread scheduling; align with the table's parallelism-model wording if full consistency is desired.
- Optional: add a second faded-guidance Example to satisfy the expertise-reversal criterion.
