# Review: books/programming/5-ml-systems/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Findings
- [resolved] Notation Consistency and Component Discipline: The four bullet lines (lines 5-8) now use a colon separator instead of the forbidden " -- " separator. No double-hyphen or em-dash characters remain anywhere in the file. This was the only blocking issue from the original review and it is fully fixed.
- [verified] Completeness and Self-Containment: All four relative links (./1-distributed-training.md through ./4-profiling.md) resolve to existing files in the directory (confirmed: 1-distributed-training.md, 2-mixed-precision.md, 3-inference-optimization.md, 4-profiling.md all present). The index is internally complete and every linked chapter is reachable.
- [minor] Motivation and Conceptual Framing: The one-line framing on line 3 enumerates the four sub-topics but does not give a reason a reader should care (e.g. the cost/latency/memory tension that motivates the chapter). This is adequate for a landing page and matches the sibling-chapter convention, so it is not blocking. Optional polish only.

## Changes made
None during this re-review. The revision under review had already replaced the " -- " separator with a colon on all four bullet lines, which removed every flagged occurrence while preserving link targets, descriptions, and bold formatting.

## Left for human
- The original reviewer noted the same separator violation exists across sibling chapter index pages and suggested a global convention fix. Only the targeted file was revised; applying the colon convention to sibling index.md files remains a global pass for a human.
- Parent linkage was not confirmed: verify this index.md is listed in the parent programming book index/sidebar so the chapter is reachable from the book root.

## Remaining issues after repair
None blocking. The single optional motivation polish (line 3) is non-blocking and consistent with sibling pages.
