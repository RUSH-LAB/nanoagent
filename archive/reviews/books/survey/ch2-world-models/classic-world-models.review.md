# Review: books/survey/ch2-world-models/classic-world-models.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 10
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Citation Integrity (was blocker): Line 44 now reads "human-level performance on the Atari benchmark (55 games, 200M frames)" reaching "roughly human-level median (gamer-normalized) performance using a single GPU." The incorrect "Atari 100k" claim and the unsupported "above 200% human-normalized score" parenthetical are gone. This matches Hafner et al. 2021 (arXiv:2010.02193). Note that the Atari 100k sample-efficiency regime is still correctly attributed to later transformer-based work in the TransDreamer subsection (line 78), which is consistent.
- [resolved] Synthesis over Summary (was major): A new closing subsection "Synthesis: Tensions Across the Latent-Space Lineage" (lines 88-98) contrasts the families along four axes (latent parameterization, decision use, representation objective, dynamics backbone), names the tension each navigates, and aligns explicitly with the chapter taxonomy. This converts the chronological survey into a comparative one.
- [resolved] Synthesis over Summary (was major): A framing sentence (line 58) opens the post-Dreamer variants cluster and maps each paper (DreamerPro, MWM, Plan2Explore, Director, TransDreamer, SLAC) to the taxonomy axis it pushes on, replacing the bare annotated-bibliography handoff.
- [resolved] Notation/House Style: All 10 in-prose "--" occurrences removed. Only the two YAML frontmatter delimiters (lines 1, 4) remain, which are required.
- [verified] Citation Integrity: CarRacing 867-parameter controller claim (line 18) confirmed against primary source. Accurate.
- [verified] Problem Formulation: Dreamer v1 "20x fewer interactions" and PlaNet "50x fewer" claims confirmed accurate.
- [verified] Citekeys: All 20 citekeys resolve in mochi-lab/references.yaml. No broken keys.
- [minor, open] Citation Integrity: Line 18 "The agent was trained entirely in dreams ... On the CarRacing environment, the dream-trained agent achieved competitive performance." The full dream-training result in Ha and Schmidhuber is the VizDoom Take Cover experiment; the CarRacing controller was trained on real rollouts. The current phrasing reads as if CarRacing itself was dream-trained. A one-clause clarification would tighten this. Non-blocking.

## Changes made
None by this reviewer. All substantive fixes were already applied in the prior revision and are confirmed present and correct.

## Left for human
- Optional: tighten line 18 so the "trained in dreams" claim is attributed to VizDoom Take Cover rather than reading as if CarRacing was dream-trained.
- Optional: a literal comparison table (backbone / latent / objective / benchmark) could complement the prose synthesis, per the author's discretion.

## Remaining issues after repair
One minor, non-blocking phrasing ambiguity on line 18 (CarRacing vs VizDoom dream-training attribution). Does not block acceptance.
