# Review: books/survey/ch1-continual-learning/connections.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [major] Synthesis over Summary: "The replay buffers used in model-based RL (Dyna [@sutton1990integrated], MuZero [@schrittwieser2020mastering]) are formally identical to the replay buffers in continual learning." -> "Formally identical" was an overclaim: RL replay buffers exist to decorrelate samples and improve sample efficiency over an i.i.d. assumption, while CL buffers exist to counter catastrophic forgetting across a task sequence. RESOLVED: now reads "share the same mechanism... though they serve different objectives," naming both differing objectives.
- [major] Balance & Currency: "Online continual learning ... is formally equivalent to the streaming computation model ..." asserted a formal equivalence as fact while the following sentence hedged ("may apply," "potentially establishing"). RESOLVED: softened to "is closely analogous to," so the strong claim now matches the hedged consequence.
- [major] Synthesis over Summary: The Randomized Algorithms reservoir-sampling bullet duplicated the earlier World Models bullet with the same claim and citation. RESOLVED: the second instance now cross-references the World Models instance ("discussed under World Models above") and adds a comparative synthesis point (reservoir sampling as one instance of Chapter 5's broader streaming-sampling toolkit, with the shared uniform-sample guarantee letting buffer management inherit streaming formal bounds).
- [minor] Citation Integrity / Balance & Currency: "quantized models may have different forgetting characteristics ... and quantization-aware continual training remains underexplored." Still the only bullet with no citation backing either claim. PARTIALLY OPEN: phrasing reads as an open direction ("remains underexplored") rather than a sourced finding, which is acceptable, but a citation to a quantization x forgetting study would strengthen it. Non-blocking.
- [minor] Problem Formulation & Eval Rigor: Fisher-storage complexity notation O(N), O(N^2), O(N * k). RESOLVED in practice: the inline plain-text O(...) form matches the house convention used in regularization-methods.md (O(T * |theta|), O(|theta|)) and replay-methods.md (O(t^2)). The bullet already states the diagonal Fisher is O(N) and the full Fisher is O(N^2), so the standard EWC diagonal cost is not misread.
- [minor] Scope & Coverage: As a connections appendix the file states no explicit scope or selection principle. Acceptable for this file type; a one-line lead naming the selection principle would make coverage evenness legible. Non-blocking.

## Changes made (verified in revised file)
All 9 prose double-hyphens were removed; the only remaining "--" are the two frontmatter delimiters on lines 1 and 4, which are valid YAML. The three major findings are all addressed: (1) the "formally identical" RL replay-buffer claim is downgraded to "share the same mechanism" with the differing objectives named; (2) the streaming "formally equivalent" overclaim is softened to "closely analogous"; (3) the duplicated reservoir-sampling bullet is differentiated and cross-referenced with added comparative synthesis. No numbers, citations, or math were fabricated or altered; voice and structure preserved.

## Left for human
- Optional: add a citation to a quantization x forgetting study for the quantization bullet (line 14), or leave it explicitly framed as an open direction.
- Optional: add a one-line scope/selection lead under the chapter heading.

## Remaining issues after repair
- [minor, non-blocking] Quantization bullet (line 14) carries no citation; acceptable as open-direction phrasing.
- [minor, non-blocking] No explicit scope lead for the connections appendix.
