# Review: books/survey/ch5-randomized-signal/randomized-regularization.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 10
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores (after revision)
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Citation Integrity: the Goyal et al. (2017) linear learning-rate scaling attribution now carries the inline [@goyal2017accurate] citekey (line 36). The entry exists in references.yaml. All 20 citekeys in the file resolve against references.yaml; no broken or fabricated citations.
- [resolved] Balance & Currency: every regularization family now states a concrete limitation: dropout (batch-normalization variance shift, slower convergence, marginal gains on convnets), stochastic depth (benefit confined to deep residual nets, gradient noise, extra hyperparameter), DropConnect (per-weight masking overhead, limited adoption), DropBlock (sensitive block-size/drop-rate schedule, conv-specific), SGD (gradient-variance slowdown, lost regularization in large-batch regime), and data augmentation (distribution shift, label noise from mixing). The one-sided framing flagged originally is fixed.
- [resolved] Em-dashes: no prose "--" or em-dashes remain. The only "--" occurrences are the YAML frontmatter delimiters on lines 1 and 4, which are required.
- [minor, open] Taxonomy Quality: the file still opens with a single H1 then jumps to H3 ("### Dropout", line 10), skipping the H2 level. Promote the section headings from "###" to "##" so the heading hierarchy is well-formed and matches sibling deep-dive files.
- [minor, open] Citation Integrity: AutoAugment (line 44), the direct baseline for the RandAugment efficiency claim, is still named without a citekey. DeiT and Vision Transformers (line 22) are illustrative and acceptable uncited, but the AutoAugment comparison is load-bearing and should carry a citation.
- [minor, open] Currency: the newest cited work is still RandAugment / CutMix (2020). For a chapter dated 2026 in an active area, add a recent pointer (modern stochastic regularization in 2023-2025 ViT/LLM training) or state the scope cutoff explicitly.
- [minor, open] Problem Formulation & Eval Rigor: the SGD-as-temperature claim (learning_rate / batch_size as effective temperature, line 36) is now adjacent to the cited Goyal empirical result and the hardt2016train stability point, so it reads as an explanatory heuristic rather than a bare assertion. Attaching the originating SDE/temperature analysis citekey would still strengthen it, but this is no longer a blocking gap.

## Changes made
No edits made during this re-review. The prior pass had already removed all prose em-dashes, added the [@goyal2017accurate] inline citation, and added a per-family limitation. Verified independently: em-dash scan returns only the two YAML delimiter lines, and all 20 citekeys resolve against mochi-lab/references.yaml.

## Left for human
- The remaining open items are minor polish (heading-level promotion, one AutoAugment citation, a currency pointer or stated cutoff, an optional temperature-claim citation). None block acceptance and none require fabricating sources.

## Remaining issues after repair
- [minor] Promote section headings from "###" to "##" for well-formed hierarchy.
- [minor] Add an AutoAugment citation as the RandAugment baseline.
- [minor] Add a 2023-2025 pointer or an explicit scope cutoff for currency.
- [minor] Optionally cite the originating SDE/temperature analysis for the learning-rate-to-batch-size temperature claim.
