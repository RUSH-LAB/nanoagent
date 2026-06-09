# Review: books/survey/ch1-continual-learning/open-problems.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 5, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Synthesis over Summary: The diffusion-vs-GAN claim is now framed as an explicit open question (line 37: "raises an open question: their iterative denoising process may prove more amenable to continual training than GANs, and whether the denoising objective is in fact more stable and less prone to mode collapse in the continual setting remains to be established empirically"). No longer an unsupported asserted property.
- [resolved] Problem Formulation & Eval Rigor: The DP/forgetting tradeoff is now stated as a conjecture (line 41: "a conjectured tension is that the noise required for privacy may exacerbate forgetting (a tradeoff that, to our knowledge, has yet to be rigorously characterized)"). Appropriately hedged.
- [resolved] Synthesis over Summary: The generative-model memorization risk is now qualified (line 41: "generative models are known to memorize and can leak training examples (a concern that would need empirical study in the continual setting)"). Stated as a known concern rather than a bare assertion.
- [resolved] Balance & Currency: All 11 prose "--" occurrences removed; only the two frontmatter delimiters remain. Confirmed via search.
- [minor, open] Citation Integrity: Line 10 still frames @javed2019meta (OML) as evaluating "50-200 tasks" when the source uses sequential Omniglot classes in a class-incremental setting. The wording still slightly overstates the task-sequence scope of the single cited source. Non-blocking.
- [minor, open] Synthesis over Summary: Line 10 "Most methods are evaluated on 5-20 tasks" remains uncited. It is a load-bearing setup claim that would benefit from a benchmark/survey anchor. Non-blocking.

## Decision rationale
All three major content findings were resolved by softening the asserted claims into explicitly speculative/conjectured framing, which is the correct repair given no verifiable primary source was available. House-style "--" violations are fully cleared. The two remaining items are minor citation-precision issues that do not undermine correctness or the section's value. The chapter is publishable as is.

## Remaining issues after repair
- [minor] Line 10: "5-20 tasks" coverage claim is uncited; anchor to a benchmark or survey if convenient.
- [minor] Line 10: "50-200 tasks [@javed2019meta]" slightly overstates the scope of the single cited source (OML uses long class sequences, not distinct tasks); rephrase to "long class sequences" or add a second citation.
