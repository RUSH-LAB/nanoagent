# Review: books/survey/ch2-world-models/benchmarks.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Verification of prior repairs
- [resolved] The EfficientZero claim now reads "the first method to surpass average human performance on Atari 100k (~194% mean, ~109% median human-normalized) [@ye2021mastering]" (line 10). The prior "superhuman performance on 26/26 games" overstatement is gone.
- [resolved] The DreamerV3 score now reads "~1.10 human-normalized mean score (1.097 in the DIAMOND comparison table) [@hafner2023mastering, @alonso2024diffusion]" (line 10). The unreconcilable "~1.19" is corrected and the value is attributed to the DIAMOND comparison table.
- [verified] All citekeys used in the file resolve in references.yaml: kaiser2020model, hafner2023mastering, alonso2024diffusion, ye2021mastering, tassa2018deepmind, hafner2020dream, hafner2021mastering, hansen2024tdmpc2, yu2020metaworld, savva2019habitat, dosovitskiy2017carla, james2020rlbench, srivastava2022behavior, brohan2023rt, schrittwieser2020mastering. No broken citekeys.
- [verified] Zero em-dash characters and zero prose "--". The only "--" occurrences are the YAML frontmatter delimiters (lines 1 and 4), which are required.
- [partial] Several previously uncited benchmark entries (CALVIN line 21, RoboNet/Something-Something/Kinetics line 32, PhysBench line 33) now carry an explicit "Citation ... remain to be added; no headline world-model number is established here" disclaimer and the unverifiable PhysBench capability framing is softened. This is an honest, non-fabricating mitigation, but it does not close the underlying citation gap.

## Findings still open
- [major] Problem Formulation & Eval Rigor: FVD (line 30), SSIM/PSNR/LPIPS (line 31), and Atari 200M (line 12) still carry no citation and, unlike CALVIN/RoboNet/PhysBench, no "to be added" disclaimer either. Named metrics and benchmarks in a survey table should have primary citations (FVD: Unterthiner et al. 2018; SSIM: Wang et al. 2004; LPIPS: Zhang et al. 2018). Add verified references.yaml entries and cite, or add the same disclaimer used elsewhere for consistency.
- [minor] Synthesis over Summary: The Robotics and Video-Prediction subsections remain annotated-bibliography style (one descriptive sentence per benchmark) with no comparative takeaway closing each group. Add one synthesis line per subsection naming what distinguishes the benchmarks and which capability gap each targets.
- [minor] Citation style consistency: BEHAVIOR-1K (line 25) still uses inline "Srivastava et al. (2022) [@srivastava2022behavior]" attribution, inconsistent with the bare [@key] style used elsewhere on the page. The references.yaml entry is year 2022 / venue CoRL with a url pointing to arXiv:2403.09227 (a 2024 revision); the year/url mismatch should be reconciled. Normalize to bare [@srivastava2022behavior].
- [minor] Problem Formulation & Eval Rigor: The DMControl efficiency claim "DreamerV3 matching model-free methods at 1M steps while requiring only 100K steps for most tasks [@hafner2020dream, @hafner2021mastering, @hafner2023mastering]" (line 14) bundles a specific quantitative result under three Dreamer citations. Attribute the 100K-step DMControl figure to the specific Dreamer version (V3) and table so the number is traceable.

## Verdict rationale
Both citation-integrity blockers are resolved and the Taxonomy Quality gate passes, so the draft clears the hard gates and is no longer a REJECT. However, real (non-blocking) content gaps remain: uncited metrics/benchmarks without disclaimers (FVD, SSIM/PSNR/LPIPS, Atari 200M), missing per-subsection synthesis, an inconsistent inline citation with a year/url mismatch, and an untraceable DMControl number. These keep the draft at REVISE rather than ACCEPT.

## Left for human
- Adding primary-source references.yaml entries for the named metrics/benchmarks (FVD, SSIM/PSNR/LPIPS, CALVIN, PhysBench, RoboNet/Something-Something/Kinetics, Atari 200M) requires inventing new citekeys with verified author/year/venue/url, which a human should supply to avoid fabrication. Suggested anchors: CALVIN (Mees et al. 2022), FVD (Unterthiner et al. 2018), SSIM (Wang et al. 2004), LPIPS (Zhang et al. 2018), Something-Something (Goyal et al. 2017), Kinetics (Kay et al. 2017), RoboNet (Dasari et al. 2019), PhysBench (relevant 2024/2025 paper).
- Reconcile the BEHAVIOR-1K year/url discrepancy (2022 CoRL entry vs arXiv:2403.09227 2024 revision) in references.yaml.

## Remaining issues after repair
- Uncited metrics/benchmarks without disclaimers: FVD, SSIM/PSNR/LPIPS, Atari 200M.
- No per-subsection comparative takeaway in Robotics and Video-Prediction sections.
- BEHAVIOR-1K inline citation style and year/url mismatch.
- DMControl 100K-step result not attributed to a specific Dreamer version/table.
