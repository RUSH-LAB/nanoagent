# Review: books/survey/ch5-randomized-signal/probabilistic-data-structures.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (re-review)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 4

## Resolved since prior review
- [major] Citation Integrity: The contradictory and fabricated consistent-hashing formula ("reducing variance in partition sizes from O(n/k) to O(n/k * log k)") is gone. Line 25 now describes the real mechanism: assigning roughly O(log k) virtual nodes per physical worker concentrates each worker's share near the 1/k mean, with the standard random-placement max-load imbalance on the order of O(log N / log log N). Correct and no longer self-contradictory.
- [major] Synthesis over Summary: Each subsection now closes with a comparative tradeoff takeaway. HyperLogLog: accuracy versus memory (line 10). Reservoir sampling: uniformity versus O(1) per-element cost (line 21). Consistent hashing: load balance versus routing-table and rebalancing overhead (line 25). The section now synthesizes rather than only annotating.
- [minor] House Style: Both prose double-hyphens removed. The HLL leading-zeros aside now uses parentheses (line 10) and the reservoir-sampling sentence is split at a colon (line 21). Only the two YAML frontmatter delimiters remain, as required.
- All 8 citekeys (flajolet2007hyperloglog, broder1997resemblance, lee2022deduplicating, mitzenmacher2017probability, vitter1985random, chaudhry2019tiny, efraimidis2006weighted, karger1997consistent) resolve in references.yaml.

## Remaining issues after repair
- [minor] Problem Formulation and Evaluation Rigor: Line 10 still says "2^14 registers (16 KB of memory)". 16,384 registers at 5 to 6 bits each occupy about 12 KB (Redis HyperLogLog uses 12 KB / 12,288 bytes), not 16 KB. The flagged correction to ~12 KB (or stating the per-register bit width that yields 16 KB) was not applied. The ~0.8% figure is correct.
- [minor] Problem Formulation and Evaluation Rigor: Line 10 still says "O(log log n) space per counter". This conflates per-register size with total structure size; the flagged rephrase to "each register uses O(log log n) bits" was not applied.
- [minor] Balance and Currency: No explicit per-family limitation is stated (e.g., HLL error is relative not absolute and degrades at low cardinality; reservoir sampling assumes i.i.d. relevance; consistent hashing needs many virtual nodes for good balance). The new tradeoff sentences partially cover this but do not state failure modes. Optional improvement.

## Verdict rationale
Both major issues (the fabricated/contradictory consistent-hashing formula and the lack of synthesis) are fully resolved, and the house-style violation is fixed. The three remaining items are minor accuracy and balance polish points that do not undermine the section's correctness or usefulness. Accepting, with the two unfixed numeric/notation nits noted for an optional follow-up pass.
