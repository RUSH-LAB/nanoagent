# Review: books/survey/ch5-randomized-signal/taxonomy.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 5, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Taxonomy Quality (gate): The vague intro is replaced by an explicit single top-level spine ("what the randomness or transform acts on") split into two labeled levels: "Level one: algorithmic technique families" (1 to 5), "Level two: analytical lens families" (6 to 8), plus a separate "Returning to technique: randomized linear algebra" header for family 9 with a note explaining its placement after family 1's primitive. The spine now carves the field by one consistent principle.
- [resolved] Taxonomy Quality (gate): The random Fourier features MECE violation is fixed. RFF now has a single primary home in family 1, and family 6 cross-references it as a hybrid (construction is a random projection, understood through the Fourier lens) rather than re-listing it as its own flagship entry.
- [resolved] Synthesis over Summary: Each of the nine families now ends with a bolded "Tradeoff:" sentence stating a named tradeoff (projection dimension vs accuracy, noise vs convergence, hash bits vs recall, sketch size vs estimation error, capacity vs false-positive rate, retained modes vs expressiveness, time vs frequency resolution, linear cost vs fidelity, oversampling vs factorization accuracy). A closing comparative paragraph synthesizes the shared resource-vs-error axis and frames method choice by scarcest resource.
- [resolved] Balance and Currency: The literal "--" in the wavelet family is gone, restructured into a comma clause. Only frontmatter delimiters remain in the file.
- [open, minor] Problem Formulation and Evaluation Rigor: Family 9 still says randomized linear algebra runs "in time proportional to the matrix size (rather than the matrix rank cubed)". The complexity claim remains imprecise: classical deterministic SVD of an m-by-n matrix costs O(mn min(m,n)), not "the matrix rank cubed", and randomized SVD costs roughly O(mn k) for target rank k. Non-blocking but worth tightening to mn k versus full O(mn min(m,n)), or citing halko2011finding's bound.
- [open, minor] Citation Integrity: bloom-filters.md still ships as a deep-dive file separate from probabilistic-data-structures.md, so Bloom filters as one item inside the family-5 axis maps to its own file. The revised prose no longer overclaims a "nine files" count (it says nine families), so the mismatch is now cosmetic at the taxonomy level. Non-blocking; optionally fold bloom-filters into the family-5 deep-dive or note it as a sub-file.

## Disposition
All three major findings and the em-dash house-style violation from the prior round are fully resolved. The taxonomy now passes the Taxonomy Quality gate: one explicit organizing principle, two clearly labeled levels, each family stating principle, flagship methods, and a named tradeoff, and a closing comparative-analysis paragraph. Two minor items remain (an imprecise complexity phrasing and a cosmetic file-vs-axis mismatch for Bloom filters), neither blocking. Verdict raised from REVISE to ACCEPT.

## Remaining issues after repair
- Minor: imprecise complexity claim in family 9 ("matrix rank cubed").
- Minor: bloom-filters.md exists as a standalone deep-dive file mapping to one item inside the family-5 axis.
