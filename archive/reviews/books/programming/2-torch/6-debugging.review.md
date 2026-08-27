# Review: books/programming/2-torch/6-debugging.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 3
- Broken citekeys: []

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Findings
- [resolved] Correctness and Grounding: The memory-budget table blocker is fixed. The Model parameters and Gradients rows now read "14 GB (BF16)", which matches the $2P$ (BF16) formula. The figures reconcile with the stated total: 14 + 14 + 56 + 10 = 94, consistent with "94+ GB".
- [resolved] Correctness and Grounding: The FP16 underflow row now reads "Gradients below the smallest normal ($\approx 6 \times 10^{-5}$) lose precision in the subnormal range; full flush-to-zero near $6 \times 10^{-8}$", correctly conveying that precision degrades well before the flush-to-zero point rather than implying gradients are safe down to 6e-8.
- [resolved] Notation Consistency and Component Discipline: All three prose "--" occurrences are gone. Line 7 now uses a colon, the anomaly-detection comment uses a comma, and the memory-snapshot comment was restructured to "to visualize memory over time". The only "--" tokens left are YAML frontmatter delimiters (lines 1, 3) and required markdown table separator rows (lines 16, 196, 273, 364, 407, 428).
- [open, minor] Worked Examples and Illustration: Still no <Example> component tracing a single bug end to end from symptom to diagnosis to fix (for instance, a NaN that anomaly detection localizes). The section remains rich in code and tables, which is sufficient for a debugging reference chapter, but a faded-guidance walkthrough would raise this dimension. Non-blocking.
- [open, minor] Completeness and Self-Containment: Under mixed precision the optimizer table still omits the FP32 master weight copy (~4P = 28 GB) that optimizers typically keep. The current table is internally consistent and reconciles to its stated 94+ GB total, so this is a scope choice rather than an error; stating the pure-FP32-master vs mixed-precision assumption would make it more complete. Non-blocking.

## Changes made
None in this pass. The revision (performed before this re-review) already addressed both gating correctness issues and all prose "--" occurrences. Verified the fixes are present and internally consistent.

## Left for human
- None

## Remaining issues after repair
- Optional: add one end-to-end <Example> walking a concrete bug from symptom to diagnosis to fix with faded guidance.
- Optional: in the memory-budget table, state the FP32-master-weight assumption (or add the ~4P master-copy line) so the budget covers a realistic mixed-precision setup.
