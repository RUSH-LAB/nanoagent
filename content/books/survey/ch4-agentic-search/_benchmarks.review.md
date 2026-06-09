# Review: books/survey/ch4-agentic-search/benchmarks.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 8
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 3, Balance & Currency: 2, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4 (gate passes), Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Verification of prior fixes
- Em-dashes / double-hyphens: all 8 body occurrences removed. The only remaining "--" tokens are lines 1 and 4, which are the required YAML frontmatter delimiters. No "—" present anywhere in the body. House-style requirement satisfied.
- New citations: openai2024swebenchverified, chen2024rgb, yao2024taubench all resolve in references.yaml with well-formed metadata (type, title, author, year, venue, url). RGB is now cited as [@chen2024rgb] (line 33), Tau-bench as [@yao2024taubench] (line 48), SWE-bench Verified as [@openai2024swebenchverified] (line 44). Every other citekey in the file also resolves.
- Balance & Currency: WebArena (line 39) now reads "At the 2023 release... approximately 14%... gap has since narrowed substantially, with leading agents (for example, IBM CUGA) reaching roughly 60% by 2026." SWE-bench Verified (line 44) now reads "As of late 2024, top agents achieved roughly 50%... by 2026 leading agents have pushed Verified resolve rates well past 70%." OS-World (line 47) now reads "At release in 2024, the best agents achieved only 12.24%... as of 2026, top computer-use agents (for example, Claude Opus and Sonnet) reach roughly the human baseline." All three major currency flags addressed with explicit date qualifiers.
- Problem Formulation & Eval Rigor: the uncited MMLU "2-5%" figure (line 25) is gone, replaced with a qualitative hedged statement ("tends to help most on knowledge-intensive subjects... while offering little benefit on reasoning-intensive subjects").
- Synthesis over Summary: all four benchmark subsections now close with a comparative takeaway naming the tension each group navigates (line 16 Retrieval, line 27 QA, line 35 RAG, line 50 Agent).

## Findings (after re-review)
- [minor] Balance & Currency: line 40 (VisualWebArena) still states "Multimodal agents achieve only 16% success rate" as a static present-tense fact without an "as of 2024" qualifier, inconsistent with the now-dated WebArena, SWE-bench Verified, and OS-World entries in the same section. Non-blocking, but recommend adding a date qualifier for consistency.

## Verdict rationale
All major issues from the original review are resolved: the three missing benchmark attributions now have resolvable citekeys, the stale currency claims carry explicit date qualifiers, the uncited quantitative MMLU claim is softened, every body em-dash is removed, and each benchmark subsection ends with a comparative takeaway. The Taxonomy Quality gate passes (clear, non-overlapping retrieval / QA / RAG / agent grouping plus an evaluation-challenges section). Only one minor consistency nit remains, which does not block acceptance.

## Remaining issues after repair
- [minor] Add an "as of 2024" qualifier to the VisualWebArena 16% figure (line 40) for consistency with the other dated agent benchmarks.
- [carry-over, for human] The 2026 currency figures (WebArena ~60% via IBM CUGA, SWE-bench Verified 70%+, OS-World ~human baseline via Claude Opus/Sonnet) were sourced from the prior reviewer's stated findings and not independently verified in this environment. Consider attaching a primary leaderboard or source citation for the SWE-bench Verified 70%+ figure.
- [carry-over, for human] Run the docs build to confirm the three new citekeys render and that chen2024rgb (AAAI) and yao2024taubench (arXiv) metadata matches the preferred bib style.
