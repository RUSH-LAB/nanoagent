# Review: books/math/6-advanced-ml-math/2-diffusion-models.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 5
- Broken citekeys: ["hyvarinen2005estimation","lipman2023flow","liu2023flow","lu2022dpm","nichol2021improved","peebles2023dit","rombach2022ldm","song2021denoising","song2021score","song2023consistency"]

## Original scores
Correctness & Grounding: 3, Motivation & Conceptual Framing: 4, Worked Examples & Illustration: 2, Cognitive Load & Scaffolding: 4, Notation Consistency & Component Discipline: 3, Completeness & Self-Containment: 4

## Re-review scores (after revision)
Correctness & Grounding (gate): 3, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Verification of claimed repairs
- Em-dashes: Confirmed fixed. The only "--" tokens now in the file are the two frontmatter delimiters (lines 1, 3) and the six Markdown table separator rows (lines 43, 74, 166, 179, 218, 284). No prose double-hyphen dashes remain.
- Citekey remap: Confirmed. rombach2022ldm is now @rombach2022high (line 230), which resolves in references.yaml (line 6788).
- Worked Examples: Confirmed. A new "## Worked Examples" section (lines 247 to 277) now precedes the Notation Summary with two Example components. Example 1 (ex-forward-noising) is fully worked with step-by-step alpha, cumulative product, SNR, and closed-form computation; arithmetic verified independently (abar_3 = 0.504, x_3 ~ 2.124). Example 2 (ex-cfg-mixing) is a harder faded-guidance CFG mixing example; arithmetic verified independently (guided prediction (1.00, -0.70) at w = 2). This resolves the major blocker.

## Findings
- [blocker] Correctness & Grounding: Seven citekeys still do not resolve in references.yaml and will render as broken references: hyvarinen2005estimation (line 143), nichol2021improved (line 45), song2021score (lines 159, 171), song2021denoising (lines 181, 191), lu2022dpm (line 182), song2023consistency (line 185), peebles2023dit (line 236). Each names a real paper, so the correct fix is to ADD verified entries to references.yaml, not to delete or remap them. Note: the original sidecar listed lipman2023flow and liu2023flow as broken, but both actually DO resolve (references.yaml lines 3445 and 3458), so the real remaining count is seven, not eight.
- [minor] Correctness & Grounding: The "Squared cosine / quadratic alpha-bar / Used in Stable Diffusion" row (line 46) is still imprecise and uncited. Stable Diffusion 1.x and 2.x use a scaled-linear (linear-in-sqrt-beta) schedule, not a squared-cosine schedule. Correct the description or cite a source.
- [minor] Correctness & Grounding: The 64x dimensionality claim (line 236) still does not match the stated tensor numbers. 256^2 x 3 = 196608 and 32^2 x 4 = 4096 give a 48x ratio, not 64x; the 64x figure is the spatial-only (8x per side) reduction. Reconcile the figure with the channel change (3 to 4) shown, or separate the spatial reduction from the channel change.
- [minor] Notation & Component Discipline: Several load-bearing display equations remain unwrapped while siblings are wrapped in Equation with ids: the VLB decomposition in thm-ddpm-loss (line 109), the tilde-mu formula in thm-forward-posterior (line 95), the CFG-score derivation (line 213), and the flow-matching loss (line 242). For consistent cross-referencing, wrap numbered or load-bearing displays. No correctness issue; the CFG score derivation is self-consistent with the (1+w) convention in eq-cfg.

## Decision rationale
The major Worked Examples blocker is resolved and all five prose em-dashes are gone, so the draft has moved well off REJECT. However, the gate dimension (Correctness & Grounding) still carries seven broken citekeys that will render as broken citations, plus two uncorrected minor accuracy issues. Broken references keep this below the ACCEPT bar, so the verdict is REVISE: the remaining work is bounded and mostly lives in references.yaml plus two small in-file corrections.

## Remaining issues after repair
- Add seven verified bibliographic entries to references.yaml: hyvarinen2005estimation (Hyvarinen 2005, score matching, JMLR), nichol2021improved (Nichol and Dhariwal 2021, Improved DDPM, cosine schedule), song2021score (Song et al. 2021, Score-Based Generative Modeling through SDEs; distinct from the existing song2019score), song2021denoising (Song et al. 2021, DDIM), lu2022dpm (Lu et al. 2022, DPM-Solver), song2023consistency (Song et al. 2023, Consistency Models), peebles2023dit (Peebles and Xie 2023, DiT). Do not remap song2021score to song2019score; they are different papers and remapping would mis-attribute the SDE result.
- Correct or cite the "Squared cosine / Stable Diffusion" schedule row (line 46).
- Reconcile the 64x compression figure with the 196K to 4K numbers (line 236).
- Optionally wrap the four remaining load-bearing display equations (lines 95, 109, 213, 242) in Equation components with ids for consistent cross-referencing.
