# Review: posts/blog/wikipedia-category-graph.md

- Content type: research-post
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Novelty of Insight: 3, Correctness and Soundness: 2, Evidence and Grounding: 2, Clarity and Structure: 3, Significance (So-What): 3, Honesty and Limitations: 3

## Re-review scores
Novelty of Insight: 3, Correctness and Soundness: 3, Evidence and Grounding: 3, Clarity and Structure: 4, Significance (So-What): 3, Honesty and Limitations: 3

## Verification of prior repairs
- [fixed] Correctness and Soundness: The stale CaLiGraph scale claim is corrected and now consistent in both locations. Line 133 reads "Output (v3.0): ~1.3M classes, ~15M entities, tens of millions of relation assertions" and line 208 reads "roughly 1.3M classes (1,285,189), ~15M entities (14,727,963), and tens of millions of relation assertions (~37M)", both attributed to caligraph.org/statistics.html. The earlier understated "1M classes / 7M entities / hundreds of millions of assertions" figure is gone. This resolves the gating correctness defect.
- [fixed] Correctness and Soundness: The Cat2Ax "members not names" contradiction is reconciled across all three locations. Line 49 now reads "mine patterns in category names and validate them with statistics over category members"; line 117 reads "do not rely on category names alone; mine linguistic patterns in the names and then validate and weight them with statistics over category members"; line 203 reads "mines linguistic patterns over category names and then validates and weights them using statistics over the entities each category contains". The three sections are now mutually consistent and accurately describe the ISWC 2019 method.
- [fixed] Clarity and Structure: All prose em-dashes removed (0 remaining). The only "--" sequences left are structural Markdown (frontmatter delimiters, horizontal rules, the truncate HTML comment, and table header separators), which are load-bearing and correctly preserved. House style satisfied.

## Remaining findings
- [minor] Evidence and Grounding: Line 245 still asserts "hyperbolic embeddings can answer `is-a` queries at ~95% precision" with no citation. This is a load-bearing quantitative claim stated as fact. Nickel and Kiela (NeurIPS 2017) report reconstruction and link-prediction metrics, not a 95% is-a precision figure on the Wikipedia category DAG specifically. Cite a source or soften to a qualitative statement before publishing.
- [minor] Evidence and Grounding: The YAGO 4.5 publication date is still given as "(2023)" (line 48), "2007 -> 2023" (line 115), and "in 2023" (line 193). The resource paper appeared at SIGIR 2024 (arXiv preprint Aug 2023). State both (e.g. "arXiv 2023, SIGIR 2024") or use the venue year for consistency with the other reading-list entries.
- [minor] Clarity and Structure: Line 115 says YAGO 4.5 is "small (~10K cleaned classes)" while line 193 says it "ships ~50M entities". Both numbers are individually correct (cleaned upper taxonomy vs entity count), but they read as contradictory without a label. Mark the ~10K figure as the cleaned/top-level class taxonomy to remove the apparent conflict.
- [nit] Honesty and Limitations: The GitHub star counts and last-push dates (line 62 onward) are a 2026-05-21 snapshot and will drift. Acceptable as written; an explicit "snapshot" note would improve currency hygiene.

## Changes made
None in this re-review pass. The prior repair pass had already removed all prose em-dashes and fixed both major correctness findings; verification confirms those edits are in place and correct.

## Left for human
- Pin the exact paper-reported CaLiGraph figures vs the live caligraph.org statistics if the published SWJ 2025 snapshot differs from the current site numbers (1,285,189 classes; 14,727,963 entities; 37,002,047 relations). The live-site figures are sound for a blog post.
- Confirm whether the ~37M "relations" figure is the intended metric (relation assertions) vs total RDF triples, and adjust wording if a different count was meant.

## Remaining issues after repair
- Line 245 "~95% precision" is-a claim is uncited and should be sourced or softened.
- YAGO 4.5 dated as 2023 throughout; reconcile with SIGIR 2024 publication.
- Line 115 "~10K cleaned classes" should be labeled as the cleaned upper taxonomy to avoid apparent conflict with the "~50M entities" figure on line 193.

The two gating correctness defects are resolved, so the post is no longer at risk of REJECT. It stays at REVISE because one load-bearing quantitative claim (the ~95% is-a precision) is still presented as fact without a citation, and two smaller grounding/labeling items remain. These are quick fixes; once the ~95% claim is cited or softened, the post is ready to ACCEPT.
