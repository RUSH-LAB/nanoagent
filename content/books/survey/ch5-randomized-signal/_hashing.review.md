# Review: books/survey/ch5-randomized-signal/hashing.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification performed
- Read the full revised file independently.
- Confirmed all 12 citekeys resolve in mochi-lab/references.yaml (indyk1998approximate, charikar2002similarity, andoni2006near, andoni2015optimal, malkov2020hnsw, johnson2021faiss, chen2020slide, chen2022gslide, wang2018survey, cao2017hashnet, liu2016deep, andoni2015practical).
- Confirmed zero em-dashes and zero double-hyphens outside the two frontmatter delimiter lines.

## Resolution of original findings
- [RESOLVED] Synthesis (10-100x speedup): the blanket "10-100x speedups with minimal accuracy loss" claim is gone. Line 24 now gives a regime-dependent qualification (speedup grows with database size, shrinks with code length and recall@k) and states the trade-off should be reported at a specific bit length and recall@k on a named dataset. No fabricated numbers.
- [RESOLVED] Balance (SLIDE): line 20 now scopes the CPU>GPU result to extreme-classification/large-output layers, adds the main-memory footprint and cache-thrashing limitations, and softens the promotional framing. Family now treated even-handedly.
- [RESOLVED] Synthesis (HNSW vs LSH): line 16 now states concretely that graph methods dominate LSH across most high-recall operating points on ann-benchmarks and names the regime where LSH still wins (theoretical guarantees, streaming/insertion, lower build cost and memory).

## Remaining open issues (all minor, non-blocking)
- [minor] Citation Integrity: the chen2020slide entry in references.yaml (lines 2090-2098) still lists the wrong co-authors (Tri Dao, Eric Winsor, Zhao Song, Atri Rudra). The actual SLIDE authors are Chen, Medini, Farwell, Gobriel, Tai, Shrivastava. The citekey, lead author, and title trace correctly, but the co-author list should be corrected in the bibliography. This is a references.yaml fix outside the reviewed file.
- [minor] Grounding: the new HNSW vs LSH sentence references "the ann-benchmarks suite" by name without a citekey, since none exists in the file. A human should add an ann-benchmarks citation (e.g. Aumuller et al.) for full grounding.
- [minor] Problem Formulation: the SLIDE wall-clock claim still lacks a concrete time-vs-accuracy datapoint (e.g. the V100 head-to-head on Amazon-670K / Delicious-200K). Optional grounding improvement.
- [minor] Synthesis: the cross-polytope subsection (line 28) still asserts "more practically efficient than hyperplane LSH" without a grounded number (the source reports up to 10x faster for 1e5-1e8 points) and ends on a tool description. Optional close-out improvement.
- [minor] Balance: the learning-to-hash subsection still does not state limitations against classical LSH (training/retraining cost, no distribution-shift guarantees, supervision requirement). Optional even-handedness improvement.

## Verdict rationale
The three major issues that drove the original REVISE are all resolved with conservative, source-faithful edits and no fabricated numbers. The remaining items are minor: one is a bibliography co-author error outside this file, the rest are optional grounding and balance refinements that do not undermine correctness. The taxonomy gate is satisfied (four coherent, non-overlapping families). Verdict: ACCEPT.
