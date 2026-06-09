# Review: books/programming/5-ml-systems/4-profiling.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings
- [resolved] Correctness and Grounding: The GEMM arithmetic intensity now reads "~1365 FLOP/byte" (line 263), consistent with its own inputs (2*4096^3 / (3*4096^2*2) = 8192/6 = 1365.3). The compute-bound classification holds since 1365 > 296 (H100 balance). The self-contradicting worked number that failed the Correctness gate is fixed.
- [resolved] Notation Consistency and Component Discipline: All four prose double-hyphen occurrences are removed. Line 70 now reads "high Self CUDA time: these are the actual compute bottlenecks", line 187 "at maximum detail: SM utilization", line 269 "provides no benefit: you need", line 341 "launch overhead, not in the model". A grep for the prose " -- " pattern and for em-dash/en-dash characters returns no matches. House style is satisfied.
- [resolved] Correctness and Grounding: The unsupported quantitative claim ">60%" is replaced with the qualitative phrasing "Most training bottlenecks are commonly in data loading, communication, or launch overhead, not in the model computation itself" (line 341). No unsupported number is presented as fact.
- [minor] Correctness and Grounding: "Attention (seq=2K, d=128) | O(s^2 d) | O(s d) read | ~512 FLOP/byte | Compute-bound" (line 262). The ~512 value remains underived: with O(s^2 d) FLOPs and O(s d) bytes the ratio is O(s) = ~2048, so the displayed number depends on unstated constant factors. The compute-bound verdict is correct, so this does not change the takeaway. Optional: show the constants used or note a FlashAttention-style I/O accounting. Does not gate.
- [minor] Worked Examples and Illustration: The roofline section still teaches primarily through reference tables and a formula block, with no fully worked Example stepping one operation end to end from FLOPs and bytes to a verdict against a named GPU balance point. Adding one Example (e.g., layer norm on an A100) would lift the Worked Examples score. Does not gate.
- [note] Notation Consistency and Component Discipline: ASCII "->" arrows remain inside code fences (lines 149-153, 207-214, 244-245). They are code artifacts, not prose, and are acceptable. No action required.

## Disposition
The revision resolved both Correctness blockers, the Notation blocker, and the major grounding issue. The two remaining items are minor and confined to the roofline table's attention row and the absence of one fully worked roofline Example. Neither affects correctness of any stated verdict. The Correctness gate now passes. Verdict moves from REJECT to ACCEPT.

## Remaining issues after repair
- [minor] Underived ~512 FLOP/byte for the attention row (line 262); show constants or note the accounting used.
- [minor] No single fully worked roofline Example walking one operation from FLOPs and bytes to a memory-bound or compute-bound verdict.
- [external] The chapter index.md reportedly uses "--" in its bullet list; that file is outside the assigned path and should receive the same fix.
