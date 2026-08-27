# Review: books/programming/3-cuda-and-gpu/5-custom-ops.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 3
- Broken citekeys: []

## Original scores
Correctness & Grounding: 2, Motivation: 3, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 4 (gate passes), Motivation: 3, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Findings
- [resolved] Correctness & Grounding: Heading is now "## torch.library (PyTorch 2.4+)" (line 121), matching the table row (line 17) and the actual availability of custom_op and register_fake (introduced in 2.4). Blocker cleared.
- [resolved] Correctness & Grounding: Prose now names AT_DISPATCH_FLOATING_TYPES_AND2(at::kHalf, at::kBFloat16, ...) and explicitly notes the plain AT_DISPATCH_FLOATING_TYPES_AND_HALF macro omits BFloat16 (line 240). Prose and code (line 242) now agree. Major cleared.
- [resolved] Notation & Component Discipline: Intro sentence (line 7) now uses parentheses instead of "--". House-style violation cleared.
- [resolved] Notation & Component Discipline: setup.py comment (line 205) now reads "(for distributing as an installable package)" with no "--". Cleared.
- [minor, open] Correctness & Grounding: gradcheck snippet (lines 195-196) creates x with dtype=torch.float64 and calls FastSiLU.apply, but FastSiLU.forward routes through my_cuda_ops.silu_cuda whose kernel is hard-coded to data_ptr<float>(). A float64 input is not accepted by a float-only kernel, so this exact snippet fails at runtime. No reader note was added. Suggest testing on float32, dispatching over dtypes, or running gradcheck against the pure-PyTorch SiLU class and noting that gradcheck requires double precision while the kernel supports only float.
- [minor, open] Worked Examples: the "80% of the performance benefit with 20% of the implementation effort" claim (line 185) is still stated as a concrete figure. The remark title "The 80/20 rule" already signals it is a heuristic, but the body reads as a measured result. Consider softening to "most of the benefit for a fraction of the effort."

## Changes made
No further edits applied in this pass. All blocker and major fixes from the prior revision were verified in place: the torch.library heading now reads "(PyTorch 2.4+)", the dispatch-macro prose matches the AND2 code, and both prose "--" instances (intro and setup.py comment) were replaced with parentheses. The only remaining "--" matches are legitimate: frontmatter delimiters (lines 1, 3), the markdown table separator (line 14), and the --use_fast_math nvcc flag (line 220).

## Left for human
- None

## Remaining issues after repair
- gradcheck float64 vs float-only CUDA kernel mismatch (lines 195-196): snippet would fail at runtime; add a reader note or adjust the example. Minor; does not block acceptance.
- 80/20 figures stated as concrete results (line 185): consider framing as a rule of thumb. Minor.
