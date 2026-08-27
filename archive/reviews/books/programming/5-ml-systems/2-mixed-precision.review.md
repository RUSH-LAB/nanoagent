# Review: books/programming/5-ml-systems/2-mixed-precision.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0 (in prose; remaining matches are frontmatter delimiters and table separator rows)
- Broken citekeys: []

## Re-review scores (Rubric B)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior fixes
- FP8 E4M3 max value: corrected to $\pm 448$ in both the formats table (line 21) and the FP8 code comment (line 204). Confirmed.
- FP8 E4M3/E5M2 mantissa wording: clarified to "3 mantissa bits = 8 steps per binade" / "2 mantissa bits = 4 steps per binade" (lines 204, 206). Confirmed.
- Parameter-memory contradiction: corrected to "6 bytes/param (2-byte working copy + 4-byte FP32 master) | ~1.5x increase" (line 152). The component rows now reconcile with the "~0.6-0.7x Net GPU memory" bottom line (savings come from activations and gradients, not weights). Confirmed.
- Prose em-dashes: all four ("--") occurrences replaced with commas/colons/sentence breaks (lines 27, 115, 141, 173). No prose "--" remains. Confirmed.
- Tensor-core throughput caption: now states "(dense, no sparsity)" (line 161), resolving the 2x-sparsity ambiguity. H100 990/1979 and A100 312/624 are dense and internally consistent. Confirmed.

## Gate decision
The Correctness and Grounding gate is now passed. All three factual blockers (FP8 E4M3 max value in two locations, the contradictory parameter-memory cell) and the notation blocker (prose em-dashes) are resolved. No false claims remain.

## Remaining minor issues (non-blocking)
- [minor] Notation Consistency: the "Precision (decimal digits)" column for FP8 is still internally inconsistent with the rest of the table. The column uses log10(2^(mantissa+1)) elsewhere (FP32 ~7.2 = log10(2^24); FP16/TF32 ~3.3 = log10(2^11); BF16 ~2.4 = log10(2^8)). By that rule E4M3 should read ~1.2 (log10(2^4)) not ~1.0, and E5M2 ~0.9 (log10(2^3)) not ~0.6 (lines 21-22).
- [minor] Worked Examples: the torch.amp / Loss Scaling sections remain code- and prose-driven with no fully worked numeric <Example> (e.g. a single gradient value underflowing in FP16, then surviving after scaling by 65536). Adding one would lift the Worked Examples dimension from 3 to 4.

## Changes made this pass
None. The prior repair pass already applied the blocker fixes; this pass independently verified them and confirmed the gate is satisfied.

## Left for human
- Optional: correct the two FP8 decimal-digit cells and add a worked numeric loss-scaling example. Both are minor and do not block acceptance.
