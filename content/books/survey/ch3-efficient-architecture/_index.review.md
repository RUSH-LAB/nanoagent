# Review: books/survey/ch3-efficient-architecture/index.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 96
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 5, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 3, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 5

## Findings
- [resolved] Citation Integrity (PathX/Path-X accuracy): state-space-models.md no longer credits the ~86% LRA aggregate to the single PathX task. The sentence now reads that S4 was the first model to solve the task and reached a Path-X accuracy of roughly 88%, consistent with the primary paper (arXiv:2111.00396). Verified in place.
- [resolved] Citation Integrity (duplicate citekeys): all five double-cited pairs are consolidated to one canonical key each, and the duplicate references.yaml entries are deleted. Confirmed canonical keys resolve in references.yaml: zaheer2020bigbird (line 2563), dao2024transformers (3102), ye2024diff_transformer (5012), zheng2024sglang (5759), arora2024based (7810). The deleted keys (zaheer2020big, arora2024simple, dao2024mamba2, ye2024differential, zheng2024sglangradixtree) no longer appear anywhere under content/ or src/.
- [resolved] Notation/House style ("--"): a chapter-wide scan finds zero prose "--" sequences. The only surviving "--" tokens are the required YAML frontmatter delimiters on lines 1 and 4 of each file and markdown table separator rows, all of which must be preserved. No unicode em-dash or en-dash characters remain.
- [resolved] Citation Integrity (Lottery Ticket attribution): the misspelling "Carlin" no longer appears in the chapter prose or in references.yaml; the entry frankle2019lottery now lists Michael Carbin. The citekey resolves.
- [open, minor] Taxonomy Quality: family overlap is acknowledged generally, but the precise distinguishing principle separating family 1 (efficient attention, including Performer and Katharopoulos linear attention), family 2 (SSMs, themselves sub-quadratic), and family 3 (sub-quadratic architectures such as BASED and RWKV) is still not stated crisply. Adding a one-line discriminator (preserve-attention vs replace-attention-with-recurrence vs other) would give each method one unambiguous home. Content suggestion, not a blocker.
- [open, minor] Synthesis over Summary: a few subsection endings (for example the RWKV-v5/v6 data-dependent time-mixing claim) still assert progress without a quantified comparative takeaway. A concrete number or stated tradeoff would lift these above annotated-bibliography phrasing. Content suggestion, not a blocker.

## Changes made
No new edits were required in this pass. The three actionable findings from the prior round were already applied and are independently confirmed here: (1) PathX/Path-X claim corrected in state-space-models.md; (2) all five duplicate citekey pairs consolidated to canonical keys with duplicates removed from references.yaml and all references updated chapter-wide and in ch4-agentic-search/connections.md; (3) all prose "--" removed across the chapter with only frontmatter and table delimiters remaining; plus the Frankle and Carbin attribution fix in both prose and references.yaml. Verification was read-only.

## Left for human
- A concurrent formatter expanded several files beyond em-dash removal (for example efficient-training.md gained a "Choosing Among the Techniques" section and new citekeys epoch2023trends and strubell2019energy, with a revised GPT-4 FLOP figure). These edits fall outside the assigned findings; confirm the new citekeys resolve and the revised figures are accurate.
- Path-X accuracy is stated as "roughly 88%". If an exact reported figure is preferred over an approximation, verify against arXiv:2111.00396.
- For the BASED pair, arora2024based was kept as canonical; swap if the shorter key is the house preference.

## Remaining issues after repair
- Two open minor content suggestions (taxonomy family-boundary precision and quantified comparative takeaways in a few subsection endings). Neither blocks publication; both can be addressed in a future content pass.
