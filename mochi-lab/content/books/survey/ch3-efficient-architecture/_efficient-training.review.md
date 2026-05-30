# Review: books/survey/ch3-efficient-architecture/efficient-training.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 5, Problem Formulation & Eval Rigor: 4

## Verification of the revision
- Citation Integrity (major, RESOLVED): The GPT-4 FLOP claim now reads "on the order of 10^25 FLOPs (Epoch AI estimates roughly 2x10^25) [@epoch2023trends]" and the energy/policy cost claim is cited [@strubell2019energy]. Both citekeys confirmed present in references.yaml (epoch2023trends line 5433, strubell2019energy line 2528). The unverifiable "hundreds of households" figure was correctly removed rather than mis-attributed. The Epoch AI source is titled "Trends in Machine Learning Hardware," a defensible org-level Epoch AI citation; flagged below as a soft improvement.
- Synthesis over Summary (major, RESOLVED): New "Choosing Among the Techniques" subsection contrasts the families by binding resource (memory-bound vs compute-bound vs communication-bound) and explains when each dominates and how data-efficiency methods compose orthogonally. The section now closes on synthesis rather than a single paper.
- Balance & Currency / house style (major, RESOLVED): All 11 prose "--"/em-dash separators removed. A scan finds no em-dash, en-dash, or prose double-hyphen anywhere in the file; the only "---" remaining are the required YAML frontmatter delimiters on lines 1 and 4.

## Remaining issues after repair
- [minor] Citation Integrity (line 26): The 112 GB total is correct but the parenthetical "7B params * 16 bytes per param for fp32 optimizer states and gradients" still mis-labels the 16 bytes/param breakdown. The 16 bytes/param is the full mixed-precision Adam footprint (fp16 params and grads plus the fp32 master copy and fp32 Adam momentum/variance), not fp32 optimizer states and gradients alone. Restate the parenthetical for precision.
- [minor] Citation Integrity (line 39): Megatron-LM requires two all-reduces per transformer layer in each pass (one for the attention block, one for the MLP block), four total per layer, not "a single all-reduce per layer" per pass. Reword to "one all-reduce per attention or MLP block" or "two all-reduces per transformer layer per pass."
- [minor] Citation Integrity (line 16): micikevicius2022fp8 ("FP8 Formats for Deep Learning") primarily proposes and validates the E4M3/E5M2 FP8 formats; "demonstrated that training with 8-bit floating point is feasible" slightly overstates its central contribution. Reword toward "introduced standardized FP8 formats and showed training viability."
- [soft] epoch2023trends is an org-level Epoch AI "Trends in ML Hardware" entry rather than a dedicated GPT-4 compute estimate. Acceptable as-is; a more specific Epoch AI GPT-4 FLOP citation would be stronger if available.

These are minor technical-precision wordings that do not undermine any core claim; the three major issues from the original review are fully resolved.
