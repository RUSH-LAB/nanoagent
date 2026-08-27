# Review: books/survey/ch5-randomized-signal/benchmarks.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 2, Synthesis over Summary: 2, Citation Integrity: 2, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 2

## Re-review scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 4

## Verification of prior fixes
- [resolved] Citation Integrity blocker (JL numeric): line 12 now states "k >= (8 * ln n) / epsilon^2 requires projecting to roughly 11,000 dimensions", names the constant, and adds the JL-variant caveat. Independent recompute: 8 * ln(10^6) / 0.01 = 11,052. Correct and consistent with the cited lemma.
- [resolved] Problem Formulation blocker (ANN-Benchmarks): line 45 now cites [@aumuller2020annbenchmarks], which resolves in references.yaml. The bibliography entry exists and is well formed.
- [resolved] Synthesis major (benchmark tasks): line 53 adds a comparative closing paragraph mapping each benchmark to a taxonomy family and tradeoff axis, ending with the cross-axis takeaway that no single axis ranks the methods.
- [resolved] Evaluation Rigor major (Quality Retention): line 39 adds an explicit non-comparability note (different metric, dataset, baseline) with two grounded per-row examples and a pointer to the controlled per-task benchmarks.
- [resolved] Taxonomy major (row-to-family mapping): line 26 maps every speedup-table row back to a named chapter taxonomy family.
- [resolved] Citation Integrity minor (double cite): line 47 now carries only [@tay2021long]; the redundant "(Tay et al., 2021)" is gone.

## Findings (remaining)
- [minor] Problem Formulation and Evaluation Rigor: line 22, the Nystrom bound "expected error O(n/k * sum_{i>k} sigma_i)" still does not state the sampling scheme (uniform vs leverage-score). Qualify the assumption or mark it as informal scaling so it is not read as a tight scheme-independent guarantee.
- [minor] Synthesis over Summary: line 20, the randomized SVD bound "||A - A_k||_F <= (1 + epsilon) * ||A - A_k^*||_F" is still written as a deterministic inequality; per [@halko2011finding] it holds in expectation and depends on oversampling and optional power iteration. Add "in expectation" and the spectral-decay caveat.

## Citation integrity check
All 19 citekeys used in the file resolve in references.yaml: johnson1984extensions, larsen2017optimality, rahimi2007random, rahimi2009weighted, indyk1998approximate, andoni2015practical, charikar2004finding, cormode2005improved, halko2011finding, williams2001nystrom, gittens2016revisiting, chen2020slide, leethorp2022fnet, choromanski2021rethinking, xiong2021nystromformer, kitaev2020reformer, ivkin2019communication, aumuller2020annbenchmarks, tay2021long. No unresolved inline author-year strings remain.

## Dash audit
Zero em-dash and zero en-dash characters in the file. A naive grep of overlapping "--" runs returns 23, but ripgrep confirms only three lines contain "--": the YAML frontmatter fences (lines 1 and 4) and the Markdown table separator (line 29). All three are load-bearing syntax and must stay. The reviewer's count of 23 was structural runs, not prose em-dashes. No prose dash violations exist.

## Verdict rationale
Both blockers and all three majors are resolved, and one minor is fixed. The Taxonomy Quality gate is cleared in the limited sense that the page now maps both table rows and benchmarks to named taxonomy families, with the spine owned by sibling problem-formulation files. Two minor theory-statement qualifiers (Nystrom sampling scheme, randomized SVD "in expectation") remain and keep this from a clean ACCEPT. Substance is sound and publishable after these two one-line qualifiers.

## Remaining issues after repair
- line 22: add the Nystrom sampling assumption (uniform vs leverage-score) or mark the bound as informal scaling.
- line 20: add "in expectation" and the spectral-decay/oversampling caveat to the randomized SVD Frobenius bound.
