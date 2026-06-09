# Review: books/survey/ch3-efficient-architecture/benchmarks.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 3, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4 (gate passes), Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Verification of prior repairs
- Em-dashes: confirmed removed. A scan for "--" returns only the frontmatter delimiters (lines 1 and 4). The "context length increases, a critical metric" (line 18) now uses a comma, and the Pareto "frontiers (the set of architectures...)" (line 36) now uses a parenthetical. Both clean.
- MLPerf apportionment: confirmed. Line 12 now reads "successive submissions on the same benchmarks reflecting a combination of hardware improvements, software optimization..., and algorithmic innovations." The precise "2-4x" figure and the "roughly equally" cause-attribution are gone. The unsourced load-bearing quantitative claim is resolved.
- H100 throughput: confirmed. Line 43 now reads "As an order-of-magnitude estimate, a single H100 GPU can serve on the order of thousands of tokens/second for a 7B parameter model, with the exact figure depending heavily on precision, batch size, and sequence length." Requalified appropriately; no spurious precision.
- Chatbot Arena citation: confirmed. Line 20 carries [@zheng2023judging], which resolves in references.yaml (line 598).
- MTEB citation: confirmed. Line 22 carries [@muennighoff2023mteb], which resolves in references.yaml (line 5920).

## Citekey integrity
All 9 citekeys used in the file resolve in mochi-lab/references.yaml: mattson2020mlperf, liang2023holistic, tay2021long, hsieh2024ruler, zheng2023judging, muennighoff2023mteb, hoffmann2022training, shazeer2019fast, ainslie2023gqa. No broken citekeys.

## Remaining issues after repair
- [minor] Citation Integrity: line 30 still states "FlashAttention has the same O(n^2) theoretical complexity as standard attention but is 2-4x faster due to IO-aware design" with no citekey. The citekey dao2022flashattention exists in references.yaml (line 2627) and should be appended so the load-bearing speedup figure traces to its source. Non-blocking.
- [minor] Synthesis over Summary: line 16 still asserts "S4 and Mamba achieved breakthrough results on LRA, particularly on PathX (length 16K), where standard Transformers achieve random chance" without numbers. This holds Synthesis at 3. A small LRA results table (SSM vs Transformer averages, PathX accuracy) would lift this, but requires figures the reviewer cannot supply without fabricating them. Correctly left for a human.

## Verdict rationale
Both major issues flagged in the original review (unsourced MLPerf "2-4x / roughly equally" apportionment and the unsourced H100 throughput figure) are resolved, both missing benchmark citations (Chatbot Arena, MTEB) are added and verified, and both prose em-dashes are removed. The taxonomy gate passes. The two remaining items are minor and non-blocking: one is a one-token citekey addition, the other a results table that needs human-sourced numbers. The chapter is publishable as is. Verdict: ACCEPT.
