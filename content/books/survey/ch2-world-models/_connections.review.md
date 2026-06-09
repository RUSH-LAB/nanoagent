# Review: books/survey/ch2-world-models/connections.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0 (frontmatter delimiters on lines 1 and 4 exempt)
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Revised scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Findings
- [resolved][major] Balance & Currency: All six prose "--" occurrences flagged in the original review are gone. A fresh scan returns only lines 1 and 4, which are the YAML frontmatter delimiters and are exempt per house style. The SSM-dynamics line now reads "so the mathematical frameworks are closely related" (comma restructure), the agentic-search intro uses a colon before "using an internal model", the information-landscape line uses a comma before "understanding", the adapting-dynamics line uses a comma before "exactly", and the Fourier/spectral-bias line is rephrased into a "where..." clause. No correctness regression introduced by the rewrites.
- [resolved][major] Citation Integrity: The hard-coded "(Section 2.8)" cross-reference is replaced with "(see [World Models for Reasoning](./reasoning.md))". Verified reasoning.md exists in the chapter directory and contains the "### LLM-as-World-Model" heading (line 10), so the link now resolves to the correct material instead of a non-existent numbered section.
- [minor] Synthesis over Summary: Several bullets still assert speculative potential ("could enable", "could use", "may affect") without a grounded comparative claim or citation. Acceptable lighter standard for a connections appendix, hence not blocking. Anchoring the load-bearing ones (e.g. an SSM-based sequence-modeling world model) to a concrete result would strengthen the chapter.
- [minor][passed] Citation Integrity: Spot-checked the highest-stakes external claim. The citekeys hafner2019learning, hansen2022temporal, chua2018deep, and rahaman2019spectral all resolve in references.yaml (lines 1455, 1639, 6019, 2255). The PlaNet / TD-MPC / PETS attributions for randomized planning are accurate.
- [minor][passed] Problem Formulation and Eval Rigor: The Johnson-Lindenstrauss lemma statement "O(log n / epsilon^2) dimensions suffice to preserve pairwise distances within (1 +/- epsilon)" is correct and uses the plain-text math convention. The "+/-" rendering matches the chapter's plain-text style. No correctness issue.

## Changes made
None by this reviewer. The prior revision had already removed all six prose "--" occurrences and replaced the hard-coded "(Section 2.8)" with a resolvable link to reasoning.md. This pass independently confirmed those fixes and verified all four citekeys resolve and the cross-reference target exists.

## Left for human
- None

## Remaining issues after repair
- [minor, non-blocking] Speculative "could / may" connection bullets would benefit from a grounding citation or comparative anchor, but this is acceptable for a connections appendix and does not block acceptance.
