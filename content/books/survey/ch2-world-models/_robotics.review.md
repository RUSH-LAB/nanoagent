# Review: books/survey/ch2-world-models/robotics.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 3, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Findings
- [resolved][major] Citation Integrity: The Du et al. (2024) [@du2024video] sentence now accurately describes Video Language Planning as long-horizon visual planning that combines VLMs (policy and value) with text-to-video models (dynamics) via forward tree search executed through goal-conditioned policies. This matches references.yaml (title "Video Language Planning", arXiv:2310.10625, venue ICLR). The earlier year concern is moot: the entry lists venue ICLR 2024, which is the paper's publication venue.
- [resolved][major] Synthesis over Summary: Each system subsection now closes with a comparative takeaway (TD-MPC latent-only planning vs reconstruction Dreamer; DayDreamer breadth vs data efficiency; RoboDreamer single language-conditioned model vs VLP frozen-module composition; GAIA-1 pixel fidelity vs BEV/occupancy planning representations; MILE BEV vs OccWorld 3D), and a closing cross-system representation tradeoff after OccWorld ties the three driving systems together. The section is no longer an annotated bibliography.
- [open][minor] Synthesis over Summary: The MILE superlative ("world model-based planning outperforms reactive policies on the CARLA driving benchmark") still carries no number. Adding the concrete CARLA driving-score / infraction delta would ground the claim.
- [open][minor] Balance & Currency: Limitations improved (TD-MPC noted as unable to render the future; Sim-to-Real notes DayDreamer's real-data-collection cost), but the "foundation world model for robotics is feasible" claim still omits that TD-MPC2's 80+ tasks are all continuous-control sim benchmarks rather than real-world generalization, and DayDreamer's hour-scale results are single-skill.
- [open][minor] Problem Formulation & Eval Rigor: The driving-evaluation subsection names PSNR/SSIM and planning-oriented evaluation but defines no metric formula and gives no benchmark numbers (no nuScenes/CARLA scale or scores for UniAD, BEVFormer, VAD). At least one quantified protocol or table would ground the discussion.
- [open][minor] Taxonomy Quality: "Sim-to-Real Transfer" still sits as a subsection parallel to system families (TD-MPC, DayDreamer, RoboDreamer), mixing organizing principles (systems vs cross-cutting challenges) at one level. Relabeling the section axes or moving it to a challenges subsection would tighten the taxonomy.

## Changes made
None by this reviewer. This is an independent re-review of the already-revised file. The prior revision removed all em-dash / double-hyphen occurrences (only the two YAML frontmatter delimiters on lines 1 and 4 remain), corrected the VLP citation, and added per-family and cross-system comparative takeaways.

## Left for human
- None blocking. The four open minor items (MILE number, foundation-WM limitation caveat, quantified eval protocol, Sim-to-Real taxonomy placement) are quality improvements that can be addressed in a future pass.

## Remaining issues after repair
- MILE comparative claim lacks a concrete CARLA number (minor).
- Foundation-WM / TD-MPC2 feasibility claim lacks the sim-only-benchmark limitation caveat (minor).
- Driving-evaluation subsection lacks any metric formula or benchmark numbers (minor).
- Sim-to-Real subsection mixes systems and challenges at one taxonomy level (minor).
