# Review: books/survey/ch1-continual-learning/problem-formulation.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 5, Synthesis over Summary: 4, Citation Integrity: 3, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 5, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 5, Problem Formulation & Eval Rigor: 4

## Verification performed
- Re-read the full file independently.
- Scanned for em-dash and double-hyphen substitutes: none found (all 3 prior occurrences on lines 14, 34, 45 are gone).
- Resolved every citekey in the file against mochi-lab/references.yaml: all 16 present (lopezpaz2017gradient, delange2021continual, diaz2018dont, vandeven2019three, vandeven2022three_types, kirkpatrick2017overcoming, zenke2017continual, masana2023class, aljundi2019online, caccia2022new, aljundi2019taskfree, lee2020neural_cl, grossberg1980how, mermillod2013stability, chaudhry2018riemannian, hsu2018reevaluating).

## Findings
- [resolved, major] Citation Integrity: the Evaluation Metrics lead-in (line 38) now attributes Average Accuracy, Backward Transfer, and Forward Transfer to Lopez-Paz and Ranzato (2017) with [@lopezpaz2017gradient] as the priority citation, keeping the two surveys (@delange2021continual, @diaz2018dont) as secondary. This fixes the prior telephone-game attribution. Confirmed lopezpaz2017gradient exists in references.yaml.
- [resolved] Balance & Currency: the three " -- " em-dash substitutes (formerly lines 14, 34, 45) have been replaced; the prose reads cleanly with commas and colons. House rule now satisfied.
- [minor, open] Problem Formulation and Eval Rigor: the Forgetting Measure on line 44 still reads FM = (1/(T-1)) * sum_{i=1}^{T-1} max_{t in {1,...,T-1}} (a_{t,i} - a_{T,i}). The inner maximum should range over checkpoints after task i was learned, t in {i,...,T-1}, not the full {1,...,T-1}, to match Chaudhry et al. (2018) Riemannian Walk and to avoid undefined pre-training checkpoints. Non-blocking but worth a one-token fix.
- [minor, open] Citation Integrity: the Task-IL "near-zero forgetting" claim on line 12 still cites only the method papers (@kirkpatrick2017overcoming, @zenke2017continual). The empirical Task-IL-versus-Class-IL gap was measured by comparative evaluations; adding @vandeven2019three or @hsu2018reevaluating (both already in references.yaml) would let the empirical claim trace to a source that measured it. Non-blocking.
- [minor, open] Scope & Coverage: no explicit PRISMA-style in-scope / out-of-scope sentence in this file. The chapter index.md describes coverage but does not delimit excluded areas (continual RL, continual self-supervised). A single boundary sentence would close the silent-gap concern. Non-blocking.

## Changes made
None in this pass. The prior revision already removed all em-dashes and applied the major citation-integrity fix; both were independently verified here.

## Left for human
- Optional FM index-range tightening (line 44), eval-citation addition for the Task-IL claim (line 12), and an explicit scope boundary sentence. All three are minor and do not block acceptance.

## Remaining issues after repair
- Three minor, non-blocking items listed above (FM max range, Task-IL eval citation, explicit scope boundary). None affect correctness of the major claims, citations, or formatting.
