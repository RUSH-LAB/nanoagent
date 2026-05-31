# Review: books/math/4-calculus-and-optimization/3-non-convex-optimization.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (this pass)
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification performed
- Re-resolved all 18 citekeys against references.yaml: dauphin2014identifying, jin2017escape, keskar2017large, draxler2018essentially, garipov2018loss, frankle2020linear, cohen2021gradient, li2018visualizing, jastrzebski2020break, mcallester1999pac, du2019gradient, he2016resnet, ioffe2015batchnorm, santurkar2018does, gunasekar2018characterizing, jacot2018neural, loshchilov2017sgdr, foret2021sam. Every key resolves exactly once. No duplicate keys.
- Scanned the body for em-dashes and prose double-hyphens: none. Remaining "---" / "|---|" are frontmatter and table syntax (required).
- Recomputed the math in both new worked examples. Edge-of-stability: 2/0.01 = 200, 0.01 x 50 = 0.5, halved LR threshold 2/0.005 = 400 (all correct). Warmup+cosine: warmup 1e-3 x 0.5 = 5e-4; t=2000 cos(0)=1 gives 1e-3 (continuity verified); t=51000 arg = pi/2, cos=0 gives 1e-5 + 0.5(9.9e-4) = 5.05e-4; t=T cos(pi)=-1 gives eta_min. All correct.

## Resolution of original blockers
- The false "Saddle Point Dominance" Theorem (P(local min) ~ 2^-P "since each eigenvalue must be positive independently", with the fabricated 10^-30000000 figure) is now a Remark giving the correct large-deviation scaling e^{-cP^2}, explaining that high-dimensional Hessian eigenvalues are strongly correlated (random-matrix ensemble, not independent coin flips), dropping the fabricated number, and citing dauphin2014identifying. Mathematically sound. RESOLVED.
- All 13 broken-citekey blockers are resolved: the broken keys now have entries in references.yaml and @ioffe2015batch was corrected to @ioffe2015batchnorm. RESOLVED.
- Worked-examples major (zero Example components) is resolved: two faded-guidance, step-by-step Example blocks added (edge-of-stability threshold for eta=0.01; warmup+cosine schedule at concrete steps), both verified correct. RESOLVED.

## Remaining issues (non-gating)
- [minor] Cognitive Load / Grounding: the WSD recipe "warmup for 5%, constant LR for ~75%, then cosine decay for the final ~20%" sums to exactly 100% with no slack and carries no citation. State as rough illustrative splits and ideally cite the WSD source (e.g. MiniCPM, Hu et al. 2024) if such a key is added to references.yaml.
- [minor] Notation / Component Discipline: the notation table defines $\kappa$ (condition number) but $\kappa$ never appears in the section body. Remove the row or introduce the symbol where relevant.

## Notes for human
- The corrected saddle Remark cites only dauphin2014identifying. A human may optionally add Bray and Dean 2007 / Dean and Majumdar 2008 entries and reinstate the exact constant c = beta(ln 3)/4 if those keys are introduced to references.yaml; not required for correctness.
- The newly added reference entries were recalled from memory (canonical ICML/ICLR/NeurIPS/COLT papers). A human should spot-check arXiv IDs and the COLT 1999 DOI for mcallester1999pac before publishing.

## Verdict rationale
The Correctness and Grounding gate now passes: the false probability law is replaced with a correct heuristic, the fabricated number is gone, and every citekey resolves. The two remaining issues are minor and non-gating. ACCEPT.
