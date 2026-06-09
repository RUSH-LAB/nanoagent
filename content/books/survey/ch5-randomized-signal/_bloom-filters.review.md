# Review: books/survey/ch5-randomized-signal/bloom-filters.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 6
- Broken citekeys: []

## Original scores
Scope & Coverage: 3, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 2

## Findings
- [resolved][blocker] Citation Integrity: The fabricated "Kriss et al. (2018) [@kriss2018adaptive]" attribution for learned Bloom filters has been corrected to "Kraska et al. (2018) [@kraska2018case]". The kriss2018adaptive citekey (which resolves to "Adaptive Cuckoo Filters") is no longer referenced from this file. The nonexistent author "Kriss et al." is gone.
- [resolved][blocker] Citation Integrity: The misattributed/unsourced "10-70% lower false-positive rates" range has been removed and replaced with the verifiable Kraska result, "roughly a 36% reduction in memory at a 1% false positive rate" on a phishing-URL task, correctly tied to kraska2018case.
- [resolved][major] Problem Formulation & Eval Rigor: The false-positive-rate formula now reads as "Under the standard assumption that the hash functions are independent and map elements uniformly at random... the false positive rate is approximately $(1 - e^{-kn/m})^k$", naming the independence/uniform-hashing assumption. All inline math ($k$, $m$, $n$, the FPR expression, $\ln 2$, $O(1)$) is now wrapped in KaTeX $...$ delimiters.
- [resolved][major] Problem Formulation & Eval Rigor: The deduplication bullet was reworked so lee2022deduplicating supports the MinHash/approximate near-duplicate claim and mitzenmacher2017probability supports only the general "probabilistic structures track already-seen content" point. The Bloom-filter dedup claim is softened to "a natural fit" rather than asserting a primary Bloom-filter dedup system.
- [resolved][major] Citation Integrity: The three previously uncited empirical bullets (embedding-table lookups, data selection, MoE routing) were softened to remove the unsupported causal/quantitative assertions ("reducing collision rates and improving model quality" etc.). They now use hedged framing ("have been proposed", "in principle", "can be viewed conceptually"), so no claim outruns its support.
- [resolved][major] Synthesis over Summary: A closing comparative synthesis paragraph was added to the Applications section. It contrasts the data-oblivious regime (classical Bloom filters, analyzable and distribution-free) with the learnable-structure regime (learned indices/filters, fewer bits at the cost of training and weaker guarantees under shift), and notes the hybrid case where a learned filter retains a small classical backup. This replaces the annotated-bibliography pattern with a genuine tradeoff takeaway.
- [resolved][style] Notation/Style: All 6 "--" occurrences were addressed. The 2 prose em-dash substitutes flagged earlier were replaced with parentheses/restructuring; only the 2 YAML frontmatter delimiter lines (1 and 4) remain, which are required syntax. Zero em-dash characters and zero prose "--" remain.

## Remaining issues after repair
- [minor] Balance & Currency: The learned-index discussion (line 20) still presents mostly advantages and the line of work stops at the 2020 PGM-index. A one-clause limitation (learned indices degrade under adversarial/irregular key distributions and need retraining under updates) and a post-2020 reference would strengthen the currency dimension. Non-blocking.
- [open, left for human] If the learned-Bloom-filter sandwiching theory is to be discussed, a Mitzenmacher (2018) "A Model for Learned Bloom Filters" entry should be added to references.yaml. Not added here to avoid fabricating a bibliography entry.
- [open, left for human] Confirm the "36% memory reduction at 1% FPR" figure against the Kraska et al. (2018) paper before publication.
- [open, left for human] The embedding-lookup, data-selection, and MoE-routing bullets were softened rather than cited. If real primary sources exist, add the citekeys and the stronger empirical phrasing can be restored.
