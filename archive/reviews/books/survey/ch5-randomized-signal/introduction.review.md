# Review: books/survey/ch5-randomized-signal/introduction.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 13
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved][major] Balance & Currency / house style: The original used the "--" double-hyphen 13 times across the prose, violating the explicit CLAUDE.md rule ("Avoid using -- in writing"). On re-review the file contains zero prose "--" and zero em-dashes; the only remaining "--" are the two YAML frontmatter delimiters on lines 1 and 4, which are structural, not prose. This was the dominant fixable defect and it is now fixed.
- [minor][open] Synthesis over Summary: Line 12 credits three named systems (Performer, SLIDE, reservoir sampling) to the pair [@achlioptas2003database, @liu2022random], which covers database-friendly random projections and a random-features survey; neither is the originating Performer, SLIDE, or reservoir-sampling paper. The primary citekeys exist in taxonomy.md (choromanski2021rethinking, chen2020slide, vitter1985random). Cite those originating papers here, or drop the parenthetical system names so the citation matches the claim. Non-blocking: the intro intentionally points to deep-dive files for primary sources.
- [minor][open] Balance & Currency: The newest citation in this 2026 chapter intro is tancik2020fourier (2020). For a fast-moving area (spectral analysis of attention, Fourier neural operators) the framing reads slightly pre-2021. A brief preview of 2022 to 2025 developments would freshen the frontier; the deep-dive files (e.g. taxonomy.md cites su2024roformer) already cover them. Non-blocking.
- [minor][open] Problem Formulation & Eval Rigor: Line 14 states the FFT reduced the DFT from O(n^2) to O(n log n) as inline plain text without a citation, while neighboring historical results are partly cited. Add a Cooley-Tukey citekey or note explicitly that the historical attributions are uncited context, for consistent grounding. Non-blocking.

## Changes made
None in this pass. The revision under review already removed all 13 prose "--" occurrences and the file is clean. Citekey resolution was re-verified: all 14 citekeys (achlioptas2003database, alon2016probabilistic, daubechies1992ten, dong2021attention, halko2011finding, indyk1998approximate, liu2022random, mallat1989theory, mallat2016understanding, mitzenmacher2017probability, rahimi2007random, tancik2020fourier, vershynin2018high, woodruff2014sketching) resolve in references.yaml.

## Left for human
- None

## Remaining issues after repair
- All open items above are minor and non-blocking: the line-12 system-name vs citation mismatch, the pre-2021 currency framing, and the uncited FFT complexity attribution. None block ACCEPT; they can be addressed in a later polish pass if desired.
