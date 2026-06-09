# Review: books/math/1-intro-to-comp/3-assembly-cuda-torch.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 4
- Broken citekeys: ["ansel2024pytorch2"]

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings
- [resolved] Correctness and Grounding: The blocker is fixed. The citekey ansel2024pytorch2 now resolves to a real entry in references.yaml (Ansel et al., "PyTorch 2: Faster Machine Learning Through Dynamic Python Bytecode Transformation and Graph Compilation", ASPLOS 2024, key at line 2620), formatted consistently with the adjacent dao2022flashattention entry. The `[@ansel2024pytorch2]` citation in the Torch Compilation section will now render.
- [resolved] Notation Consistency and Component Discipline: All four prose " -- " em-dashes (lines 7, 25, 32, 102) are gone. The only remaining "--" sequences in the file are the frontmatter delimiter and markdown table header separators, which are valid syntax, not prose dashes. Meaning, voice, math, code, and MDX components are preserved.
- [minor, still open] Correctness and Grounding: Line 34, "Execute $4 \times 4 \times 4$ (or $16 \times 16 \times 16$) matrix multiply-accumulate operations in a single clock cycle." A single Volta Tensor Core performs a 4x4x4 MMA per clock cycle, but the 16x16x16 figure is a warp-level WMMA that aggregates many Tensor Core operations across multiple cycles, not a single clock cycle. Qualify the 16x16x16 case so it is not also described as "in a single clock cycle."
- [minor, still open] Correctness and Grounding: The quantitative rules of thumb in rmk-gemm-dominance (GEMM "roughly 60-70% of total FLOPs", Tensor Cores "8-16x", "2-3x end-to-end") and in tab-fusion-examples (per-row speedup figures) are plausible but uncited. Either hedge them as approximate or illustrative, or attach a source so a reader can verify the magnitudes.

## Verdict rationale
The gate (Correctness and Grounding) now passes: the rendering-breaking citation is fixed and accuracy is broadly sound. The two remaining items are minor accuracy or sourcing refinements that do not break the section, so the verdict moves from REJECT to REVISE rather than ACCEPT.

## Remaining issues after repair
- Qualify the 16x16x16 Tensor Core MMA claim on line 34 (warp-level WMMA spans multiple cycles).
- Hedge or cite the quantitative figures in rmk-gemm-dominance and tab-fusion-examples.
- Verify the ansel2024pytorch2 reference fields (author list, url) against preferred citation conventions; an ACM DOI (10.1145/3620665.3640366) or arXiv link may be preferred over the current pytorch.org url.
