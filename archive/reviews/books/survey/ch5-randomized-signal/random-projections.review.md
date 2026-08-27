# Review: books/survey/ch5-randomized-signal/random-projections.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 8
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Verification of prior repairs
- Em-dashes: confirmed clean. Only the two YAML frontmatter "---" fences (lines 1 and 4) remain; no em-dash or "--" appears in the body.
- Citekeys: all 12 keys used in the file (johnson1984extensions, matousek2008variants, larsen2017optimality, donoho2006compressed, candes2006robust, frankle2019lottery, rahimi2007random, rahimi2009weighted, ailon2006fast, le2013fastfood, yu2016orthogonal, choromanski2021rethinking) resolve in references.yaml. The fabricated dasgupta2003elementary attribution has been removed from the body.
- Major finding (fabricated BERT/256-dim claim): RESOLVED. Line 12 now applies the section's own O(log n / eps^2) bound to n = 10^6 and epsilon = 0.05, yielding approximately 5500 dimensions (ln(10^6)/0.0025 is approximately 5526), with the spurious citation dropped.
- Major finding (example not reconciled with the stated bound): RESOLVED by the same rewrite, which now grounds the worked number in the stated formula and notes the practical-vs-worst-case gap.

## Findings (still open after revision)
- [minor] Problem Formulation and Eval Rigor: line 16 still reads "O(k * log(n/k)) measurements ... exponentially fewer than the signal dimension n." O(k log(n/k)) versus n is not exponentially fewer; for a fixed sparsity ratio it is a linear-times-log reduction, at most polynomial in n. Replace "exponentially fewer" with "far fewer" or "linear in k up to a log factor, versus the ambient dimension n."
- [minor] Synthesis over Summary: line 18 states "MRI scan times can be reduced by 4-8x using compressed sensing reconstruction" inside an aside with no citation. Add a primary source (e.g., Lustig et al. on sparse MRI) or soften the figure.
- [minor] Synthesis over Summary: line 20 still asserts the RIP-to-pruning analogy with theorem-like confidence ("the RIP theory guarantees ... providing a theoretical foundation for random-projection-based pruning"). RIP recovery is about reconstructing a sparse signal from linear measurements, not identifying a trainable subnetwork; the lottery-ticket link is suggestive, not a guarantee. Qualify as an analogy or cite a paper that actually establishes RIP-based pruning.
- [minor] Citation Integrity: line 30 attributes the O(1/sqrt(D)) Monte-Carlo rate to rahimi2009weighted (Random Kitchen Sinks). The rate belongs to the uniform-convergence bound in rahimi2007random and is tightened by Sutherland-Schneider 2015. Re-attribute to rahimi2007random or add the Sutherland-Schneider reference.
- [minor] Balance and Currency: line 36 says Orthogonal Random Features achieve "strictly lower variance" without qualification. The guarantee holds for the Gaussian kernel but is not unconditional across all shift-invariant kernels and feature counts. State the regime.

## Verdict rationale
The two major issues that drove the original REVISE (the fabricated BERT/dasgupta2003elementary citation and the unreconciled worked example) are fixed, and all em-dashes are removed, lifting Citation Integrity from 2 to 4. However, five minor accuracy and attribution issues from the original review remain unaddressed, including one quantitatively wrong claim ("exponentially fewer"), one uncited numeric figure (MRI 4-8x), one overstated theorem-like analogy, and two attribution/qualification gaps. These are individually minor but collectively keep the draft below the ACCEPT bar for a survey held to claims-qualified-by-regime. Verdict: REVISE.

## Remaining issues after repair
- Line 16: "exponentially fewer" is quantitatively incorrect; should be "far fewer" / "linear in k up to a log factor."
- Line 18: MRI 4-8x acceleration figure lacks a citation.
- Line 20: RIP-to-pruning analogy overstated as a guarantee; qualify or cite.
- Line 30: O(1/sqrt(D)) rate mis-attributed to rahimi2009weighted; should be rahimi2007random (optionally add Sutherland-Schneider 2015).
- Line 36: "strictly lower variance" needs a stated regime.
