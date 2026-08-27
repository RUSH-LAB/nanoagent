# Review: books/survey/ch2-world-models/foundation-world-models.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 12
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 2, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Findings (independent re-review)
- [resolved] Taxonomy Quality (gate): The intro now states an explicit two-axis scheme (prediction space: pixel vs latent; training supervision: action-conditioned vs passive), and a closing "Comparative Analysis" section maps all seven systems onto those axes in a table and applies the fidelity-utility tradeoff lens across all families rather than only DIAMOND. The gate is now passed.
- [resolved] Citation Integrity: The DIAMOND subsection now reports DreamerV3 at approximately 1.097, cites DIAMOND (Alonso et al. 2024) Table 1 as the source, and clarifies that 1.46 is an aggregate human-normalized mean rather than a per-game result.
- [resolved] Citation Integrity: The misattributed lecun2024sora_critique citekey is removed; verified zero occurrences in the file. The Sora world-model debate sentence no longer carries a fabricated source. Note that lecun2024sora_critique still exists in references.yaml as a duplicate of the 2022 JEPA entry, but it is no longer referenced here.
- [resolved] Citation Integrity: The Genie 3 claim drops the unverifiable "photorealistic" qualifier and adds an inline caveat that deepmind2025genie3 is a DeepMind product page, not a peer-reviewed technical report, with specifics to be treated as vendor claims. Verified deepmind2025genie3 resolves in references.yaml (venue "Google DeepMind").
- [resolved] Style: All prose em-dashes removed. The only remaining "--" occurrences are the two frontmatter delimiters and the one markdown table separator row, all legitimate. Zero unicode em-dashes.
- [minor, open] Balance and Currency: V-JEPA 2 (line 48) is still mentioned with no citekey; only V-JEPA via bardes2024vjepa is cited. The unsourced extension claim remains.
- [minor, open] Problem Formulation and Evaluation Rigor: V-JEPA "strong performance on video understanding benchmarks" and "more computationally efficient" (line 48) remain unquantified and setting-blind. No benchmark named, no number or efficiency ratio given.
- [minor, open] Synthesis over Summary: The Cosmos (line 20) and UniSim (line 24) subsections still read as annotated-bibliography paragraphs with asserted takeaways and no comparative numbers, in contrast to the now-grounded DIAMOND subsection. The closing comparative table partially compensates by placing them in the design space.

## Verdict rationale
The two blocking concerns from the original review, the Taxonomy Quality gate and the two major Citation Integrity errors (the DreamerV3 number and the misattributed Sora citekey), are fully resolved, as is the vendor-claim caveat for Genie 3 and the house-style em-dash violation. All ten cited citekeys resolve in references.yaml and no fabricated attribution remains. The three open items are all minor (a single unsourced V-JEPA 2 claim, two unquantified V-JEPA assertions, and two still-assertive subsection takeaways) and do not rise to a blocking defect. Verdict: ACCEPT, with the minor items left for a future polish pass.

## Remaining issues after repair
- V-JEPA 2 claim (line 48) lacks a citekey: add a citation or remove the extension claim.
- V-JEPA performance and efficiency claims (line 48) are unquantified: name a benchmark and give at least one number or efficiency ratio.
- Cosmos (line 20) and UniSim (line 24) takeaways remain asserted rather than grounded in a comparative number.
- references.yaml still contains lecun2024sora_critique as a duplicate of the 2022 JEPA entry; no longer used by this file, but a human may want to delete or repoint the stale entry.
