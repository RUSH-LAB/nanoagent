# Review: books/survey/ch5-randomized-signal/fourier-spectral.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 7
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance and Currency: 2, Problem Formulation and Evaluation Rigor: 3

## Re-review scores (post-revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings (status after revision)
- [resolved] Balance and Currency (FNet): Line 24 now carries the balancing caveats. The 8-point GLUE gap is called out as substantial, the speedups are scoped to sequence length 512, and the TPU quadratic-DFT-below-4,096-tokens detail is stated. The headline is reframed as regime-specific evidence rather than a uniform attention replacement. Promotional framing removed.
- [resolved] Balance and Currency (FourCastNet): Line 28 now qualifies the 45,000x speedup as a node-hour compute basis vs ECMWF IFS, scopes "comparable" accuracy to large-scale variables at short lead times, and notes underperformance at longer ranges. Currency addressed by acknowledging GraphCast (cited @lam2023graphcast), Pangu-Weather, and spherical Fourier neural operators.
- [resolved] Synthesis over Summary (attention spectrum-to-behavior): Line 16 now explicitly frames the sharp-selector vs smooth-aggregator mapping as "a hypothesis rather than an established result" and notes no systematic verifying study is known. The anti-telephone concern is addressed.
- [resolved] Problem Formulation and Evaluation Rigor (1/f^2, text, physics): Line 34 attributes the 1/f^2 natural-image result to the natural-image statistics literature (Field 1987; Ruderman 1994) by name and downgrades the text and physics claims to "informal generalizations rather than precisely established results." Hedging is now explicit.
- [resolved] Synthesis over Summary (implicit regularizer): Line 34 reframes the closing claim as "one hypothesis (consistent with, but not strictly proven by...)" grounded in the cited NTK (@jacot2018neural) and rahaman2019spectral work, and labels the mechanism "a plausible account rather than a settled result."
- [resolved] Balance and Currency (FNO 1000x): Line 30 retains the figure. The minor recommendation to tighten to "up to three orders of magnitude" or flag it as inference-time was not applied, but the figure verifies as defensible and the claim is no longer the section's load-bearing framing. Non-blocking.
- [partially resolved] Synthesis over Summary (FNet vs AFNO contrast): The FNet section (line 24) now closes with a signal-processing synthesis sentence, and AFNO (line 28) is explicitly contrasted with FNet's fixed FFT ("Unlike FNet's fixed FFT, AFNO learns channel-mixing weights in the frequency domain"). The expressiveness-vs-efficiency tradeoff is conveyed. Adequate.
- [resolved] Citation Integrity / House style: All 7 prose "--" occurrences removed (verified: only the two frontmatter "---" delimiters remain; no em-dash or en-dash characters present). All 13 cited citekeys resolve to top-level keys in references.yaml.

## Verdict rationale
Every major finding from the original review is resolved. The setting-blind cheerleading on FNet and FourCastNet is gone, the two uncited interpretive generalizations are now explicitly marked as hypotheses, the empirical 1/f^2 claim is attributed, and house style is clean. The remaining items are honest "left for human" bib-entry gaps (in-text name attributions without citekeys), which are improvements rather than correctness defects and do not block acceptance.

## Remaining issues after repair
- [minor, non-blocking] Field (1987) and Ruderman (1994) are attributed by name (line 34) but have no field1987 / ruderman1994 entries in references.yaml. A human should add the bib entries and convert to @-citations.
- [minor, non-blocking] Pangu-Weather and spherical Fourier neural operators (line 28) are named but uncited. A human should add entries (e.g. bi2023pangu, bonev2023spherical) and cite them.
- [minor, non-blocking] The FNet TPU quadratic-DFT-below-4,096-token threshold and the FourCastNet node-hour basis / lead-time regime were taken from the reviewer's stated verified facts, not independently re-verified against the source papers. A human with the papers open may want to confirm exact phrasing.
- [optional] FNO 1000x (line 30) could be tightened to "up to three orders of magnitude" or noted as inference-time; left as-is and defensible.
