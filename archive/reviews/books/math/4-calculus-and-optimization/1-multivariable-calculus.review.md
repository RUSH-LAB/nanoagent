# Review: books/math/4-calculus-and-optimization/1-multivariable-calculus.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 0 (prose); remaining matches are markdown table delimiters only
- Broken citekeys: [] (all previously broken keys now resolve)

## Re-review scores (Rubric B)
Correctness and Grounding: 4 (gate passed), Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior repairs
- [resolved] Five blocker citations: amos2017optnet, bai2019deep, chen2018neural, choromanska2015loss, draxler2018essentially all now resolve in references.yaml (lines 3480-3536) with consistent type/title/author/year/venue/url fields and correct arXiv IDs (1703.00443, 1909.01377, 1806.07366, 1412.0233, 1803.00885). finn2017maml also resolves. No in-text citations were dropped.
- [resolved] Prose "--" removed at the three flagged locations. Line 7 uses a comma, line 52 uses a colon, line 123 was restructured with "so". A scan finds no remaining em-dash or "--" in prose; the only "--" matches are markdown table separator rows (lines 78, 133, 156, 169).
- [resolved] GD convergence-rate notation. Comparison table (line 79) now reads "Linear ($O((1 - 1/\kappa)^t)$ per step)", consistent with the discrete per-step framing of the Newton and L-BFGS rows.
- [resolved] Newton's method contradiction. Line 83 now distinguishes one-step exactness for a strictly quadratic objective from quadratic convergence near a minimum for general smooth f, then notes the $O(n^2)$ memory / $O(n^3)$ compute infeasibility for large networks.

## Remaining issues after repair
- [minor] Correctness and Grounding: Line 134 still labels $H \succ 0$ simply under "Hessian Condition" alongside the local-minimum definition. $H \succ 0$ is the sufficient (second-order) condition for a strict local minimum; a local minimum only requires $H \succeq 0$. Consider relabeling the column or adding "sufficient" to avoid implying equivalence with the definition.
- [minor] Correctness and Grounding: Lines 145-146 present the $\sim 2^{-P}$ saddle-point estimate as if exact. The independent equal-probability model is a heuristic (random-matrix / spin-glass intuition); eigenvalue signs are not independent and the index correlates with loss level. State it as a heuristic and cite Dauphin et al. 2014, which is the standard source and is currently uncited.
- [minor] Worked Examples and Illustration: The section remains symbol-heavy with a single short Example (ex-directional-gradient) and no numeric instantiation. Adding one fully worked numeric example (a concrete f with computed gradient/Hessian and a Newton vs GD step) would strengthen this dimension.

## Verdict rationale
All five citation blockers and the em-dash blocker are cleared, so the Correctness gate now passes and the document is no longer a REJECT. The two major correctness issues were fixed correctly. Three minor items (sufficient-vs-necessary Hessian labeling, heuristic framing plus missing Dauphin et al. 2014 citation, and the thin worked-example coverage) remain open, so the verdict is REVISE rather than ACCEPT.

## Left for human
- Verify the five newly added references.yaml entries against canonical sources before publishing (authors, year, venue, arXiv URLs). Spot check matches well-established facts: amos2017optnet (OptNet, ICML 2017, 1703.00443), bai2019deep (Deep Equilibrium Models, NeurIPS 2019, 1909.01377), chen2018neural (Neural ODEs, NeurIPS 2018, 1806.07366), choromanska2015loss (Loss Surfaces of Multilayer Networks, AISTATS 2015, 1412.0233), draxler2018essentially (Essentially No Barriers, ICML 2018, 1803.00885). One author name was entered in plain ASCII (Gerard Ben Arous); adjust if accented characters are preferred.
