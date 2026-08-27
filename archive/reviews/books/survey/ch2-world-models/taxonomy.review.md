# Review: books/survey/ch2-world-models/taxonomy.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 3
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 2, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 2

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 2 (gate: Taxonomy Quality passes at 3)

## Verified as fixed
- Dashes: zero prose "--" or unicode dash occurrences remain. Only the two YAML frontmatter delimiters (lines 1 and 4) are present, which is correct.
- Dreamer RSSM lineage (line 12): now correctly reads discrete latent spaces (v2) [@hafner2021mastering] and symlog-normalized architecture (v3) [@hafner2023mastering]. The duplicate "(v3)" and skipped v2 are resolved.
- Diffusion uncertainty claim (line 19): softened to "the diversity of samples can be used as a rough uncertainty signal, though sample diversity is not equivalent to calibrated uncertainty and should be interpreted with caution." Acceptable.
- Citation traceability: load-bearing bold-named methods now carry [@citekey] across the prediction-space, generative-paradigm, and application-domain facets (SimPLe, DIAMOND, GameNGen, Sora, MuZero, EfficientZero, IRIS, GAIA-1, MILE, OccWorld, Cosmos, Genie, UniSim, etc.). All 34 distinct citekeys in the file were checked and every one resolves in references.yaml. No broken citekeys.

## Findings (still open)
- [major] Problem Formulation and Evaluation Rigor / Citation Integrity: line 22 was NOT corrected as the prior sidecar claimed. It still reads "from SimPLe's median human-normalized score of approximately 0.144 [@kaiser2020model] to DreamerV3's 1.19 [@hafner2023mastering] to DIAMOND's 1.46 [@alonso2024diffusion]." Two defects persist. (1) The metric is mislabeled "median"; the DIAMOND 1.46 headline and the comparable SimPLe and DreamerV3 figures are mean human-normalized scores, so the label should be "mean". (2) The numbers are wrong: SimPLe should be approximately 0.44 (not 0.144) and DreamerV3 should be approximately 1.12 (not 1.19). The prior "Changes made" note asserted these were fixed, but the file on disk does not reflect that edit. This is a non-comparable-protocol error in the evaluation-rigor dimension and must be corrected before acceptance.
- [minor] Problem Formulation and Evaluation Rigor: line 22 "100k environment steps, approximately 2 hours of real-time play" still omits the frame-skip (4) assumption that makes the 100k-steps-to-2-hours conversion hold. State or cite the frame-skip protocol.
- [minor] Balance and Currency: family descriptions remain advantage-led for some families. Pixel-space (line 11) and latent-space (line 12) now carry limitations, but the hybrid/JEPA description (line 13) still omits the representation-collapse risk of JEPA-style self-supervised objectives. Add a limitation to balance it.
- [minor] Taxonomy Quality (gate): the faceted taxonomy is defensible and honest about orthogonality, and the closing trend sentence (line 34) helps. The gate passes, but a comparative cross-facet table (method x prediction-space x paradigm x tradeoff) would strengthen the chapter beyond the current parallel-list form.
- [minor] Synthesis over Summary: the "By application domain" facet still reads largely as one annotated sentence per system without a per-subsection comparative takeaway naming the tension each domain navigates (e.g., fidelity vs. controllability).

## Recommendation
REVISE. The dash, lineage, diffusion-uncertainty, and citation-traceability fixes are real and verified, lifting Citation Integrity from 2 to 4. However the line 22 Atari metric defect (mislabeled "median" plus wrong SimPLe 0.144 and DreamerV3 1.19 figures) remains in the file despite being reported as fixed, holding Problem Formulation and Evaluation Rigor at 2. One concrete numeric and labeling edit on line 22 is the blocking item; the remaining issues are minor polish.

## Remaining issues after repair
- Line 22 Atari progression: relabel "median" to "mean", correct SimPLe to ~0.44, correct DreamerV3 to ~1.12. (Blocking.)
- Line 22: add frame-skip (4) qualification to the 2-hours conversion.
- Line 13: add a limitation (e.g., representation collapse) to the hybrid/JEPA family.
- Optional: add a cross-facet comparison table and per-domain comparative takeaways.
