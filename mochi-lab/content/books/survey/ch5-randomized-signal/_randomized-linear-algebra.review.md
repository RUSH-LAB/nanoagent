# Review: books/survey/ch5-randomized-signal/randomized-linear-algebra.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 3
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 2

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Citation Integrity: The Halko et al. (2011) Theorem 10.6 bound on line 12 is now correct: E||A - Q Q^T A|| <= (1 + 4*sqrt(k+p)/(p-1) * sqrt(min(m,n))) * sigma_{k+1}. Constant is 4 (not 11), the /(p-1) denominator is restored, and it is stated as a factor times the optimal rank-k spectral error sigma_{k+1}. The bound now correctly tightens as p grows, consistent with the "oversampling provides robustness" claim.
- [resolved] Problem Formulation and Evaluation Rigor: The complexity inconsistency is fixed (line 12). The dense Gaussian Omega variant is stated as O(mnk), dominated by the A*Omega product, while O(mn log k) is attributed specifically to a structured/SRFT sketch. The intro (line 8) is now consistent with this.
- [resolved] Scope and Coverage Completeness: "exponential" savings replaced with "order-of-magnitude" plus concrete O() comparisons (line 8).
- [resolved] Synthesis over Summary: A new "Choosing Among the Methods" subsection (lines 44 to 46) supplies a genuine comparative synthesis across randomized SVD, CUR, and Nystrom along accuracy, interpretability, and kernel-specificity, with complexities and when-to-use guidance. The chapter no longer ends as an annotated bibliography.
- [resolved] Problem Formulation and Evaluation Rigor: Nystrom cost expanded to O(nk^2 + k^3) with the O(nk) kernel-evaluation term broken out, and the uniform-vs-leverage-score sampling-quality tension named as the central tradeoff (line 23).
- [resolved] Taxonomy Quality / house style: All three " -- " em-dash substitutes removed. Verified only the YAML frontmatter delimiters remain.
- [minor, open] Synthesis over Summary: LoRA "conceptually related" and "can provide a warm start" (line 16) remain vague and uncited. LoRA updates are learned low-rank deltas, not an SVD of W; SVD-based init is a specific technique (PiSSA/OLoRA style). Non-blocking, but a concrete citation or softer phrasing would strengthen it.
- [minor, open] Balance and Currency: The scikit-learn TruncatedSVD and "Facebook PCA for billion-scale embeddings" parentheticals (line 14) are still unsourced. scikit-learn offers a randomized solver as one option, not the only one. Non-blocking, but should be cited or qualified.

## Citekey verification
All nine citekeys resolve against references.yaml: martinsson2020randomized, woodruff2014sketching, halko2011finding, williams2001nystrom, xiong2021nystromformer, candes2009exact, recht2011simpler, mahoney2009cur, clarkson2017low.

## Decision rationale
Both blockers and all three majors from the original review are resolved. The two technical-correctness blockers (the Halko bound and the complexity claim) are now verified correct, and the synthesis gate is satisfied by the new comparative subsection. Citation integrity is clean. The two remaining items are minor, non-blocking polish concerns. Verdict: ACCEPT.

## Remaining issues after repair
- LoRA "conceptually related" / "warm start" sentence (line 16) is uncited and vaguely worded; soften or cite a concrete SVD-init method.
- scikit-learn and Facebook PCA parentheticals (line 14) are unsourced; cite or qualify.
