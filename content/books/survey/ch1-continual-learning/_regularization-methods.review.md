# Review: books/survey/ch1-continual-learning/regularization-methods.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 7
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Findings
- [resolved] Taxonomy Quality (gate): BiC, WA, and LUCIR are now lifted out of "Functional Regularization" into a new top-level "## Bias Correction in Class-Incremental Learning" section (lines 64 to 78). The lead-in correctly frames these as post-hoc classifier-calibration, rehearsal-adjacent methods that assume stored exemplars, which removes the MECE violation and resolves the prior conflict with LwF's "no stored exemplars" claim. The three axes (weight regularization, functional regularization, bias correction) are now mutually exclusive. Gate passes.
- [resolved] Balance and Currency: A "## Scope and Currency" section (lines 88 to 90) now honestly bounds the chapter to 2016 to 2022 classical methods and names the out-of-scope recent lines (prompt-based, parameter-efficient, foundation-model continual learning). Acceptable given the constraint that recent-work citekeys could not be verified.
- [resolved] Problem Formulation: The three unsupported superlatives are softened to attributed phrasing. PODNet "improves over output-level distillation alone, with the gap reported as most pronounced..." (line 62), BiC "reports improved class-incremental performance" (line 74), WA "is reported to be competitive" (line 78). All carry primary-source citekeys. No fabricated numbers, which is the correct call.
- [open, minor] Balance and Currency: Line 58 still reads LwF "making it fully privacy-preserving and memory-efficient." The changelog states this was softened to "no stored raw exemplars," but the file still contains "fully privacy-preserving." LwF retains a frozen copy of the previous model (f_theta_old), which can leak prior-task information via model inversion, so the absolute claim is still an overstatement. One-word fix.
- [open, minor] Problem Formulation and Evaluation Rigor: The attributed comparative claims (PODNet, BiC, WA) are now honest but still carry no concrete numbers (dataset, step count, accuracy delta). The "forgetting measure" introduced by RWalk (line 38) is named but not defined with a formula or cross-linked to a metrics file. Capacity saturation (lines 34, 82) remains asserted and grounded only to a citation, not quantified. These keep Evaluation Rigor at 3 but are non-blocking; flagged for a human with access to the primary papers.
- [open, minor] Citation Integrity: The SI-vs-EWC comparability claim (line 34) is still attributed to the SI proposing paper [@zenke2017continual] rather than an independent benchmark. Minor; does not break integrity.

## Verdict rationale
The taxonomy gate now passes, all 17 citekeys resolve, and no body em-dashes remain (only the two YAML frontmatter delimiters). The two major issues from the original review (MECE/taxonomy break and currency framing) are resolved, and the comparative-claim softening is honest. Remaining items are minor and non-blocking, so the verdict moves from REVISE to ACCEPT.

## Remaining issues after repair
- Line 58: "fully privacy-preserving" still present despite changelog claiming it was softened; reduce to "requires no stored raw exemplars."
- Comparative claims (PODNet, BiC, WA) lack concrete numbers; forgetting measure undefined; capacity saturation unquantified. Left for a human with primary-source access.
- SI-vs-EWC comparability still self-cited to the SI paper.
- Currency: recent (2023 to 2025) regularization-adjacent work is scoped out rather than cited; revisit if bibliography entries exist.
