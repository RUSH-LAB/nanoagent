# Review: books/survey/ch5-randomized-signal/wavelet-multiresolution.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 7
- Broken citekeys: []

## Original scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 2, Citation Integrity: 3, Balance & Currency: 2, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Findings (this pass)
- [resolved] Citation Integrity: DWSR, Wavelet-SRNet, SWAGAN, and WaveDiff now carry resolving [@guo2017dwsr], [@huang2017waveletsrnet], [@gal2021swagan], [@phung2023wavediff], all present in references.yaml. gal2021swagan correctly records arXiv:2102.06108.
- [resolved] House style: all seven prose double-hyphen dashes removed; only the two YAML frontmatter delimiter lines remain, which are required syntax.
- [resolved] Balance & Currency: the Wavelet-Integrated section now states the costs each family pays (fixed bases underperform learned filters at scale, separable 2D DWT directional limits, boundary artifacts), removing the one-sided framing.
- [resolved] Synthesis over Summary: the annotated list now closes with a comparative takeaway naming when wavelet integration helps (high-frequency detail, sparsity, parameter and memory efficiency) versus the price it pays (fixed separable basis constrains directional and large-data expressiveness).
- [improved] Synthesis over Summary: the WaveMix takeaway is now mechanism-grounded (fixed DWT replaces learnable mixing weights) and states when it helps versus learned attention, but still lacks a concrete accuracy or parameter number against a named baseline and dataset.
- [open, minor] Citation Integrity: Meyer (1992) is still credited for the MRA foundation with no [@citekey] while Mallat (1989) gets one (line 45). Add a Meyer citation or drop the unattributed name.
- [open, minor] Balance & Currency: "deep CNNs can be viewed as learning improved versions of scattering transforms" (line 12) is still stated as fact rather than flagged as a contested interpretive framing from bruna2013invariant.
- [open, minor] Problem Formulation & Eval Rigor: "scattering coefficients outperform MFCCs for music genre classification and phoneme recognition" (line 12) still gives no metric, dataset, or number, so the comparison is not checkable.
- [open, minor] Citation Integrity: the ~80% CIFAR-10 linear-classifier figure (line 12) is still attributed to oyallon2017scaling; the originating number may trace to earlier scattering work (Oyallon and Mallat 2015). Worth verifying to avoid telephone-game attribution.

## Verdict rationale
Every major finding from the prior pass is resolved. The four uncited load-bearing primary works now have resolving citekeys that exist in references.yaml, the balance dimension is satisfied with stated per-family limitations, both flagged sections now carry comparative takeaways, and all prose dashes are gone. What remains are four minor, non-blocking issues (one missing secondary attribution, one framing hedge, two unquantified comparisons) plus the human-only request for exact WaveMix numbers. None of these undermine correctness or traceability of the core claims, so the chapter clears ACCEPT with the minors recorded for a later polish pass.

## Remaining issues after repair
- Meyer (1992) MRA attribution lacks a [@citekey].
- bruna2013invariant "CNNs as improved scattering transforms" stated as fact, not hedged as a perspective.
- "outperform MFCCs" claim lacks metric/dataset/number.
- ~80% CIFAR-10 scattering figure attribution to oyallon2017scaling should be verified against Oyallon and Mallat 2015.
- WaveMix takeaway still qualitative; concrete accuracy/parameter figures vs a named baseline left for a human.
- Citation metadata (URL/arXiv IDs) for guo2017dwsr, huang2017waveletsrnet, phung2023wavediff not yet added.
