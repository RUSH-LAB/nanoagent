# Review: books/math/1-intro-to-comp/4-hpc.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 5
- Broken citekeys: ["shoeybi2019megatron"]

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior fixes
- [resolved] Citekey: line 105 now reads [@shoeybi2020megatronlm], which exists in references.yaml (line 5631). All other citekeys in the file (rajbhandari2020zero, huang2019gpipe, narayanan2019pipedream, touvron2023llama) also resolve. Citations will render.
- [resolved] NVLink bandwidth blocker: line 147 now reads "8 A100 GPUs on NVLink (600 GB/s bidirectional per GPU, so 300 GB/s per direction)". Correct A100 NVLink-3 figure and correct "per GPU" wording.
- [resolved] Time recompute: line 149 now reads "245 / 300 = 0.82 seconds (using the per-direction bandwidth, since each device sends and receives concurrently)". Arithmetic checks: 245/300 = 0.817. The 245 GB per-device ring traffic is now annotated.
- [resolved] Em-dash style: the only "--" matches left are frontmatter delimiters (lines 1, 3) and Markdown table separators (lines 18, 125, 183), which are legitimate. The section heading is now "Overlapping Communication and Computation"; the four prose dashes are rephrased.

## Remaining findings
- [minor] Correctness and Grounding: line 175 "training LLaMA-65B on 2048 A100 GPUs achieved ~50% MFU" attributed to [@touvron2023llama]. The LLaMA paper headlines throughput (about 380 tokens/sec/GPU for 65B, 21 days on 2048 A100s) rather than a 50% MFU figure. Either trace the 50% MFU to the cited source or re-attribute it; it is a load-bearing number presented as a fact.
- [minor] Correctness and Grounding: line 105 "only one allreduce per FFN block is needed (instead of two allgather + reduce-scatter pairs). This is a key insight that reduces communication by 50%." The Megatron design uses one allreduce in forward and one in backward per FFN block (one per pass, not one total), and the precise 50% is qualitative rather than sourced. Tighten the wording to state forward/backward explicitly and soften or ground the 50%.
- [minor] Notation Consistency and Component Discipline: line 184 keeps symbol p overloaded (Amdahl parallel fraction vs number of pipeline stages). The notation table flags the clash but does not resolve it. Use a distinct symbol for one usage (for example P_stages) to satisfy one-symbol-per-concept.

## Rationale for verdict
All blockers and majors from the original review are fixed and the Correctness and Grounding gate now passes. Three minors remain open, one of which (the MFU attribution on a load-bearing claim) warrants a light correction before publishing, so the verdict is REVISE rather than ACCEPT.

## Remaining issues after repair
- MFU attribution (line 175) unverified against touvron2023llama.
- Megatron 50% / one-allreduce wording (line 105) imprecise on forward vs backward.
- Symbol p overload unresolved in the notation table (line 184).
