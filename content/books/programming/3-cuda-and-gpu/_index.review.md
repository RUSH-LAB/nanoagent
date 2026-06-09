# Review: books/programming/3-cuda-and-gpu/index.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 5
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: All five " -- " separators in the chapter bullet list (lines 5-9) have been replaced with colons, following the house-style "<title>: <description>" form. A fresh scan of the file finds zero occurrences of "--", em-dash, or en-dash. This was the original blocker, and it is now fixed.
- [minor] Notation Consistency and Component Discipline: The page still has no frontmatter (no sidebar_position, title, or id). All sibling index.md files share this omission, so Docusaurus is likely inferring position from the directory prefix. If intentional and working, this can be left as is; otherwise add explicit frontmatter for determinism. Does not gate.
- [minor] Completeness and Self-Containment: The intro sentence (line 3) enumerates kernels, memory model, optimization, and Triton but omits the fifth section, Custom PyTorch Ops, which is listed in the table of contents below (line 9). Mention custom ops in the intro or generalize the sentence so the preview matches the full contents. Does not gate.

## Changes made
None in this pass. The reviewer-flagged blocker had already been repaired before this re-review: all five " -- " separators were converted to colons in the "<title>: <description>" form. I verified the fix by reading the file and scanning for "--", em-dash, and en-dash, all of which are now absent. Links, descriptions, and the author's voice are preserved. No math, numbers, citations, or code were involved.

## Left for human
- The same " -- " pattern reportedly appears in sibling index.md files across the book. This re-review is scoped to this single file, so the sibling chapter index.md files were not inspected or edited here. A human or follow-up pass should apply the same colon replacement to them for consistency.
- The two minor findings above (missing frontmatter, intro that omits the Custom PyTorch Ops section) are optional polish and were left for the author's discretion.

## Remaining issues after repair
- Intro sentence omits the Custom PyTorch Ops section listed in the table of contents (minor, non-gating).
- No explicit frontmatter on the page (minor, consistent with siblings, non-gating).
