# Review: books/programming/1-intro-to-comp/3-assembly-cuda-torch.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (this pass)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Verification of prior fixes
- Autograd node corrected: line 66 now reads `MmBackward0` for `torch.matmul`, with `BmmBackward0` noted for batched matmuls. Correct.
- Tensor Core throughput is now architecture-dependent (lines 27 and 70): 64 FP16 FMAs/clock per Tensor Core on Volta/Ampere, 256/clock on Hopper. The universal-constant framing is gone.
- The warp-level MMA instruction shape (m16n8k16, issued cooperatively by a full warp across several Tensor Cores over multiple cycles) is now separated from per-cycle per-core FMA throughput (lines 26, 70). Correct.
- Dash style: no em-dashes or en-dashes present, and no prose or code-comment "--" usages remain. The only "--" tokens are the frontmatter delimiters (lines 1, 3) and Markdown table separator rows (lines 36, 145, 216, 300, 311), which are required syntax.

## Findings (still open)
- [minor] Correctness and Grounding (line 81): `torch._dynamo.config.log_level = logging.DEBUG` still references `logging` without importing it, and `torch._dynamo.config.log_level` is deprecated in current PyTorch in favor of the `TORCH_LOGS` env var or `torch._logging.set_logs`. A reader who copies this snippet hits a NameError and uses a removed API. Add `import logging` or switch to the current logging approach with a version caveat.
- [minor] Correctness and Grounding (lines 193-194, 202-204): the fusion example still calls `torch.linear(...)` and `torch.batch_norm(...)`. The public top-level names are `torch.nn.functional.linear` and `torch.nn.functional.batch_norm` (or `F.linear` / `F.batch_norm`). Even as illustrative pseudo-code, use the real API so a reader copying it does not hit issues.
- [minor] Worked Examples and Illustration (around line 185): the operator-fusion section is rich in code and tables but still lacks one fully worked numeric `<Example>` that walks the ~6x vs ~2x HBM-traffic computation for a concrete tensor size. Adding one would lift the Worked Examples dimension from a 3.

## Rationale for verdict
The gate dimension (Correctness and Grounding) no longer has any blocker or major: the autograd-node error and both Tensor Core errors are fixed, and the dash/component-discipline blocker is fully resolved. Three minor correctness/pedagogy items remain (two copy-paste API names and one missing worked numeric example), which keep the draft from a clean ACCEPT but do not warrant rejection. Verdict: REVISE.

## Left for human
- The Hopper 256 FP16 FMAs/clock and Volta/Ampere 64 FP16 FMAs/clock per-Tensor-Core figures were carried from the prior reviewer's finding and not independently confirmed against an NVIDIA source. Please verify before publishing.
