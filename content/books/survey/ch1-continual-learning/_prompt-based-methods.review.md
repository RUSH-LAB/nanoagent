# Review: books/survey/ch1-continual-learning/prompt-based-methods.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 6
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 3, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification performed
- Double-dash / em-dash scan: the only "--" occurrences are the two frontmatter delimiter lines (lines 1 and 4), which are required YAML fence syntax. No em-dash (U+2014) characters in the file. House-style violation resolved.
- Citekey resolution: all 6 citekeys present in references.yaml (dosovitskiy2021image, wang2022learning_l2p, wang2022dualprompt, wang2022sprompts, smith2023codaprompt, wang2024hierarchical_hide). The previously mis-cited kim2023achieving has been removed; no broken keys remain.
- Reference-title cross-checks confirm the substantive fixes: wang2022sprompts title is "An Occam's Razor for Domain Incremental Learning", so the revised S-Prompts subsection correctly frames the DIL setting; wang2024hierarchical_hide and smith2023codaprompt titles match their subsection descriptions.

## Resolved since prior revision
- S-Prompts subsection now states the domain-incremental-learning setting explicitly, corrects the test-time mechanism to K-means centroids plus a KNN domain-inference rule, and explains why the DIL framing makes its simplicity competitive against L2P and DualPrompt. Synthesis issue resolved.
- HiDe-Prompt subsection now carries a comparative takeaway (more reliable Mahalanobis task inference yields higher average accuracy than CODA-Prompt on Split-ImageNet-R) plus a concrete limitation (per-task covariance memory growth and the well-clustered-feature assumption). It is now synthesis rather than an annotated entry.
- The mis-cited fairness claim no longer carries a wrong citation; dropping it is the correct conservative fix.
- L2P subsection now states a limitation, so it carries both sides.

## Remaining issues (non-blocking)
- [minor] Problem Formulation and Evaluation Rigor: the L2P claim "significantly outperforming methods that fine-tune the backbone, while using far fewer trainable parameters" (line 14) still lacks a number and a metric definition. Cross-link to benchmarks.md or cite a specific accuracy so the superlative is not setting-blind.
- [minor] Citation Integrity: the CODA-Prompt accuracy figures (line 30: 72.80 vs 61.57 vs 68.13) should be attributed to the CODA-Prompt paper's harmonized re-implementation table so 61.57/68.13 are not read as original-paper values.
- [minor] Balance and Currency: the CODA-Prompt subsection still gives only advantages with no per-method limitation in place (S-Prompts now embeds a takeaway about limited sharing benefit, which substantially covers it). Add a one-line limitation to CODA-Prompt for full per-family balance.
- [minor] Synthesis: HiDe-Prompt still lacks the verified numeric accuracy vs CODA-Prompt's 72.80 percent; the qualitative comparison is correct and directionally accurate, but a verified figure from the HiDe-Prompt paper would strengthen it.
- [open] Comparison-fairness claim (line 44) is now uncited. If a source that explicitly argues the pre-trained-vs-from-scratch comparison is unfair exists in references.yaml, add it; otherwise softening to "it has been observed that" is acceptable.

## Rationale for ACCEPT
The taxonomy gate passes: the chapter organizes prompt-based methods along a coherent, non-overlapping conceptual progression (pool selection, shared/task-specific split, per-domain prompts, attention-based composition, hierarchical task statistics). The two prior major synthesis issues and the major citation-integrity issue are resolved and verified against the references. The house-style double-dash violation is cleared. Remaining items are minor polish (missing numbers, attribution notes, one absent per-method limitation) that do not block publication and can be folded into a later pass.
