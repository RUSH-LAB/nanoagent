# Review: books/survey/ch5-randomized-signal/sketching-streaming.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Evaluation Rigor: 3

## Re-review scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 3, Problem Formulation & Evaluation Rigor: 4

## Findings
- [resolved] Citation Integrity (Ivkin 2019): Line 16 now cites CountSketch (not Count-Min) and explains the linearity/mergeability and L2-norm requirements. references.yaml confirms ivkin2019communication is "Communication-efficient Distributed SGD with Sketching" (Sketched-SGD). Correct.
- [resolved] Citation Integrity (Spring and Shrivastava 2019): Section retitled "CountSketch for Optimizer-State Compression" (lines 19-21); now describes compressing Adam moment state for memory savings (~25%), not gradient communication. Matches the cited paper "Compressing Gradient Optimizers via Count-Sketches". Correct.
- [resolved] Taxonomy Quality: Gradient sketching now has a single home. The bullet on line 16 forwards to "Applications to Distributed Training" (line 44), which names Sketched-SGD as the canonical communication-compression result. Spine is MECE.
- [resolved] Problem Formulation and Eval Rigor: Uncited quantitative claims (top-1%/99% of L2 norm, 90% of energy, 100-1000x) removed or softened to qualitative statements about approximate sparsity (lines 21, 44).
- [resolved] Balance and Currency (1-bit Adam): Line 46 corrects the mechanism to error-feedback quantization and explicitly distinguishes it from sketching; the unsupported 5x figure and the DALL-E sentence are removed.
- [minor, open] Balance and Currency: Named systems "DeepSpeed's 1-bit Adam and 0/1 Adam" (line 46) remain uncited. No matching key exists in references.yaml, so this was correctly left for a human rather than fabricated. Limitations coverage is improved (Count-Min overestimation bias on line 12, heavy-entry recovery on line 44) but still thin; newest substantive citation is 2021 for a 2026-dated chapter.
- [minor, open] Synthesis over Summary: The "Fair sampling" bullet (line 37) still asserts representativeness "even when the distribution shifts over time," which mildly overstates uniform reservoir sampling's guarantee (which assumes a fixed underlying distribution). Recommend qualifying.

## Verdict rationale
All blocker and major findings from the original review are resolved and verified against references.yaml and the paper titles. The two citation-integrity blockers (Ivkin method confusion, Spring/Shrivastava mischaracterization) are fixed correctly, the taxonomy is now single-homed, and the uncited production claims are removed or corrected. Em-dashes are fully eliminated (only YAML frontmatter delimiters remain). The remaining items are minor (one uncited named-system reference correctly deferred to a human, thin limitations/currency, one slightly overstated reservoir-sampling bullet) and do not block acceptance.

## Remaining issues after repair
- Add a primary citation for DeepSpeed 1-bit Adam / 0-1 Adam to references.yaml and cite it on line 46, or remove the named systems.
- Qualify the "Fair sampling" bullet (line 37) so it does not imply uniform reservoir sampling corrects for distribution shift.
- Consider broadening limitations coverage per family and adding more recent (post-2021) citations to strengthen currency.
