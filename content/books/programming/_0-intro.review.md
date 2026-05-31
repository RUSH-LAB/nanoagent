# Review: books/programming/0-intro.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 26
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 5

## Findings
- [resolved] Completeness and Self-Containment: The "NOTE: This is entirely written by Claude. This is now a tentative writeup." editorial draft note has been removed. The page body now opens with "# Welcome" and no provenance note renders in published text.
- [resolved] Notation Consistency and Component Discipline: All 26 prose and code occurrences of the double dash are gone. The four sentence dashes were restructured into commas, "since", "Chapters 1 and 2", and a parenthetical; the four code comment markers in the abstraction-stack block are now "#" comments. The only remaining double-dash strings are required syntax (frontmatter delimiters on lines 1 and 4, and the markdown table separator on line 21). No em-dash characters remain.
- [resolved] Notation Consistency and Component Discipline: YAML frontmatter was added (sidebar_position: 0, title: Welcome), making chapter ordering deterministic rather than relying solely on the 0- filename prefix.
- [minor, open] Correctness and Grounding: lines 36-37 still place "mad.f32 %f3, %f1, %f2, %f3  # individual instructions" directly above "Tensor Core FMA  # the actual computation" as two consecutive rows of one descending chain. mad.f32 is a scalar FP32 PTX FMA, whereas a Tensor Core operates on matrix tiles (mma/wmma on fragments); a matmul lowered to Tensor Cores does not pass through mad.f32. This is illustrative and labeled as such, so it does not block, but replacing mad.f32 with an mma/wmma instruction, or noting these are two alternative bottom paths, would make the chain coherent.
- [minor, open] Completeness and Self-Containment: line 45 still reads "as of 2025" while the site currentDate is 2026-05-29. Consider "as of 2025-2026" or naming the hardware generation. The surrounding sentence already notes that relative relationships are durable, so impact is low.

## Verdict rationale
Both blockers (the editorial draft note and the double-dash usage that the Notation and Component Discipline dimension flags as a blocking condition) are fully resolved. The frontmatter major was addressed. The two remaining items are minor and non-blocking: an illustrative abstraction-stack simplification and a mildly stale year reference. The page is correct, well motivated, and self-contained, so it clears the gate and moves to ACCEPT.

## Left for human
- Frontmatter consistency. The sibling chapter index.md files (1-intro-to-comp/index.md, 2-torch/index.md, 3-cuda-and-gpu/index.md, 4-assembly/index.md, 5-ml-systems/index.md, 99-supplement/index.md) do NOT use YAML frontmatter; they rely on the numeric directory prefix for ordering. Adding frontmatter to 0-intro.md alone is safe and improves determinism, but it is now inconsistent with the rest of the book. A human should decide whether to apply frontmatter across all sibling files for consistency, or to keep the book frontmatter-free and rely on filename or directory prefixes uniformly.

## Remaining issues after repair
- [minor] mad.f32 vs Tensor Core FMA rows in the abstraction-stack code block conflate scalar-core and Tensor-Core execution paths.
- [minor] "as of 2025" reads slightly stale for a 2026 reader.
- [open question] Frontmatter convention inconsistency with sibling chapter files (see Left for human).
