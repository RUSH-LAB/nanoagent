# Review: posts/research/swarms.md

- Content type: research-post
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 10
- Broken citekeys: []

## Original scores
Novelty of Insight: 3, Correctness and Soundness: 3, Evidence and Grounding: 2, Clarity and Structure: 4, Significance (So-What): 3, Honesty and Limitations: 1

## Re-review scores (post-revision)
Novelty of Insight: 3, Correctness and Soundness: 3, Evidence and Grounding: 3, Clarity and Structure: 3, Significance (So-What): 3, Honesty and Limitations: 3

## Findings
- [major] Clarity and Structure: The "What This Enables" section heading is missing. Lines 180 to 182 hold the three upside bullets ("Scalable data synthesis", "Self-improving search", "Adaptive difficulty"), but they now follow the Limitations bullet list with no intervening header. They render as if they belong to Limitations, which is self-contradictory (a Limitations list capped by unlabeled benefits). A section header (for example "## What This Enables") must be added before line 180. This is the one blocker preventing ACCEPT.
- [minor] Honesty and Limitations: "**Self-improving search.** The search engine identifies its own blind spots through synthetic probing and fixes them automatically." The earlier review recommendation to add a one-sentence self-referential caveat here was not applied. The probes are generated from the same metadata the index is built on, so probe and index can share blind spots and the system may systematically miss gaps the annotations do not represent. The new Limitations section partly covers adjacent risks, but this specific bullet still reads as pure upside.

## Resolved since original review
- [critical, resolved] Convergence claim downgraded to an explicit hypothesis (line 169) and a Limitations section added (lines 171 to 178) covering judge reliability, write-back quality control and adversarial pollution, cost of combinatorial generation, and convergence versus drift or collapse.
- [major, resolved] Synthetic-data volume claims grounded against doc2query, docTTTTTquery, and InPars, and the "hundreds of training examples" figure plus the table multipliers reframed as explicit back-of-envelope estimates (lines 78 and 117).
- [major, resolved] Related-work paragraph added (line 10) contrasting the thesis with Semantic Web/RDF, knowledge-graph construction, self-play retrieval, and agent-memory/write-back systems, so the novelty is legible.
- [minor, resolved] The FBN1/acromicric-dysplasia biology was spot-checked and is correct; no change required.

## Changes made
None in this pass. This is an independent re-review only; the file was not edited. The dash rule was re-verified: 10 "--" occurrences, all structural Markdown (frontmatter "---", the truncate comment, and table separator rows), and zero unicode em-dashes, so nothing to strip.

## Left for human
- Add a "## What This Enables" header before the three upside bullets at line 180. Without it the document structure is broken.
- Optionally add a self-referential caveat to the "Self-improving search" bullet (shared blind spots between probe and index).
- Citations are referenced by name only; a human may want to add formal links for the named works.
- The "on the order of hundreds" estimate is unverified and should be replaced with a measured number once available.

## Remaining issues after repair
- Missing "What This Enables" section header (major, structural).
- "Self-improving search" bullet still lists only upside (minor).
