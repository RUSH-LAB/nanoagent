# Review: books/survey/ch3-efficient-architecture/efficient-attention.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4. Taxonomy Quality gate: PASS.

## Findings
- [resolved][major] Problem Formulation and Evaluation Rigor: The FlashAttention HBM-access bound is now stated correctly as O(n^2 d^2 / M) on line 44, with the load-bearing d^2 << M argument made explicit (d typically 64-128, M on the order of 100KB). Matches Dao et al. 2022.
- [resolved][major] Balance and Currency: Per-family balancing limitations were added for MQA (quality degradation and training instability from aggressive sharing, line 56), MLA (decoupled-RoPE implementation complexity, line 62), Ring Attention (exposed communication latency when chunks are small or interconnect is limited, line 68), Differential Attention (still O(n^2), two softmax maps plus extra projections, line 78), and NSA (approximate, heuristic-dependent, requires hardware-aligned kernels, line 82). GQA already stated its tradeoff. Linear attention already stated its expressiveness limitation. The survey now reads as even-handed.
- [resolved][major] Synthesis over Summary: The number-free MLA claim was replaced with the concrete DeepSeek-V2 figure (93.3% KV-cache reduction versus the MHA baseline, quality matching or exceeding on standard benchmarks, line 62).
- [open][minor] Citation Integrity: One cross-chapter duplicate key remains. This file cites FlashAttention-2 as @dao2024flashattention2 (line 46) while taxonomy.md cites the same paper as @dao2023flashattention2. Both keys exist in references.yaml, so neither is broken and the bibliography renders, but the paper is double-keyed across the chapter. The zaheer2020bigbird and ye2024diff_transformer keys were reconciled and now agree. Recommend collapsing the two FlashAttention-2 keys to one. Non-blocking.
- [open][minor] Synthesis over Summary: The section still ends on the NSA paragraph with no closing cross-family synthesis paragraph (the axis each family trades on: exact vs approximate, compute vs IO vs KV-cache, train-time vs inference-time). The per-family limitations partially supply the contrast, but a one-paragraph comparative takeaway would strengthen the close. Non-blocking.
- [open][minor] Scope and Coverage Completeness: No explicit one-sentence scope statement opens the section delimiting attention-only methods versus full-architecture replacements (SSMs in a sibling file). The intro sentence on line 8 implies the boundary but does not state it. Non-blocking.
- [open][minor] Problem Formulation and Evaluation Rigor: Remaining speedup numbers (2-4x line 44, up to 2x line 46, 50-73% line 46, 75%+ line 48, 32x line 56) are stated without naming the full measurement regime (sequence length, head dim, forward vs backward, GPU). Some now carry a GPU (A100, H100); pinning each to its regime and source would remove the residual setting-blind framing. Non-blocking.
- [open][minor] Taxonomy Quality: MQA, GQA, and MLA remain three sibling top-level subsections alongside orthogonal axes (Sparse, Linear). Grouping them under one "KV-cache reduction" heading would make the top-level axes follow one organizing principle. The gate still passes because the existing structure is coherent and navigable. Non-blocking.

## Changes made (by the revision being reviewed)
The revision applied the three major fixes (FlashAttention bound, per-family balancing limitations, concrete MLA numbers) and removed all 9 em-dash and double-hyphen occurrences, leaving only the two frontmatter delimiters. NSA was changed from "achieves significant speedups" to "reports speedups" plus a balancing limitation rather than fabricating a number. Two of three duplicate citekeys were reconciled with taxonomy.md.

## Verdict rationale
All three major issues are resolved. The em-dash constraint is satisfied. No broken citekeys. The six remaining items are all minor and non-blocking: one residual cross-chapter duplicate key (renders fine), a missing closing synthesis paragraph, a missing explicit scope sentence, residual setting-light speedup numbers, and an optional KV-cache regrouping. The section is publishable as is. Verdict: ACCEPT.

## Remaining issues after repair
- FlashAttention-2 is double-keyed across the chapter: @dao2024flashattention2 here vs @dao2023flashattention2 in taxonomy.md. Collapse to one key.
- Add a closing cross-family synthesis paragraph naming the axis each family trades on.
- Add a one-sentence scope statement delimiting attention-only methods vs full-architecture replacements.
- Pin the residual speedup numbers (2-4x, up to 2x, 50-73%, 75%+, 32x) to their measurement regime and source.
- Consider grouping MQA, GQA, and MLA under a single KV-cache reduction heading.
- Human still to confirm the NSA speedup figure and regime from Yuan et al. 2025, and the DeepSeek-V2 93.3% figure and its quality benchmarks, before publishing.
