# Review: books/survey/ch5-randomized-signal/problem-formulation.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4 (gate passed), Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved][major] The prior universal-approximation error is fixed. Line 30 now reads "random Fourier features approximate shift-invariant kernels via Bochner's theorem, and the resulting kernel machines are universal approximators [@rahimi2007random]." The incorrect Johnson-Lindenstrauss attribution is gone and the correct random-features framing with a valid citation is in place.
- [resolved][major] The multiplicative-vs-additive conflation is fixed. Line 10 now explicitly defines a "multiplicative (1 + epsilon)-approximation" with the two-sided clarification, and line 12 phrases the running example consistently as "within a factor of 1.01 of optimal" rather than the prior "1% error / 99%-accurate" language.
- [resolved][minor] "making the approximation essentially lossless in practice" (line 12) is now qualified by the preceding clause: "the approximation error of randomized algorithms is smaller than the inherent noise in the data." The claim is conditioned on its regime rather than stated as a universal law.
- [minor][open] Problem Formulation and Eval Rigor: line 18 still states the Chernoff-Hoeffding bound as "decays exponentially as exp(-2 n epsilon^2)" without the [0,1] normalization or the general (b-a)^2 denominator. The form is correct for the sample mean of variables bounded in [0,1] but is presented as if general. Add "(for variables bounded in [0,1])" or write the (b-a)^2 denominator. Non-blocking.
- [minor][open] Synthesis over Summary: the tradeoff bullets (lines 37, 39) still assert quantitative or directional outcomes ("100x more data", longer sequences "can improve task performance more than the attention approximation hurts it") without a primary source or a stated regime. Naming the conditions under which the tradeoff holds, or softening to qualitative claims, would strengthen the synthesis. Non-blocking.

## Verification
- All 8 citekeys verified present in references.yaml: mitzenmacher2017probability (1864), vershynin2018high (1874), motwani1995randomized (1944), pennington2017nonlinear (1954), louart2018random (1964), bottou2008tradeoffs (1975), rahimi2007random (2005), tropp2015introduction (5971).
- No em-dashes or "--" in prose. Only the two YAML frontmatter delimiters (lines 1 and 4) contain "--", which is correct and preserved.

## Verdict rationale
Both original major issues (the JL universal-approximation error and the multiplicative-vs-additive conflation) are correctly resolved, citations are clean, and the "--" cleanup is complete. The two remaining items are minor, non-blocking polish points (one special-case Hoeffding form stated as general, one set of ungrounded tradeoff figures). Verdict moves from REVISE to ACCEPT.

## Remaining issues after repair
- [minor] Line 18 Hoeffding bound exp(-2 n epsilon^2) should note the [0,1] bound or use the (b-a)^2 denominator.
- [minor] Lines 37 and 39 quantitative/directional tradeoff claims ("100x more data", longer-sequence performance) lack a primary source or stated regime.
