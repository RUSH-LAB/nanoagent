# Review: books/programming/5-ml-systems/1-distributed-training.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Revised scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Findings
- [resolved] Notation Consistency and Component Discipline: All three prose "--" instances are gone. Line 7 now reads "doing this efficiently: naively partitioning work..." (colon). The DDP-internals remark (line 53) reads "the last layer's gradients, which are typically computed first" (comma-led relative clause). The no_sync remark (line 101) reads "on every backward() call, even during intermediate accumulation steps where the gradients will be added to, not used" (comma). The only remaining "--" are frontmatter delimiters (lines 1, 3), code content (line 47 --nproc_per_node), and Markdown table separator rows, all legitimate non-prose.
- [resolved] Worked Examples and Illustration: A step-by-step worked Example (ex-fsdp-memory, lines 191-198) now precedes the FSDP memory table. It derives params = 7e9 x 4 = 28 GB, gradients = 28 GB, AdamW m+v = 56 GB, total 112 GB, then 112/8 = 14 GB and 112/4 = 28 GB. Figures match the table (tab-fsdp-memory) exactly and introduce no new numbers. The arithmetic is correct and the component breakdowns (28/4=7, 28/8=3.5, 56/4=14, 56/8=7) align with the per-row table values.
- [minor, open] Correctness and Grounding: "The communication overhead is typically 5-15% compared to DDP." (line 213) remains unsourced and hardware-dependent. Non-gating; could be softened with an interconnect qualifier.
- [minor, open] Correctness and Grounding: The "~N x" memory-savings column for TP (line 113) still lacks a footnote clarifying that the saving applies to parameter/optimizer memory, not replicated activation memory. The SP row partly covers this. Non-gating.
- [minor, open] Motivation and Conceptual Framing: The DeepSpeed ZeRO section (line 216) still opens with a definitional sentence and table rather than a one-line contrast with FSDP. The later rmk-deepspeed-vs-fsdp remark covers the comparison. Non-gating.

## Changes made
None by this reviewer. The prior revision addressed both major findings (prose "--" removal and the missing worked example) correctly, as verified above.

## Left for human
- Optional polish only: source or qualify the 5-15% overhead figure; add a TP activation-memory footnote; add a one-line ZeRO motivation sentence. All minor and non-gating.

## Remaining issues after repair
- Three minor, non-gating items remain (5-15% overhead unsourced; TP ~N x activation caveat; ZeRO section opening motivation). None block acceptance.
