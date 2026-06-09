# Review: posts/blog/recent-progress-on-ir/index.mdx

- Content type: research-post
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Novelty of Insight: 2, Correctness and Soundness: 4, Evidence and Grounding: 4, Clarity and Structure: 4, Significance (So-What): 2, Honesty and Limitations: 4

## Re-review scores
Novelty of Insight: 3, Correctness and Soundness: 4, Evidence and Grounding: 4, Clarity and Structure: 4, Significance (So-What): 3, Honesty and Limitations: 4

## Findings
- [resolved] Significance (So-What): The revision adds a comparative tradeoff table (lines 13 to 19) that groups all seven works by theme, names where each moves cost, and states the tradeoff each accepts. This supplies the connective tissue that was missing and lifts the post above a per-paper roundup. Score raised 2 to 3.
- [resolved] Novelty of Insight: The opening (line 9) now leads with a real thesis (2026 IR work converges on pushing cost off the query and online path, relocating expense to where it is cheapest to absorb rather than making retrieval fundamentally smarter) instead of a topic statement. The claim organizes the table and the per-paper entries. Score raised 2 to 3.
- [minor, open] Evidence and Grounding: Line 28 still reads "unsupervised state-of-the-art on standard benchmarks." The Revela paper scopes its ~1000x data / 10x compute SoTA claim to BEIR; on CoIR/BRIGHT it makes the different claim of surpassing larger supervised models. Recommend scoping the SoTA wording to BEIR. Non-blocking.
- [minor, open] Correctness and Soundness: The three-pass procedure (lines 41 to 115), including output = s + b and exact KV-cache reuse from Pass 2, is the author's illustrative reconstruction of the paper's in-batch-attention mechanism, presented with more architectural specificity than the paper states. Spot-checks surfaced no error. Recommend a one-line note that the pseudocode is an illustrative reconstruction so readers do not treat the pass structure as verbatim. Non-blocking.
- [nit, open] Clarity: Line 9 still ends with "The recurring themes are retrieval efficiency, learned sparse representations, and multilingual coverage," which now partly duplicates the table's theme grouping. Could be trimmed for a tighter lead, but harmless.

## Changes made (verified)
Confirmed all four en-dashes in the body were replaced with plain-text equivalents and that the only remaining "---" are the YAML frontmatter fences (lines 1 and 7), which are required and not prose dashes. The table separator row uses single dashes ("| - |"), avoiding "--". The new thesis paragraph and tradeoff table draw only on facts already present in the per-paper summaries; no numbers, benchmarks, or citations were fabricated. Math, code, frontmatter, MDX truncate marker, and author voice are preserved. Pseudocode symbols on lines 57 and 98 are a minus sign and a not-equal sign, not em-dashes.

## Left for human
- The thesis and tradeoff table synthesize only what the per-paper entries already state. If you want a sharper or more contrarian framing (explicitly arguing the field is not making retrieval fundamentally smarter), verify that characterization against the actual papers first.
- SPLARE is grouped under "Cheaper indexing units" with DISCo, but its summary also emphasizes multilingual / language-agnostic strengths. Consider whether to represent it under multilingual coverage as well or instead.

## Remaining issues after repair
- Two non-blocking minor items remain open: scope the Revela SoTA claim to BEIR (line 28), and add a one-line note that the three-pass pseudocode is an illustrative reconstruction (lines 41 to 115). Neither blocks publication.
