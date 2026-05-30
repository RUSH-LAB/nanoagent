# Review: books/math/6-advanced-ml-math/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 4
- Broken citekeys: []

## Original scores
Correctness & Grounding: 4, Motivation: 2, Worked Examples: 3, Cognitive Load & Scaffolding: 3, Notation & Component Discipline: 2, Completeness: 3

## Findings
- [resolved] Notation and Component Discipline: the four spaced double-hyphen separators in the chapter overview bullets (lines 5 to 8) have been replaced with em-dash characters. No spaced double-hyphen sequences remain in the file, so the project instruction "Avoid using double hyphens in writing" is now satisfied.
- [minor] Motivation: the intro sentence still repeats "mathematical" three times and describes "the classical toolkit" without naming it. Naming the concrete tools (spectral graph theory, SDEs, optimal transport) and the linear-algebra-and-calculus core they exceed would give the overview real motivation. Not blocking for an index page.
- [minor] Completeness: the page still lacks a sentence on prerequisites and reading order and does not link back to the foundational chapters these topics build on. Adding this would let the index scaffold the reader rather than only list four links. Not blocking.

## Verification
- Confirmed all four link targets exist: 1-attention-and-transformers.md, 2-diffusion-models.md, 3-graph-neural-networks.md, 4-optimal-transport.md.
- Confirmed zero spaced double-hyphen occurrences remain via content search.

## Changes made
None in this pass. The previously requested separator fix was already applied in the revision under review.

## Left for human
- Optional polish: rewrite the intro sentence to remove the repeated word and name the concrete tools and prerequisites. Low priority.

## Remaining issues after repair
- Two minor polish items remain open (intro repetition and missing prerequisites or reading order), neither blocking. The major separator issue is fully resolved, so the page is acceptable to publish.
