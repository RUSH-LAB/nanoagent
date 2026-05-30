# Review: books/survey/ch3-efficient-architecture/neural-architecture-search.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 2, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Citation Integrity (was blocker): The Zoph and Le 2017 cost figure now reads "800 GPUs running for nearly a month (on the order of 20,000 GPU-days)" on line 14, matching the primary source (800 GPUs for about 28 days). The earlier "800+ GPU-days" conflation that understated cost by roughly 28x is gone, and the figure still motivates the efficiency narrative correctly.
- [resolved] Citation Integrity (was major): AutoFormer is now cited as "(Chen et al., 2021)" on line 48, matching the references.yaml entry for chen2022autoformer_nas (year: 2021) and the ICCV 2021 publication. Verified against references.yaml line 7960.
- [resolved] Formatting: No em-dash, en-dash, or "--" remains in prose. The only "--" occurrences are the required YAML frontmatter delimiters on lines 1 and 4.
- [minor, open] Citation Integrity: This file cites Once-for-All as [@cai2020onceforall] (line 32) while the chapter's taxonomy.md cites the same paper as [@cai2020once]. references.yaml still contains BOTH keys as duplicate entries (lines 2833 and 7827). The key resolves here so nothing is broken, but the duplicate-entry / inconsistent-key situation should be reconciled to one canonical key across the chapter to avoid double-counting in the generated bibliography.
- [minor, open] Problem Formulation and Evaluation Rigor: The "10^10 to 10^30" search-space-size range (line 12) is stated without a citation. Plausible and in line with common NAS estimates, but per the rubric quantitative claims should trace to a source (e.g., elsken2019neural, already cited) or be softened to an explicitly informal estimate.
- [minor, open] Balance and Currency: The LLM-era claim that modern architecture design "uses scaling laws and grid search rather than classical NAS algorithms" (line 50) carries no primary citation. For this active area, add at least one source (a scaling-law or LLM-architecture-search paper) or flag it as author synthesis.
- [minor, open] Synthesis over Summary: Several family paragraphs (MobileNetV3 on line 42, OFA, AutoFormer) close on a vague capability assertion ("set new efficiency benchmarks") rather than a quantified comparative takeaway. Adding a concrete number (e.g., MobileNetV3-Large accuracy/latency vs MobileNetV2 or MnasNet) would close each family on a grounded tradeoff.

## Changes made
None during this re-review. The revision applied prior to this pass already fixed the blocker (GPU-day cost), the major (AutoFormer year), and all em-dash formatting. All math, code, citekeys, frontmatter, and voice are intact.

## Left for human
- Reconcile the duplicate Once-for-All entries (cai2020onceforall vs cai2020once) in references.yaml to a single canonical key and update both this file and taxonomy.md to match.

## Remaining issues after repair
- Three minor uncited / under-cited quantitative or claim statements (search-space size range, LLM-era scaling-law claim) and one synthesis polish item (quantify the "set new efficiency benchmarks" closings). None block acceptance; recommended for a future polish pass.
- Cosmetic: duplicate Once-for-All citekey across the chapter (see Left for human).
