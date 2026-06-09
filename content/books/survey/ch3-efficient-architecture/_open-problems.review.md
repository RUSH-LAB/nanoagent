# Review: books/survey/ch3-efficient-architecture/open-problems.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Problem Formulation & Eval Rigor: The precise "100x more compute at inference time" claim has been softened to "orders of magnitude more compute" (line 54), so an ungrounded precise number is no longer presented as established fact.
- [resolved] Problem Formulation & Eval Rigor: The "tens of millions of dollars" training-run figure is now attributed as "by widely-reported estimates" (line 10) rather than asserted as bare fact.
- [minor, open] Synthesis over Summary: "The connection between linear attention and recurrent networks has been established by multiple groups" (line 32) remains uncited. Adding the originating reference (e.g. Katharopoulos et al. 2020, transformers-are-RNNs) would make the equivalence claim traceable. Non-blocking.
- [minor, open] Citation Integrity: "**Peng et al. (2023)** [@peng2023rwkv]" (line 31) is still rendered as an author-year string, breaking parallelism with the "Mamba-2's SSD framework" bullet above it. Renaming to the method ("RWKV") would restore consistent presentation. Substance is correct. Non-blocking.
- [minor, open] Balance & Currency: "**Adaptive precision**" (line 16) is still the only one of three adaptive-computation mechanisms without an exemplar citation, unlike early exit and Mixture-of-Depths. Adding a representative citation or marking it as under-explored would balance the list. Non-blocking.
- [minor, open] Scope & Coverage: "FlashAttention demonstrated that IO-aware algorithm design..." (line 22) names FlashAttention as a load-bearing exemplar without a citation here, unlike comparable named methods elsewhere. Adding the FlashAttention citekey would trace the claim to origin. Non-blocking.

## Citation verification
All seven citekeys used in this file resolve to references that appear elsewhere in the chapter: kaplan2020scaling, hoffmann2022training, schuster2022confident, raposo2024mixture, dao2024transformers, peng2023rwkv, ma2024bitnet158. None are broken. schuster2022confident and raposo2024mixture appear only in this file but are valid standard references (CALM early-exit; Mixture-of-Depths).

## Changes made
None in this pass. The two major issues flagged in the original review were already addressed in the prior revision (softened "100x", attributed training-cost estimate). No em-dashes, en-dashes, or stray double-hyphens remain in prose; frontmatter "---" delimiters are intact.

## Rationale for verdict change (REVISE -> ACCEPT)
Both major findings (ungrounded precise quantitative claims) were resolved by softening and attribution. The taxonomy gate is satisfied: the section organizes open problems into eight coherent, non-overlapping themes. The four remaining items are all minor citation-completeness/stylistic polish that do not affect correctness or grounding and can be addressed by the author at leisure.

## Left for human
- The "tens of millions of dollars" cost is attributed as "widely-reported estimates" rather than carrying a specific citekey; a human may add a precise source (e.g. an Epoch AI cost estimate) if desired.
- The o1/o3 inference-compute claim is softened to "orders of magnitude" rather than cited; a human may restore a quantitative figure with a verifiable citation (e.g. OpenAI o1 system card) if desired.
- Optional: add citations for the linear-attention/RNN equivalence (line 32), Adaptive precision (line 16), and FlashAttention (line 22), and rename "Peng et al. (2023)" to "RWKV" (line 31) for list parallelism.

## Remaining issues after repair
- Four minor, non-blocking citation-completeness/stylistic items remain open (lines 16, 22, 31, 32), all listed above.
