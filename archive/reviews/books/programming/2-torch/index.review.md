# Review: books/programming/2-torch/index.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 5, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 5, Notation & Component Discipline: 2, Completeness: 5

## Findings
- [resolved] Notation & Component Discipline: The six "--" separators on lines 5-10 have all been replaced with colons (e.g., "**[Tensors](./1-tensors.md)**: Creating tensors..."). The house-style violation that drove the original REJECT is fixed. No "--" or em-dashes remain in the file. All six linked section files (1-tensors.md through 6-debugging.md) exist on disk, so every link resolves.
- [minor] Motivation: "This chapter covers PyTorch from tensors to production training loops. Each section includes runnable code examples." The intro remains functional but thin for a chapter landing page. One added sentence on why PyTorch (define-by-run autograd, the from-tensors-to-training arc) would frame the chapter's purpose rather than just announcing coverage. Consistent with sibling index files, so low priority and not blocking.

## Changes made
None in this pass. The prior revision replaced all six "--" separators with colons; this review verified the fix independently.

## Left for human
- None

## Remaining issues after repair
None blocking. Optional: strengthen the one-line intro with a sentence motivating PyTorch, but this is a nice-to-have consistent with sibling index pages.
