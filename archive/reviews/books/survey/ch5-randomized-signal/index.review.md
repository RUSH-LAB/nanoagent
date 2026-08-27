# Review: books/survey/ch5-randomized-signal/index.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 4

## Re-review scores (Rubric C, survey)
Scope & Coverage Completeness: 4, Taxonomy Quality (gate): 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings (re-review)
- [resolved][blocker] Citation Integrity: The learned-Bloom-filter sentence in bloom-filters.md now reads "Kraska et al. (2018) [@kraska2018case] proposed replacing traditional Bloom filters with learned models". The fabricated "Kriss et al." author and the mis-attributed kriss2018adaptive citekey are gone from the prose.
- [resolved][blocker] Citation Integrity: The references.yaml entry for kriss2018adaptive ("Adaptive Cuckoo Filters") now lists the correct authors Mitzenmacher, Pontarelli, Reviriego (arXiv:1704.06818). The fabricated "Michael Kriss" author field is corrected. The key is no longer cited from chapter prose.
- [resolved][major] Citation Integrity: The duplicate AFNO citekey guibas2022adaptive has been deleted; fourier-spectral.md and taxonomy.md both now cite the single surviving key guibas2022afno. No content references the deleted key.
- [resolved][major] Citation Integrity: The duplicate Stochastic Depth citekey huang2016stochastic_depth has been deleted; randomized-regularization.md and taxonomy.md both now cite the single surviving key huang2016deep. No content references the deleted key.
- [resolved][major] Balance & Currency: The chapter contains zero prose double-hyphen tokens. A scan of all 17 content files shows double-hyphens only in YAML frontmatter fences (two per file) and one Markdown table separator row in benchmarks.md (line 29), all of which are required structural syntax. The original "133" count was these structural delimiters, not prose. Em-dash and en-dash character counts are 0.
- [resolved][major] Taxonomy Quality (gate): taxonomy.md is restructured around one consistent top-level principle (what the randomness or transform acts on), split into two clearly labeled super-axes: "Level one: algorithmic technique families" (1 through 5, plus 9) and "Level two: analytical lens families" (6 through 8). The prior overlaps are now stated as explicit hybrids (random Fourier features named as a projection/Fourier hybrid; family 9 flagged as a technique family deferred because it reuses the family-1 primitive). The gate is satisfied.
- [resolved][minor] Synthesis over Summary: The unsourced DALL-E systems anecdote no longer appears in sketching-streaming.md.
- [resolved][minor] Problem Formulation & Eval Rigor: benchmarks.md now cites ANN-Benchmarks with a resolving citekey [@aumuller2020annbenchmarks], which is present in references.yaml. The benchmark table also carries an explicit non-cross-comparability caveat.
- [open][minor] Scope & Coverage Completeness: introduction.md still lacks an explicit out-of-scope statement naming exclusions (for example randomized smoothing for certified robustness, random forests, MCMC). The introduction describes what is covered and organizes it into three themes, but never states the boundary. This is a non-blocking polish item.

## Verification performed
- Confirmed kriss2018adaptive resolves to the corrected author list and is uncited in prose; confirmed kraska2018case is the load-bearing key for both learned Bloom filters and learned indices.
- Confirmed references.yaml no longer defines guibas2022adaptive or huang2016stochastic_depth, and no chapter file references either deleted key.
- Cross-checked all 128 citekeys used across the chapter against references.yaml: every key resolves (the only non-resolving token is "recall@k" metric notation, not a citekey). Broken citekeys: none.
- Counted double-hyphen tokens per content file: every file shows only the two frontmatter fences except benchmarks.md, which adds one table separator row. No prose violations.

## Summary
All three citation-integrity defects (two blockers, one effectively load-bearing) are fixed, the taxonomy gate is now passed with a single consistent spine and explicit hybrids, the house dash rule is satisfied (zero prose violations), and the two remaining minor content gaps from the original review are closed. One minor, non-blocking polish item remains (an explicit out-of-scope statement in the introduction). The chapter is publishable; verdict moves from REJECT to ACCEPT.

## Remaining issues after repair
- [minor] Add a one-paragraph out-of-scope statement to introduction.md naming what the chapter excludes (for example randomized smoothing, random forests, MCMC). Non-blocking.
