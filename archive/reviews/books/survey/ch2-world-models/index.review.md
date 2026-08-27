# Review: books/survey/ch2-world-models/index.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 100
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 2, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4 (gate passed), Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification of prior fixes
- [resolved] Em-dashes and prose double-hyphens: none remain in any content file. Frontmatter delimiters and the Markdown table separator are correctly preserved.
- [resolved] Citation Integrity (DreamerV2 Atari-100k): the wrong "human-level on Atari 100k / >200%" claim is gone; the chapter now anchors the DreamerV2 lineage to the full Atari setting.
- [resolved] Citation Integrity (EfficientZero 26/26): both reinforcement-learning.md (line 26) and benchmarks.md (line 10) now report mean/median figures (approximately 194 percent mean, 109 percent median; first to surpass average human performance), not the unsourced "26 of 26".
- [resolved] Citation Integrity (SimPLe score in taxonomy.md): line 22 now reads "SimPLe's median human-normalized score of approximately 0.144", replacing the wrong 0.44.
- [resolved] Citation Integrity (MBPO duplicate citekey): both open-problems.md and reinforcement-learning.md now use the single citekey @janner2019when, and the rollout horizon is reconciled to a "schedule, typically 1 to 5 steps".
- [resolved] Scope (PRISMA boundary): introduction.md (lines 28 to 30) now states an explicit in-scope and out-of-scope paragraph naming the excluded areas.
- [resolved] Problem Formulation (uncited benchmarks): CALVIN, RoboNet/Something-Something/Kinetics, and PhysBench in benchmarks.md now carry honest "citation and scale to be added; no headline world-model number established" notes rather than fabricated numbers.
- [verified] Citekey integrity: every citekey used across the ch2 directory resolves to a top-level entry in references.yaml. No broken citekeys.

## Remaining issues after repair
- [blocker] Citation Integrity / Evaluation Rigor: DreamerV3's Atari-100k score is internally inconsistent across the chapter. taxonomy.md line 22 states "DreamerV3's 1.19", while benchmarks.md line 10 states "approximately 1.10 (1.097 in the DIAMOND comparison table)" and foundation-world-models.md line 28 states "approximately 1.097". A reader sees two contradictory numbers for the same metric in the same chapter. Pick one sourced value and make all three files agree.
- [minor] Synthesis over Summary: reinforcement-learning.md line 44 still uses the heading "GenRL: Generative World Models for RL at Scale", but the body describes DIAMOND, STORM, and wu2024pre, never a method called GenRL. Rename the heading (for example "Generative Models as World Models for RL at Scale") or cite the GenRL method the heading names.
- [minor] Balance and Currency: foundation-world-models.md line 48 mentions "V-JEPA 2" with no citekey while every sibling claim in the section is cited. Add the reference or drop the sentence.
- [deferred to human] references.yaml still contains a duplicate entry @janner2019trust identical to @janner2019when. Now unused within ch2; safe to remove after a repo-wide check. Left in place because it is a shared bibliography file.
- [deferred to human] The SimPLe approximately 0.144 value and the benchmark entries (CALVIN, RoboNet/Something-Something/Kinetics, FVD/SSIM/PSNR/LPIPS, PhysBench) still need real originating citekeys and dataset scales; these do not yet exist in references.yaml and must be added by someone who can verify the sources.

## Verdict rationale
All three original citation-integrity blockers and both major findings are resolved, lifting Citation Integrity from 2 to 4 and clearing the gate dimension. The chapter is well-structured, comprehensive, and synthesis-driven. It falls short of ACCEPT because of one live factual contradiction (DreamerV3 1.19 vs 1.097 across three files) that a careful reader would catch, plus two small uncited/mislabeled items. None of these is severe enough for REJECT. Verdict: REVISE.
