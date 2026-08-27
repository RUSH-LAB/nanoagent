# Review: books/math/2-ml-basics/3-gradient-descent.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 4
- Broken citekeys: ["keskar2017large","goyal2017accurate","nesterov1983method","loshchilov2017sgdr"]

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 2, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 3

## Re-review scores (after revision)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Verification of prior fixes
- [resolved] Correctness and Grounding (gate): All four previously broken citekeys now resolve. keskar2017large, goyal2017accurate, nesterov1983method, and loshchilov2017sgdr are present in references.yaml with verified titles, authors, years, and venues. nesterov1983method correctly omits a url field (the 1983 Doklady paper has no canonical online version); the BibliographyItem renderer guards on entry.url, so it renders cleanly.
- [resolved] Correctness and Grounding: The variance vs second-moment error at line 192 is fixed. The text now says "large gradient magnitude (large RMS, since hat_v is the uncentered second moment, i.e. the mean of squared gradients)" and states explicitly that "Adam normalizes by RMS magnitude, not by variance, so a large but consistent gradient is also damped." Technically correct.
- [resolved] Worked Examples: Two Example blocks added. ex-gd-conditioning (kappa=10 separable 2D quadratic, eta=0.18) shows per-coordinate oscillation vs slow progress; arithmetic verified (steep multiplier -0.8 giving 1, -0.8, 0.64, -0.512; shallow multiplier 0.82 giving 1, 0.82, 0.672, 0.551; 2/L=0.2 divergence threshold correct). ex-adam-first-step shows a numeric first Adam step with bias correction; arithmetic verified (m1=0.01, v1=1e-5, hat_m1=0.1, hat_v1=0.01, step approx eta=1e-3, uncorrected approx 3.2e-3). Both correct, with faded numeric guidance.
- [resolved] House style: No em-dashes or "--" remain in prose. The only "--" matches are frontmatter delimiters (lines 1, 3) and Markdown table separator rows, both required syntax. "1--5%" is now "1 to 5%" (line 255).

## Remaining issues (all minor, none gate-blocking)
- [minor] Correctness and Grounding: Line 48 still reads "The constant $L$ is the largest eigenvalue of the Hessian." For a general L-smooth function this is the supremum over the domain of the spectral norm (largest absolute eigenvalue); exact equality to the top eigenvalue holds only for quadratics. Add "supremum of" and "absolute value of" qualifiers. Not gate-blocking and benign for the convex/quadratic framing used here.
- [minor] Notation Consistency: $v_t$ still denotes both the momentum velocity (eq-momentum) and the Adam second moment (eq-adam-second-moment). The notation table acknowledges both meanings, but the reuse is a genuine within-chapter collision. Renaming Adam's second moment (e.g. $s_t$) would give one symbol per concept.
- [minor] Completeness: The Other Optimizers table lists Adafactor, LAMB, Lion, and Muon with no citekeys, while Adam and AdamW are cited. Add citekeys (or mark out of scope) for grounding consistency.
- [minor] Completeness: The warmup remark (rmk-warmup) still attributes warmup solely to Adam second-moment instability. Warmup also helps plain SGD and the mechanism is debated; softening to "one common explanation" would avoid presenting a contested rationale as settled.

## Verdict rationale
The gate dimension (Correctness and Grounding) now passes: every citation resolves, the substantive Adam variance error is corrected, and the worked-example arithmetic is verified. The page also gained two correct worked examples, satisfying Rubric B's worked-computation requirement. The remaining items are all minor polish (one wording qualifier, one notation collision already documented in the notation table, two grounding/softening nits) and do not block publication. Upgrading from REJECT to ACCEPT.
