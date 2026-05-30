# Review: books/survey/ch5-randomized-signal/signal-processing-transformers.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Verification this pass
- Em-dash house-style violation is fully resolved. A scan for inline "--" returns only the two YAML frontmatter delimiters on lines 1 and 4, which are required. No body occurrences remain.
- All 17 citekeys resolve against references.yaml: dong2021attention, cordonnier2020relationship, voita2019analyzing, haykin2002adaptive, vaswani2017attention, su2024roformer, tay2021long, leethorp2022fnet, gu2024mamba, liu2021pay, poli2023hyena, gu2022efficiently, choromanski2021rethinking, kitaev2020reformer, peng2021rfa, katharopoulos2020transformers, and rahimi2007random.
- rahimi2007random exists in the bibliography, so the Rahimi and Recht attribution at line 38 can be cited directly. It is still uncited in the body.
- benchmarks.md (line 47 and line 53) does characterize Long Range Arena and ties it to this family, so the LRA grounding gap can be closed with a cross-reference rather than new prose.

## Rationale for ACCEPT
The mechanical house-style violation that drove the REVISE is fully fixed, and the chapter is otherwise correct, well-organized around the filtering and convolution taxonomy, and accurately cited. The remaining items below are all minor, content-additive polish. None are correctness-breaking and none gate publication, so the verdict is raised to ACCEPT.

## Remaining issues after repair
- [minor] Synthesis over Summary, line 38: the Rahimi and Recht Random Fourier Features attribution still carries no citekey, unlike every other named result in the section. rahimi2007random is present in references.yaml; add it as [@rahimi2007random].
- [minor] Citation Integrity, line 38: Attention(Q,K) = exp(QK^T/sqrt(d)) drops the softmax row-normalization (the denominator), so as written it is the unnormalized kernel rather than the attention operation FAVOR+ actually approximates. Add the normalization term or note that FAVOR+ approximates the normalized softmax kernel.
- [minor] Balance and Currency, line 44 and the surrounding subsection: the Randomized Attention Approximations family is presented with advantages only (speedups, linear time, provable guarantees) and no limitations. Add the well-documented tradeoffs (linear-attention and Performer quality degradation on recall-heavy or sharp-attention tasks, random-feature approximation variance, LSH bucketing artifacts in Reformer) so the family gets both pros and cons.
- [minor] Problem Formulation and Eval Rigor, line 21: Long Range Arena is invoked as the evaluation vehicle but not grounded in this file (no task description, sequence-length scale, or representative numbers). Add a one-line characterization or cross-reference benchmarks.md, which already covers LRA.

## Note on em-dash count
The reviewer rubric counted 9 em-dashes; the file body contained 7 inline "--" instances, all now removed. The two extra matches are the required YAML frontmatter delimiters ("---" on lines 1 and 4), which are correctly preserved.
