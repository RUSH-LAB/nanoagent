# Review: books/programming/1-intro-to-comp/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 4
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: All four chapter-overview bullets previously used a " -- " separator, violating Rubric B and CLAUDE.md. Every separator has been replaced with a colon. A fresh scan of index.md finds zero double-hyphen or em-dash characters.
- [verified] Correctness and Grounding: All four linked section files (1-comp-machine.md, 2-cpu-and-gpu.md, 3-assembly-cuda-torch.md, 4-hpc.md) exist in the chapter directory, so every relative link resolves.
- [minor] The intro sentence and bullet descriptions read cleanly and preview the arc from fetch-decode-execute through distributed GPU clusters. The colon-led bullets are consistent with each other and with the prose voice.

## Changes made
None this pass. The file was already revised before this re-review: all four " -- " separators in the chapter overview bullets (lines 5-8) had been replaced with colons, and the links, descriptions, and author voice were preserved.

## Left for human
- None

## Remaining issues after repair
None
