# Review: books/programming/1-intro-to-comp/2-cpu-and-gpu.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 14
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 2, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings (re-review)
- [resolved] Notation Consistency and Component Discipline: All 14 prose "--" occurrences are gone. The only remaining "--" are frontmatter delimiters (lines 1, 3), ASCII-art code diagrams, and markdown table separator rows. No unicode em-dashes were introduced. House style is now satisfied.
- [resolved] Correctness and Grounding: Tensor Core generation numbering is fixed to NVIDIA's official scheme (V100=1st, A100=3rd, H100=4th, B200=5th). It now reconciles with the SM diagram (line 70) that labels H100 "4th-gen Tensor Cores". The Turing/2nd-gen row was dropped rather than fabricated, which is acceptable.
- [resolved] Correctness and Grounding: FLOPS/watt units corrected from TFLOPS/W to GFLOPS/W (line 104). Verified: 9.2 TFLOPS / 360 W = 25.6 GFLOPS/W (~26) and 990 TFLOPS / 700 W = 1414 GFLOPS/W. The 54x ratio is preserved and correct.
- [resolved] Notation Consistency and Component Discipline: The inconsistent "Tile Size" column was removed from the def-tensor-core table, eliminating the conflation of the V100 4x4x4 hardware building block with the 16x8x16 warp-MMA shape.
- [resolved] Worked Examples and Illustration: A fully worked &lt;Example&gt; (ex-roofline-h100) was added. Verified arithmetic: ridge point 990e12 / 3350e9 = 295 FLOPS/byte (matches diagram); ReLU 0.25 x 3350 GB/s = 838 GFLOPS = 0.84 TFLOPS; GEMM AI = 2*4096^3 / (2*3*4096^2) = 4096/3 = 1365 FLOPS/byte. All steps correct and use only figures already on the page.
- [minor] Correctness and Grounding: line 79 "~1000 TFLOPS FP8, ~990 TFLOPS FP16 (with sparsity)" in the code-gpu-sm-layout diagram is still inaccurate. ~990 FP16 and ~1979 FP8 are the DENSE H100 SXM figures; the "(with sparsity)" qualifier misattributes the dense FP16 number, and "~1000 TFLOPS FP8" is roughly the dense FP16 figure mislabeled as FP8. This minor item from the original review was not addressed. Suggested fix: "~990 TFLOPS FP16, ~1979 TFLOPS FP8 (dense)".
- [minor] Correctness and Grounding: line 336 "use Tensor Cores (FP16/BF16) for a 16x speedup, or FP8 for 32x" is still internally inconsistent with the page's own numbers. The comparison table gives 990/67 ~= 15x for FP16 (not 16x), and FP8 dense is ~1979/67 ~= 30x (not 32x). This minor item was not addressed. Suggested fix: state "~15x" and "~30x", or label them approximate and cross-reference tab-cpu-vs-gpu.

## Verdict rationale
All blockers and both major findings are resolved: prose em-dashes removed, generation numbering corrected and reconciled with the SM diagram, FLOPS/watt units fixed, the conflated Tile Size column dropped, and a correct worked Example added. The Correctness gate is no longer failed. Two minor numeric/labeling inaccuracies remain (lines 79 and 336), both internal-consistency issues against the page's own tables. They do not block the gate but should be corrected, so the verdict is REVISE rather than ACCEPT.

## Remaining issues after repair
- [minor] line 79: SM diagram FP8/FP16 figures and "(with sparsity)" label misattribute dense numbers.
- [minor] line 336: "16x"/"32x" speedups do not match the page's own 15x table figure (~15x / ~30x).
