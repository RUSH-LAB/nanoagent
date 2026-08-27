# Review: books/math/1-intro-to-comp/index.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 381
- Broken citekeys: ["katz2017reluplex","blum1989training","alman2021refined","telgarsky2016benefits","eldan2016power","yarotsky2017error","montufar2014number","belkin2019reconciling","ansel2024pytorch2","shoeybi2019megatron"]

## Original scores
Correctness and Grounding (gate): 2, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores (this file only)
Correctness and Grounding (gate): 5, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Findings
- [resolved] Notation Consistency and Component Discipline: The four prose double-dash separators in the chapter table-of-contents list items are gone. The file now contains zero double-dash and zero em-dash occurrences. Separators were replaced with colons in the natural "label: description" form, preserving link targets, bold formatting, and descriptions.
- [pass] Correctness and Grounding (gate): index.md is a pure table of contents. It contains no citekeys, no cuBLAS or Strassen text, no numerical claims, and no load-bearing facts. The four relative links resolve to the chapter section files. The gate passes for this file.
- [info] Completeness and Self-Containment: The nominal review target carries no reviewable substance; all content lives in the four linked section files (1-comp-machine.md, 2-cpu-and-gpu.md, 3-assembly-cuda-torch.md, 4-hpc.md). The TOC links resolve correctly and every section is listed, so self-containment is adequate for an index page.

## Out of scope for this file (route to sibling section files)
The original review's blockers and major findings do NOT appear in index.md. They live in the chapter's sibling files and were never editable from the named target. They remain open and should be addressed by re-running the fixer and reviewer against those sub-files:
- [blocker] Eight broken citekeys absent from references.yaml: katz2017reluplex, blum1989training, alman2021refined, telgarsky2016benefits, eldan2016power, yarotsky2017error, montufar2014number, belkin2019reconciling. Add new bib entries; do not invent references.
- [correction] ansel2024pytorch2 DOES resolve in references.yaml, so it is not broken. shoeybi2019megatron should be corrected to the existing key shoeybi2020megatronlm.
- [major] Correctness: "effectively O(n^2.8) using Strassen's algorithm in libraries like cuBLAS" is factually wrong. cuBLAS default GEMM uses classical O(n^3) blocked kernels, not Strassen. Remove the cuBLAS attribution or note Strassen is O(n^2.807) in theory but not used in production GPU BLAS.
- [minor] Correctness: arithmetic-intensity example uses 80 TFLOPS FP32 for the H100 while the CPU-vs-GPU table lists ~67 TFLOPS FP32. Reconcile the two numbers and make I* consistent.
- [minor] Correctness: the depth claim O(N^L) regions for deep ReLU networks is an upper bound and should be stated as such; montufar2014number gives a lower-bound construction. Fix once the citekey resolves.
- [minor] Notation: symbol p is overloaded (Amdahl parallel fraction vs number of pipeline stages vs significand bits in the hardware chapter). Consider distinct symbols.

## Changes made
The only file named for editing, index.md, had its four prose double-dash separators replaced with colons, removing every double-dash from the file while preserving link targets, bold formatting, and descriptions verbatim. This file is a pure table of contents; it contains no citekeys, no cuBLAS or Strassen text, and previously held only 4 separator dashes (not 381). The bulk of the reviewer's findings live in the sibling sub-pages of this chapter, not in index.md.

## Remaining issues after repair
None in index.md. The blockers and major or minor findings listed under "Out of scope for this file" remain open in the sibling section files and need a human to route the fixer and reviewer to those files.
