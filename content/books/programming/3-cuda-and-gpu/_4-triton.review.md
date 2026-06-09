# Review: books/programming/3-cuda-and-gpu/4-triton.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 3
- Broken citekeys: []

## Original scores
Correctness & Grounding: 3, Motivation: 5, Worked Examples: 4, Cognitive Load & Scaffolding: 5, Notation & Component Discipline: 4, Completeness: 4

## Findings
- [resolved][major] Correctness & Grounding: The matmul kernel (code-triton-matmul) previously masked only the K dimension in its tile loads, so partial tiles where offs_m >= M or offs_n >= N read past the end of A and B. The revision adds a `k_mask` helper (line 144) and now uses `(offs_m[:, None] < M) & k_mask[None, :]` for the A tile and `k_mask[:, None] & (offs_n[None, :] < N)` for the B tile (lines 145-146). Edge tiles no longer read out of bounds, and the "Complete" caption is now accurate. Verified.
- [resolved][minor] Notation & Component Discipline: All three prose " -- " occurrences (lines 7, 105, and the autotune code comment) are gone. Line 7 now uses a colon, line 105 reads "since it dominates", and the autotune comment is a parenthetical. Confirmed no prose "--" or em/en-dash characters remain (only frontmatter delimiters and Markdown table separator rows).
- [open][minor] Correctness & Grounding: The "80-95% of the performance of hand-written CUDA" claim (line 11) is still unsourced and still inconsistent with rmk-triton-performance, which lists GEMM at 80-90% and FlashAttention at 70-85% (below the asserted 80% floor). Soften the prose or align the range with the table.
- [open][minor] Correctness & Grounding: In code-triton-1, block size 256 is hardcoded in both the grid computation (line 38) and the launch (line 39). A single BLOCK_SIZE variable would prevent a reader from desyncing them. Pedagogical hazard only, not a runtime bug at n=1024.
- [open][minor] Completeness: The fused-softmax kernel (line 93) assumes one row fits in a single BLOCK_SIZE (one program per row). The single-pass assumption and its width limit are still not stated; very wide rows need a streaming/online softmax.

## Changes made
None by this reviewer. The prior revision already fixed the gating out-of-bounds read in code-triton-matmul (M/N bounds added to both load masks via a `k_mask` helper) and removed all three prose em-dash occurrences (line 7 colon, line 105 "since it dominates", autotune comment parenthetical). I independently re-read the file and verified both fixes: the load masks now guard M, N, and K, and no prose "--" or em/en-dash characters remain. Math, code logic, frontmatter, MDX components, and voice are intact.

## Left for human
- None

## Remaining issues after repair
- [minor] Unsourced 80-95% performance claim (line 11) inconsistent with the performance table.
- [minor] Hardcoded 256 block size duplicated across grid and launch in code-triton-1.
- [minor] Single-pass / one-row-per-block assumption of the fused softmax not stated, with no note on the width limit.

All remaining issues are minor and non-blocking. The gating Correctness defect is resolved, so the verdict moves from REVISE to ACCEPT.
