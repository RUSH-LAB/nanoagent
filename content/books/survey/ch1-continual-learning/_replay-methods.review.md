# Review: books/survey/ch1-continual-learning/replay-methods.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 3
- Broken citekeys: []

## Original scores
Scope & Coverage Completeness: 5, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Evaluation Rigor: 3

## Findings
- [minor] Problem Formulation & Evaluation Rigor: "GEM requires solving a quadratic program at each optimization step (O(t^2) per step for t tasks), which becomes computationally prohibitive for long task sequences." -> The O(t^2) figure is imprecise. GEM solves the dual QP over t-1 variables and requires one backward pass per previous task, so per-step cost is more accurately O(t) gradient evaluations plus a QP over t-1 dual variables. Either cite the source of the O(t^2) claim or restate it as 'cost grows linearly in the number of tasks t (one stored-gradient pass per task) plus a QP over t-1 variables'.
- [minor] Citation Integrity: "In the comprehensive evaluation of Boschini et al. (2022) [@boschini2022class], DER++ achieved the best performance among non-ensemble methods on Split-CIFAR-100 and Split-TinyImageNet." -> Boschini et al. (2022) introduces X-DER, which outperforms DER++ on these benchmarks, so 'best among non-ensemble methods' is misleading as stated. Qualify it (e.g. 'best among prior/baseline methods, excluding the paper's own X-DER') and add the actual accuracy numbers to ground the comparison, since this is a load-bearing superlative.
- [minor] Synthesis over Summary: "SS-IL is easy to implement and can be combined with any replay-based method for improved class-incremental performance." -> This subsection (and Co2L, FOSTER) ends on a paraphrase rather than a grounded comparative takeaway. Add at least one concrete comparative claim with a number or an explicit tradeoff (e.g. how SS-IL/Co2L compare to DER++ on Split-CIFAR-100) so the section reads as synthesis rather than an annotated bibliography. The chapter has almost no hard accuracy numbers despite the rubric's call for concrete comparative claims.
- [minor] Taxonomy Quality: "## Gradient-Constrained Methods" -> GEM/A-GEM/GPM use stored exemplars as gradient constraints, not as replayed data (the text itself says GEM 'uses stored exemplars not for replay but as constraints'). Placing them under a Replay chapter mixes organizing principles. State explicitly why they belong here (shared reliance on an episodic memory buffer) so the spine stays consistent, and likewise justify FOSTER, an architecture-expansion method, living under 'Distillation-Enhanced Replay'.
- [minor] Balance & Currency: "DER++ has become one of the strongest baselines in continual learning, consistently outperforming more complex methods across benchmarks." -> This promotional framing for ER/DER++ recurs multiple times (also the closing section 'The Surprising Effectiveness of Simple Replay') with little counter-evidence. Add the known regimes where DER++/ER degrade (e.g. online single-epoch, large task counts, storage-prohibited settings) to keep the family balanced per the rubric's both-advantages-and-limitations requirement.
- [minor] Notation/Style: "experience replay has proven surprisingly competitive -- a finding that has been both humbling and instructive for the field." -> Three '--' dashes (this line plus 'depends on buffer management --' and 'richer information than hard labels --') violated the repo house style ('Avoid using --'). Now resolved in the revised file. Note: the two leading/trailing '---' are YAML frontmatter delimiters and are correct as-is.

## Changes made
Removed all three "--" occurrences from the prose with targeted in-place edits: line 14 ("competitive -- a finding" became "competitive, a finding"), line 20 ("buffer management -- which samples" became "buffer management, specifically which samples"), and line 57 ("hard labels -- they encode" became "hard labels: they encode"). No em-dash or en-dash characters were present. The only remaining "---" are the required YAML frontmatter delimiters on lines 1 and 4. No actionable findings beyond mechanical cleanup were reported, and all content, math, citations, and the author's voice were preserved.

## Verification (independent re-review)
- Confirmed zero '--' occurrences in prose; the only matches are the YAML frontmatter delimiters (lines 1 and 4).
- Confirmed zero em-dash (U+2014) or en-dash (U+2013) characters.
- Confirmed lines 14, 20, and 57 now read "competitive, a finding", "buffer management, specifically which samples", and "hard labels: they encode" respectively.
- Confirmed all 24 citekeys resolve against references.yaml; no broken citekeys.

## Left for human
- None

## Remaining issues after repair
The six findings above are all minor content-quality items (no blockers). They are worth addressing in a future pass but do not block acceptance:
- GEM per-step complexity is stated as O(t^2); restate as roughly linear in t plus a QP over t-1 variables, or cite a source.
- The Boschini/DER++ "best among non-ensemble methods" superlative is misleading given X-DER; qualify and add numbers.
- Several subsections (SS-IL, Co2L, FOSTER) end on paraphrase; add concrete comparative numbers to push from summary toward synthesis.
- Justify the taxonomy placement of gradient-constrained methods and FOSTER under a Replay chapter (shared episodic-memory buffer).
- Balance the recurring DER++/ER promotional framing with the regimes where simple replay degrades.
