# Review: books/math/2-ml-basics/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 5

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: The five `--` separators flagged in the original review have been removed. Each list item now uses a colon separator, and the descriptions read as natural phrases (for example "Optimization algorithms such as SGD, momentum, Adam, and convergence analysis" and "Controlling model complexity through L1/L2 penalties, dropout, early stopping, and the bias-variance tradeoff"). No em-dash or double-hyphen glyphs remain anywhere in the file.
- [verified] All five link targets exist on disk: 1-loss-functions.md, 2-rl-algs.md, 3-gradient-descent.md, 4-backpropagation.md, 5-regularization.md. Relative paths and anchor formatting are correct.
- [minor, non-blocking] The page has no frontmatter (no sidebar_position), consistent with all sibling index.md files. Chapter ordering relies on the numeric folder prefix, so this is not a defect.

## Changes made
None in this pass. The prior revision already removed all five double-hyphen separators and the file now reads cleanly.

## Left for human
- None

## Remaining issues after repair
None
