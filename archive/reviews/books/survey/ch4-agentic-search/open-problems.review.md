# Review: books/survey/ch4-agentic-search/open-problems.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage Completeness: 3, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 4, Problem Formulation & Evaluation Rigor: 3

## Re-review scores
Scope & Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Evaluation Rigor: 4

## Verification
- Em-dashes / "--": none in prose. The only "---" occurrences are the YAML frontmatter delimiters at lines 1 and 4, which are correct.
- Citekeys: all 11 resolve in references.yaml (shi2024trusting, min2023factscore, rashkin2023measuring, ferguson2006optimal, jeong2024adaptive, openai2024o1, shao2024storm, voyager2023, greshake2023more, deepmind2024alphaproof, xin2024deepseekprover). No broken citations.

## Resolved since original review
- [blocker -> fixed] Citation Integrity (o1/AIME): line 22 now reports a single consistent benchmark, "on AIME 2024 math competition problems, GPT-4o scored roughly 12%, while o1 with extended thinking reached about 74% with single-sample pass@1 and 83% with 64-sample consensus." The non-comparable 13% IMO-qualifier figure is gone, and the consensus protocol is distinguished from pass@1.
- [major -> fixed] Scope & Coverage (Deep Research numbers): lines 18 and 22 now use qualitative phrasing ("many search API calls", "large volumes of tokens") with no uncited quantitative claims and no "reportedly" hedge.
- [major -> fixed] Synthesis over Summary (Attribution and Provenance): the section (lines 26 to 33) now anchors each requirement in rashkin2023measuring and min2023factscore, and line 33 closes with a takeaway naming the central tension between passage-level attribution granularity and multi-source synthesis.

## Remaining issues after repair
- [minor] Synthesis over Summary (FActScore redundancy): FActScore is still described twice within the same section opener. Line 10 introduces it ("provides a methodology for measuring factual precision by decomposing outputs into atomic claims"), and line 12 repeats it nearly verbatim ("FActScore (Min et al., 2023) [@min2023factscore] introduced a methodology for decomposing long-form generations into atomic facts"). Merge into one description. The prose-name "(Min et al., 2023)" on line 12 also duplicates the [@min2023factscore] citekey, against the survey citation convention; drop the prose name.
- [minor] Problem Formulation & Eval Rigor (content poisoning): line 54 still asserts the "content poisoning" threat as a distinct named category with no citation, while the adjacent prompt-injection claim is grounded in [@greshake2023more]. Add a source for the content/RAG-poisoning threat model or mark it explicitly as a hypothesized extension.
- [minor] Taxonomy Quality (uncited directions): Multi-Modal Agentic Search (lines 35 to 42) and Personalized and Conversational Search (lines 44 to 48) remain bulleted requirement lists with zero citations. Acceptable for an open-problems enumeration, but each would be stronger anchored to at least one cited example of current limited work to distinguish it from speculation.

These remaining items are all minor and non-blocking. The gating Taxonomy Quality dimension passes, the citation-integrity blocker and both majors are resolved, and the section is publishable. Verdict: ACCEPT, with the three minors recommended as a light follow-up pass.
