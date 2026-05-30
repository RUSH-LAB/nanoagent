# Review: books/programming/99-supplement/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Findings
- [resolved] Notation Consistency and Component Discipline: The prior " -- " separators on all three bullet lines have been replaced with colons. No "--", en-dash, or em-dash occurrences remain. The bullet format now matches sibling index pages (1-intro-to-comp, 2-torch), which use the same "**[Link]**: description" pattern.
- [minor] Motivation and Conceptual Framing: The opening line "Practical skills that every ML engineer needs but do not fit neatly into the other chapters." uses different framing than siblings, which open with "This chapter covers...". This is a stylistic preference, not a defect, and reads naturally for a supplement index. Not blocking.
- [minor] Notation Consistency and Component Discipline: The page has no frontmatter (no sidebar_position), which is consistent with sibling index pages. The 99 filename prefix already drives ordering, so no change is required.

## Verification
- All three linked sub-pages exist on disk: 1-python-tips.md, 2-linux-and-shell.md, 3-git-for-ml.md.
- Bullet descriptions accurately summarize each linked page's contents.
- No code, math, or component blocks present, so component discipline checks are not applicable beyond the link list.

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Changes made
None in this pass. The required repair (replacing the " -- " separator with a colon on all three bullet lines) was already applied to index.md in the prior revision, removing every "--" occurrence per house style. No content, math, code, frontmatter, or components were touched.

## Left for human
- None

## Remaining issues after repair
None
