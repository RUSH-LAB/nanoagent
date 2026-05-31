# Review: books/math/4-calculus-and-optimization/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: The previously flagged "--" separator has been replaced with a colon in all four chapter-index bullets. A fresh scan of index.md confirms zero occurrences of "--", em-dash, or en-dash. House style (CLAUDE.md "Avoid using -- in writing") is now satisfied. Score raised from 3 to 5.
- [minor] Motivation and Conceptual Framing: "Machine learning reduces to finding parameters that minimize a loss function." is accurate and frames the chapter well for a table-of-contents page. An optional one-clause note that constrained and non-convex cases are where the real difficulty lives would preview why all four sections are needed. Does not affect correctness and is not blocking.
- [info] Completeness and Self-Containment: All four linked section files exist (1-multivariable-calculus.md, 2-convex-optimization.md, 3-non-convex-optimization.md, 4-constrained-optimization.md). No broken links.

## Re-review scores (this pass)
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Changes made
None in this pass. The repair (replacing the "--" separator with a colon in all four bullets) was already applied in the prior revision and is verified here.

## Left for human
- The same separator convention may still be present across sibling math chapter indexes (1-intro-to-comp, 2-ml-basics, 3-linear-algebra). Those files are out of scope for this single-file review; a coordinated site-wide pass is recommended.

## Remaining issues after repair
None. The blocking notation issue is resolved. The only open item is the optional motivation enhancement noted above, which does not block acceptance.
