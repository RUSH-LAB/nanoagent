# Review: books/survey/ch4-agentic-search/connections.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Balance and Currency: All 9 literal "--" em-dash substitutes are gone. Only the two frontmatter delimiters on lines 1 and 4 use "--", which is correct. No Unicode em-dashes present either. Repo CLAUDE.md and Rubric C convention now satisfied.
- [resolved] Citation Integrity: Every previously unsourced named system now carries a citekey that resolves in mochi-lab/references.yaml. Verified all 21 keys: schrittwieser2020mastering, yao2023tree, hao2023reasoning, zhou2024lats, khattab2020colbert, wang2024e5, li2023gte, xiao2024bge, zheng2024sglang, meng2022locating, meng2023mass, asai2024selfrag, shinn2023reflexion, voyager2023, delange2021continual, indyk1998approximate, malkov2020hnsw, johnson2021faiss, bloom1970space, cormode2005improved, johnson1984extensions. MuZero, E5, GTE, BGE, RadixAttention/SGLang, LSH, Bloom filters, Count-Min sketches, and JL lemma are all now cited.
- [resolved] Synthesis over Summary: Each of the four chapter-connection blocks now ends with a one-line *Takeaway:* stating a comparative claim rather than an implicit list of analogies (lines 15, 25, 34, 43). The 100x fan-out number is grounded in the existing "100 queries" example. This lifts the section from pure analogy toward a synthesized argument.
- [resolved] Scope and Coverage Completeness: Confirmed the book index (content/books/survey) contains exactly ch1-ch5 plus intro. The file is ch4 and connects to Chapters 1, 2, 3, 5, which is the complete set of siblings. No chapter 6+ exists, so the out-of-scope-boundary concern is moot; chapter numbers referenced all match the actual index.
- [minor, open] Citation Integrity / telephone game: line 29 still attributes the retrieval framing alongside [@delange2021continual], whose cited survey covers class-incremental classification, not retrieval. The "essentially a class-incremental learning problem applied to retrieval" framing is the author's analogy. Wording is borderline; ideally flag it explicitly as an analogy ("this resembles a class-incremental learning problem"). Minor, non-blocking.
- [minor, open] Problem Formulation and Evaluation Rigor: line 41 still reads "guaranteeing that pairwise distances (and thus retrieval quality) are approximately preserved." The JL lemma [@johnson1984extensions] preserves pairwise Euclidean distances; the parenthetical "(and thus retrieval quality)" overclaims for learned or non-Euclidean metrics. The lemma is now cited, which mitigates the rigor concern, but the causal leap to retrieval quality should still be softened. Minor, non-blocking.

## Verdict rationale
The two major findings that justified REVISE (em-dash convention violations and unsourced load-bearing named systems) are both fully resolved, and the synthesis weakness is materially improved with per-block takeaways and a grounded number. The two items still open are minor qualification issues that do not undermine correctness or coverage. Taxonomy Quality gate passes: the four-way organization by sibling chapter is coherent and non-overlapping. Promoting to ACCEPT.

## Remaining issues after repair
- [minor] Line 29: soften or explicitly label the class-incremental-learning-to-retrieval framing as the author's analogy rather than the cited source's claim.
- [minor] Line 41: qualify "(and thus retrieval quality)" since JL distance preservation does not directly guarantee retrieval-quality preservation under learned or non-Euclidean metrics.
- [optional] Synthesis could be strengthened further with verified ColBERT-vs-cross-encoder latency and HNSW recall/QPS figures, which require a human with access to the underlying papers (cannot be derived from the file without fabrication).
