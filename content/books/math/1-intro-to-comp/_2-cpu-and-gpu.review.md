# Review: books/math/1-intro-to-comp/2-cpu-and-gpu.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 3, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 5, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Verification of prior fixes
- Major (Correctness): def-arithmetic-intensity now reads "$I^* \approx 67\text{ TFLOPS} / 3.35\text{ TB/s} \approx 20$ FLOPs/byte" and is labeled "non-Tensor-Core FP32 peak". Verified: 67 / 3.35 = 20.0, consistent with tab-cpu-vs-gpu (Peak FP32 ~67). Resolved.
- ex-roofline now references $I^* \approx 20$. Verified: n=4096 gives I = 682.7 (compute-bound, >> 20); n=32 gives I = 5.33 (memory-bound, < 20). Math correct and consistent. Resolved.
- Em-dash / "--" removal: confirmed 0 prose occurrences. Remaining "--" are markdown table separator rows and the frontmatter fences (required syntax). Table empty cells use "n/a"; ranges use "to"; "Gram-Schmidt" and "Compute-Memory" use hyphens. Resolved.
- tab-machine-epsilon values verified against 2^{-p}: FP64 1.11e-16, FP32 5.96e-08, FP16 4.88e-04, BF16 3.91e-03. All correct.

## Findings (still open, all minor, none gating)
- [minor] Correctness & Grounding: def-machine-epsilon keeps the verbal phrasing "smallest positive floating-point number $\epsilon$ such that $\text{fl}(1 + \epsilon) \neq 1$" alongside the formula $\epsilon_{\text{mach}} = 2^{-p}$ and "error bounded by $\epsilon_{\text{mach}}/2$". The verbal definition describes the spacing $2^{-(p-1)}$ (one ulp at 1), while the formula and the error clause use the unit-roundoff convention $2^{-p}$. The table values match $2^{-p}$. Recommend aligning the verbal definition to the unit-roundoff convention (define as the unit roundoff $u = 2^{-p}$) or dropping the "smallest $\epsilon$ such that..." phrasing.
- [minor] Correctness & Grounding: def-gpu-architecture still states "Shared memory / L1: ~228 KB per SM". The H100 SM has 256 KB combined L1 + shared, of which up to 228 KB is configurable as shared. Recommend "256 KB combined L1/shared (up to 228 KB usable as shared scratchpad)".
- [minor] Notation & Component Discipline: tab-float-formats lists TF32 "Total Bits = 19" in the same column where FP32 = 32. TF32 occupies a 32-bit register with only 19 meaningful bits. Recommend a footnote or a "Significant bits" column label so readers do not infer a 19-bit storage format.
- [minor] Completeness: ex-roofline computes I* for the FP32 CUDA-core path only. Tensor Cores (emphasized later as "the key to GPU performance") have a ridge point an order of magnitude higher (e.g. ~990 TFLOPS BF16 / 3.35 TB/s is about 295 FLOPs/byte). One sentence noting that the n=4096 matmul is comfortably compute-bound on CUDA cores but closer to the boundary on Tensor Cores would strengthen the section.

## Rationale for ACCEPT
The single major correctness defect (the inconsistent H100 I* of ~24) is fixed and now internally consistent with the page's own spec table and the downstream worked example. The gate dimension is satisfied. All remaining items are minor polish (a definitional convention mismatch and two framing clarifications) that do not undermine any load-bearing claim. Worked examples (softmax shift, roofline) are correct and well chosen. The chapter is publishable as is.

## Remaining issues after repair
- [minor] Machine-epsilon verbal definition vs. formula convention mismatch.
- [minor] 228 KB shared memory should be framed as the max shared partition of 256 KB combined L1/shared.
- [minor] TF32 "19 bits" column could mislead (storage is 32-bit).
- [minor] No note on the much higher Tensor-Core roofline ridge point.
