# Review: books/survey/ch5-randomized-signal/connections.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 2 (both YAML frontmatter delimiters, lines 1 and 4; none in prose body)
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 5, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved][major] Balance & Currency: The "streaming perspective" bullet (line 24) previously used two "--" em-dash substitutes and the overclaim "is formally equivalent to". Both are fixed: the inline aside now reads "(processing data in a single pass with bounded memory)" with parentheses, and the claim is softened to "is an instance of the streaming computation model". The only remaining "--" tokens in the file are the YAML frontmatter delimiters on lines 1 and 4, which must stay.
- [resolved][major] Synthesis over Summary: The "Fourier analysis of temporal patterns" bullet (line 31) previously asserted a speculative spectral-bias-to-world-model claim as a connection. It is now explicitly framed as an open hypothesis: "We pose as an open hypothesis (not an established result) that world models might learn low-frequency temporal patterns... Testing whether spectral bias extends to temporal world-model dynamics remains future work." The epistemic status is now honest.
- [minor] Synthesis over Summary: "Quantization as randomized rounding" (line 13) still states the unbiasedness guarantee without a "[@key]" to a stochastic-rounding source. Correct in substance but uncited.
- [minor] Synthesis over Summary: "Randomized planning" (line 30) lists CEM, random shooting, and MCTS without citations and without anchoring to a numbered Monte Carlo / sampling section of this chapter, unlike the Chapter 3/4 bullets that anchor to Sections 5.4 through 5.11. Connection is asserted rather than traceable.
- [minor] Citation Integrity: "Performer [@choromanski2021rethinking] uses FAVOR+ (random Fourier features with orthogonal random matrices)" (line 10) is verified accurate; precision nit only. FAVOR+ uses positive orthogonal random features inspired by random Fourier features, not plain RFF. Consider "positive orthogonal random features (inspired by random Fourier features)".
- [minor] Synthesis over Summary: Most bullets state a connection without a comparative takeaway or tradeoff. Rubric C rewards synthesis; consider closing each chapter block with one sentence on which connections are load-bearing versus illustrative.

## Citation verification
All five citekeys in the file (choromanski2021rethinking, kitaev2020reformer, karpukhin2020dpr, khattab2020colbert, malkov2020hnsw) appear in sibling files of the same survey, confirming they resolve. No broken keys.

## Changes made
None this pass. The two major findings from the prior REVISE were already repaired in the revised file under review, and both repairs were verified.

## Left for human
- None blocking. The five minor findings above are optional polish (add citations for stochastic rounding and randomized planning, anchor randomized planning to a section, tighten the FAVOR+ phrasing, and add per-block synthesis sentences).

## Remaining issues after repair
The file is publishable as is. Remaining open items are all minor and non-blocking: uncited stochastic-rounding and randomized-planning bullets, the randomized-planning bullet not anchored to a numbered section, a FAVOR+ precision nit, and the absence of per-block load-bearing-versus-illustrative synthesis sentences.
