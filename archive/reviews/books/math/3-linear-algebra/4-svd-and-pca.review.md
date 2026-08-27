# Review: books/math/3-linear-algebra/4-svd-and-pca.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 5

## Re-review scores
Correctness and Grounding: 4 (gate passed), Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Findings
- [resolved][blocker] Notation Consistency and Component Discipline: All 11 prose double-hyphens are gone. A grep for double-hyphen, en dash, and em dash returns only frontmatter fences and Markdown table separators. Proper names now use single hyphens (Eckart-Young-Mirsky, Eckart-Young, Moore-Penrose), ranges are spelled ("4 to 64", "5 to 10"), and the former dash punctuation became a colon and comma clauses. Blocker cleared.
- [resolved][major] Correctness and Grounding: The noise-reduction table cell no longer claims optimality and no longer carries the incorrect Donoho-Johnstone wavelet universal soft-threshold formula. It now reads "Threshold tuned to the noise level (e.g. via singular-value hard thresholding)". This is a non-fabricated description and removes the false claim. Acceptable resolution given that gavish2014optimal is absent from references.yaml.
- [verified] Citekeys @hu2022lora (references.yaml line 3722) and @halko2011finding (line 2441) both exist. No broken citekeys.
- [verified] Core math is correct: SVD theorem, eigendecomposition connection, Eckart-Young-Mirsky (Frobenius and spectral), PCA-via-SVD with covariance eigendecomposition, EVR, pseudoinverse, and the randomized SVD algorithm.
- [minor][open] Worked Examples: The "PCA computation step by step" example (ex-pca-computation) is still symbolic. No fully numeric worked pass exists. Non-blocking; would strengthen the section.
- [minor][open] Cognitive Load and Scaffolding: The eigendecomposition prerequisite is referenced in prose but not hyperlinked to the sibling section 3-eigendecomposition.md. A cross-link would make the dependency navigable. Non-blocking.
- [minor][open] Correctness and Grounding: The compact/truncated U_k and V_k have orthonormal columns but are not square-orthogonal; the notation table already says "orthonormal columns", so no error exists. A one-line clarifying note near tab-svd-forms would help readers. Non-blocking.

## Decision
The original REJECT was driven by the notation blocker (double-hyphens) and the major correctness issue (false optimal-threshold formula). Both are resolved. The correctness gate now passes. The three remaining items are all minor and non-blocking. Verdict upgraded to ACCEPT.

## Remaining issues after repair
- [minor] ex-pca-computation lacks a concrete numeric walk-through (still symbolic).
- [minor] Eigendecomposition prerequisite not hyperlinked to 3-eigendecomposition.md.
- [minor] Optional one-line note that compact/truncated U,V have orthonormal columns but are not square-orthogonal.
- [optional] A human may add gavish2014optimal to references.yaml and restore the precise Gavish-Donoho optimal hard threshold with citation.
