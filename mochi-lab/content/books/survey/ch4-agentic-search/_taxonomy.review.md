# Review: books/survey/ch4-agentic-search/taxonomy.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 5
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 3, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 4

## Verification of repairs
- [resolved] Citation Integrity: The flagship "16,000+ real-world APIs" claim on line 10 now cites `qin2023toolllm`. A new bibliography entry exists at references.yaml line 384 resolving to "ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs" (arXiv 2307.16789, Qin et al. 2023). The mis-resolving `qin2023tool` survey is no longer used in this file. All 44 substantive citekeys resolve against references.yaml.
- [resolved] Taxonomy Quality (gate): Line 8 now states the top level mixes a capability axis (categories 1, 2, 3, 5) with a domain axis (categories 4, 6), with category 7 spanning both, and adds a one-line justification (domain families carry distinctive benchmarks). Gate passes.
- [resolved] Taxonomy Quality: WebGPT is no longer double-listed as a flagship of both category 1 and category 4. Line 16 now homes it under category 1 and marks it as an explicit boundary/hybrid case at the point of listing.
- [resolved] Synthesis over Summary: Category 7 (line 22) now names STORM as the single cited published representative, moves the uncited commercial systems into a labeled "productized systems" aside, and ends with a comparative search-budget takeaway (one or two queries vs. dozens to hundreds).
- [resolved] Citation Integrity: The "one or two search rounds" claim (line 10) is now framed as a design-intent characterization rather than a hard empirical round count, mitigating the over-generalization across ReAct and WebGPT.
- [partial] Balance and Currency: Per-family limitation sentences were not added uniformly. Several families still present advantages without an explicit paired limitation. This was a minor finding and does not block acceptance, but the comparison remains somewhat one-sided.
- [open, minor] Synthesis over Summary: The "~50%" MATH baseline on line 18 is still unspecified (generator pass@1 vs. majority vote at equal budget), so the ~50% to ~78% before/after is not yet fully apples-to-apples.

## Em-dash check
Body em-dashes removed; zero literal em-dash characters remain in the file. The only "---" are the two required frontmatter delimiters. The hyphen ranges "~75-90%" and "~15-30%" (line 16) are legitimate numeric ranges, not em-dashes.

## Remaining issues after repair
- [minor] Add one limitation sentence per category for even-handed comparison (Balance and Currency).
- [minor] Name the ~50% MATH baseline regime on line 18 (Synthesis over Summary).
