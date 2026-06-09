# Review: books/survey/ch2-world-models/open-problems.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Verification of the revision
- Em-dashes / "--": Body is clean. The only "--" tokens are the two YAML frontmatter delimiters on lines 1 and 4. Verified by scan for em-dash, en-dash, and double-hyphen.
- Citekeys: All 16 in-text citekeys resolve against references.yaml (alonso2024diffusion, hafner2022director, hansen2024tdmpc2, hoffmann2022training, janner2019when, kaplan2020scaling, ke2019modeling, kipf2020contrastive, lam2023graphcast, lecun2022path, pathak2022fourcastnet, pearl2009causality, schrittwieser2020mastering, wu2023daydreamer, wu2023slotformer, zhao2020sim). None broken.
- LeCun fix (major, was Citation Integrity): RESOLVED. Line 38 now reads "LeCun (2022) [@lecun2022path]" and the bib entry lecun2022path (line 1478) is the genuine "A Path Towards Autonomous Machine Intelligence" position paper. The chapter no longer relies on the mislabeled duplicate lecun2024sora_critique. In-text year matches the cited source.
- MBPO fix (major, was Synthesis over Summary): RESOLVED. Line 10 now reads "short branched rollouts whose length follows a schedule, typically 1 to 5 steps," replacing the unsupported "at most 15 steps." The number now matches MBPO's canonical 1-to-5 linear rollout schedule. The file also uses citekey janner2019when (a valid entry), so the compounding-error argument is correctly anchored.

## Remaining minor issues (non-blocking)
- [minor] Problem Formulation & Eval Rigor: Line 10 still states the per-step error grows as "O(epsilon^H) in the worst case" without a citation. For epsilon<1 this expression shrinks rather than diverges; the intended claim is per-step amplification by a Lipschitz/gain factor. ke2019modeling supports compounding in general but not this specific asymptotic form. Restate as a Lipschitz-gain amplification or cite a source.
- [minor] Synthesis over Summary: Line 12 keeps the hedged conjecture that diffusion world models "may compound errors differently" with no grounded finding from alonso2024diffusion (DIAMOND). Either cite a concrete comparative result or mark it explicitly as an untested hypothesis.
- [minor] Scope & Coverage: Line 16 names "Genie, Sora" as evidence without inline [@citekey] anchors, though bruce2024genie and a Sora entry exist in references.yaml. Add anchors at first invocation per survey convention.

## References.yaml hygiene (left for human, out of scope for this file)
- lecun2024sora_critique (line 4674) remains a verbatim duplicate of lecun2022path (same title, author LeCun, OpenReview URL), just relabeled year 2024. No longer referenced by this file. Repoint it to LeCun's real Feb 2024 Sora critique or delete it.
- janner2019when (line 1760) and janner2019trust (line 7483) are duplicate entries for the same NeurIPS 2019 paper. This file uses only janner2019when. Reconcile to avoid double-counting in the chapter bibliography.

## Verdict rationale
Both major blocking issues from the original REVISE are fully resolved with conservative, verifiable edits: the highest-stakes attribution now points to a real, correctly dated source, and the load-bearing comparative number matches the cited paper. Em-dashes are gone and no citekeys are broken. The three remaining issues are minor (informal asymptotic, one hedged conjecture, two missing inline anchors) and do not undermine the chapter's correctness or grounding. ACCEPT, with the minor items and the references.yaml duplicates flagged for a future cleanup pass.
