# Review: books/survey/ch3-efficient-architecture/inference-optimization.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 3, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4 (gate passes), Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification of prior fixes (all three majors resolved)
- Splitwise claim (line 43): now reads "1.4x higher throughput at 20% lower cost, or 2.35x more throughput under the same power and cost budget." Matches arXiv 2311.18677 / ISCA 2024. The 2.35x is correctly labeled as throughput, not latency. Resolved.
- Lab-attribution claim (line 16): the unsourced "adopted in production systems at Google, Anthropic, and other major AI labs" is now the hedged "widely deployed in production serving stacks." Resolved.
- KV-cache synthesis (line 35): a comparative paragraph was added contrasting H2O (accumulated-attention / heavy-hitter eviction), ScissorHands (persistence of importance), and SnapKV (observation-window selection), with guidance on when each applies (streaming vs prompt pre-compression). The subsection now compares rather than enumerates. Resolved.

## Findings (remaining, all minor and non-blocking)
- [minor] Citation Integrity: "**H2O (Heavy-Hitter Oracle)** (Zhang et al., 2024) [@zhang2024h2o]" (line 31) -> H2O is NeurIPS 2023 (arXiv 2306.14048, June 2023). The in-text year is still 2024 and references.yaml line 3043 still has `year: 2024`. Correct both to 2023.
- [minor] Problem Formulation and Evaluation Rigor: "MQA reduces it by h/1, GQA reduces it by h/G" (line 26) -> "h/1" is malformed reduction notation. MQA reduces the KV-cache by a factor of h; write "by a factor of h" to parallel the correct "h/G" for GQA.
- [minor] Balance and Currency: "For production deployment, TensorRT-LLM achieves the highest throughput on NVIDIA hardware." (line 57) -> superlative vendor claim with no citation, baseline, model, or hardware specified. Cite a head-to-head benchmark or soften (e.g., "is optimized for high throughput on NVIDIA hardware").
- [minor] Synthesis over Summary / Eval Rigor: "This reduces cache size by 80-90% with minimal quality degradation." (line 31) -> the H2O paper's headline operating point is a 20% KV-cache budget (~80% eviction); the 90% upper bound is not the paper's primary reported figure. State the 20%-budget figure and qualify "minimal degradation" with the regime.

## Decision rationale
All three major issues from the original review have been correctly fixed and verified against the primary sources. Taxonomy gate passes. The four items that remain are all minor (one factual citation-year slip duplicated in references.yaml, one notation nit, one unsourced superlative, one imprecise compression figure). None blocks publication; they are suitable for a human pass. Verdict upgraded REVISE -> ACCEPT.

## Remaining issues after repair
- H2O year is 2023, not 2024, in both the in-text citation (line 31) and references.yaml (line 3043).
- "h/1" should read "a factor of h" (line 26).
- TensorRT-LLM "highest throughput" superlative is uncited (line 57).
- H2O "80-90%" reduction should be stated as the paper's 20%-budget operating point with the regime qualified (line 31).
