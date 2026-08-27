# Review: books/survey/ch3-efficient-architecture/state-space-models.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 3, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Verification of prior repairs
- [RESOLVED] Citation Integrity (S4 accuracy): Line 22 now reads "on Path-X S4 reached an accuracy of roughly 88%". Both the figure (88, from Gu et al. 2022) and its scope (Path-X, not a full-benchmark average) are corrected. The earlier wrong 86%/average framing is gone.
- [RESOLVED] Citation Integrity (S4D bare attribution): Line 24 now reads "**S4D** [@gu2022parameterization]". The citekey resolves in references.yaml (entry at line 3080: Gu, Goel, Gupta, Re, "On the Parameterization and Initialization of Diagonal State Space Models", NeurIPS 2022, arxiv 2206.11893). The bare author-year attribution is gone.
- [RESOLVED] Balance & Currency (duplicate Mamba-2 citekey): references.yaml no longer contains a dao2024mamba2 entry; only dao2024transformers (line 3102, arxiv 2405.21060) remains. The key is used consistently across the chapter (taxonomy.md line 14, state-space-models.md line 34, open-problems.md line 30). No double-counted source.
- [CONFIRMED] Em-dash rule: a unicode (en-dash, em-dash) and literal "--" scan of the file body found zero occurrences. The only matches are the two required YAML frontmatter "---" fences on lines 1 and 4, which are correct and must not be altered.

## Citation integrity check
All nine citekeys in this file resolve in references.yaml: gu2022efficiently, gu2020hippo, gu2022parameterization, gu2024mamba, dao2024transformers, lieber2024jamba, de2024griffin, glorioso2024zamba. No broken keys.

## Findings (remaining, all minor)
- [minor] Synthesis over Summary: Line 32 "Mamba matches Transformer quality on language modeling (perplexity) while being 5x faster at inference for long sequences (because it processes each token in O(1) time after a linear-time forward pass...)". The regime is now partially named ("long sequences", "after a linear-time forward pass"), but the cached-autoregressive-decode framing is implicit. Optional: state explicitly that the 5x is inference throughput in the KV-cache-free decode regime, not training.
- [minor] Problem Formulation & Eval Rigor: Line 32 "unlike attention's O(n) per-token inference cost". "Per-token inference cost" implies the autoregressive decode setting but does not name it as the cached-decode regime. Optional: tie the O(1)/O(n) contrast explicitly to the throughput metric defined in benchmarks.md.
- [minor] Synthesis over Summary: Line 40 Jamba "delivered high quality with excellent efficiency, fitting a 256K-token context window in a single 80GB GPU". The concrete anchor (256K context, 80GB GPU, 52B/12B MoE) is now present, which satisfies the "anchor with a concrete number" request. The residual vague clause "high quality with excellent efficiency" could still be tightened, but the load-bearing figures are stated.

These are polish-level refinements that do not block acceptance. The two majors that drove the original REVISE verdict (the wrong S4 accuracy number and the unresolvable S4D attribution) are both fixed and verified against references.yaml.

## Left for human
- The exact Path-X figure (reported as roughly 88, i.e. 88.10 in Table 8 of Gu et al. 2022) and the S4D arxiv ID (2206.11893) / author order were taken from the prior pass and the references.yaml entry; both look correct but were not re-traced to the primary PDFs from within this environment. Confirm before publishing if precision matters.
- The reviewer brief listed "Em-dash occurrences found: 5", but an independent unicode and literal scan of the current file body found zero (only the two required frontmatter fences). The dashes were evidently removed in a prior pass; no action needed unless this is unexpected.

## Remaining issues after repair
None blocking. Three optional minor polish items listed above under Findings.
