# Review: books/programming/1-intro-to-comp/4-hpc.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 2, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 5, Completeness: 4

## Verification of prior findings
- [resolved] Worked Examples: Two new <Example> components now follow the Ring AllReduce cost remark. ex-allreduce-nvlink plugs N=8 H100, M=1 GB, beta=450 GB/s, alpha=1 us into the cost model and computes 3.90 ms with 96.2% scaling efficiency. ex-allreduce-infiniband is a faded version (NDR, beta=50 GB/s) leaving the final figure as a blank then revealing 35.0 ms and 74%. I independently recomputed both in Python: NVLink 3.9029 ms / 96.24%, InfiniBand 35.028 ms / 74.06%, ratio 8.98x. Numbers match the text and the chapter's 6-9x interconnect claim. Score raised 2 to 4.
- [resolved] Correctness & Grounding: NVLink bandwidth ambiguity addressed. A clarifying paragraph now sits under tab-gpu-interconnects stating all figures are per-direction and giving conventional bidirectional totals (A100 600, H100 900, B200 1800 GB/s), and explicitly warns that the H100 bidirectional headline collides with the B200 unidirectional figure. Defensible and now unambiguous.
- [resolved] Notation: all flagged prose "--" instances (intro line 7, MPI ranks line 11, bisection bandwidth line 311) rewritten with commas/colons. The four nvidia-smi comment glosses now use colons (lines 444-447). Remaining "--" tokens are all markdown table separators and CLI flags, which are load-bearing. Score raised 3 to 5.
- [open, minor] Correctness & Grounding: DDP bucket default still written as "25 MB" (lines 328, 340). PyTorch's _DEFAULT_BUCKET_CAP_MB = 25 is MiB. Not corrected. Low impact.

## New findings (introduced by the revision)
- [minor] Correctness & Grounding: ex-allreduce-infiniband (line 257) states alpha = 2 us is "the table's inter-node latency", but the table lists InfiniBand NDR at ~1 us (line 71); 2 us is the RoCE v2 row. The latency term is negligible (0.028 ms) so the 35.0 ms result and 74% efficiency are unaffected, but the parenthetical attribution is inaccurate. Either change alpha to 1 us (matching the cited InfiniBand row) or drop the "the table's inter-node latency" attribution.

## Verdict rationale
Correctness gate passes: all formulas, the verified bandwidth/latency figures, and the two worked examples are arithmetically sound (independently recomputed). The two majors that drove the original REVISE (zero worked examples, NVLink bandwidth ambiguity) are fully resolved, and the house-style "--" violations are gone. Remaining items are two minor cosmetic/attribution nits (25 MB vs MiB, and the 2 us alpha attribution) that do not affect any result or conclusion. ACCEPT.

## Remaining issues after repair
- [minor] Bucket default labeled "25 MB" should be "25 MiB" (lines 328, 340).
- [minor] InfiniBand example attributes alpha = 2 us to the table's inter-node latency, but the table shows ~1 us for InfiniBand NDR (line 257 vs line 71); result unaffected.
