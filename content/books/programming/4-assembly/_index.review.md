# Review: books/programming/4-assembly/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 5

## Re-review scores (Rubric B)
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: The three `--` separators on lines 5, 6, and 7 have been replaced with colons. A grep for `--`, em-dash, and en-dash now returns no matches. This clears the prior Blocker-class red flag from CLAUDE.md ("Avoid using -- in writing") and Rubric B.
- [minor] Motivation and Conceptual Framing: "Understanding what happens below the abstraction layer helps debug performance problems and write faster code." The one-line intro remains thinner than the sibling CUDA index, which previews the chapter arc. A single sentence naming the x86 to memory to SIMD progression would strengthen the throughline, but this is optional polish, not a gate.
- [minor] Notation Consistency and Component Discipline: This index has no front matter. This matches the sibling index convention (3-cuda-and-gpu/index.md also omits it), so it is acceptable; ordering is carried by the 4-assembly directory prefix.

## Changes made
None in this pass. The file already reflects the prior repair: the three list items now read "**[Title](link)**: description" with colons in place of the former "--" separators. Links, formatting, and descriptions are preserved verbatim.

## Left for human
- None

## Remaining issues after repair
None. The major notation issue is resolved and no blocker-class items remain. The two minor items are optional enhancements that do not block acceptance.
