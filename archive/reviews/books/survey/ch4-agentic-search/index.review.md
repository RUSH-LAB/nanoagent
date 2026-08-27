# Review: books/survey/ch4-agentic-search/index.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality (gate): 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Balance & Currency: The three " -- " em-dash substitutes previously on line 8 have been removed. The body paragraph now reads "agentic search, the paradigm in which AI systems actively pursue answers" (comma), and the unifying-principles list is enclosed in parentheses: "the underlying computational principles (search as sequential decision-making, ..., and test-time compute scaling) that unify". This complies with the repo house style (CLAUDE.md: 'Avoid using --'). Verified no double-hyphen remains in the body.
- [minor] Synthesis over Summary: The index.md remains a pure overview that names families and unifying principles without a comparative takeaway of its own. This is acceptable for a landing page since synthesis lives in taxonomy.md, connections.md, and problem-formulation.md. Not blocking. The page would be marginally stronger if it pointed the reader to where the comparative analysis happens, but this is a polish item, not a substance gap.
- [minor] Taxonomy Quality (gate): "(RAG with dense retrieval, REALM, RETRO, Self-RAG, GraphRAG)" lists a technique label ('RAG with dense retrieval') as a sibling of named systems. The sibling taxonomy.md treats RAG as a coherent family with these systems as members, so the spine is sound; only this parenthetical mixes a method label with system names. Consider 'dense-retrieval RAG (REALM, RETRO, ...)'. Not blocking.
- [minor] Scope & Coverage: OpenAI Deep Research and Perplexity are named without citekeys here (and as bare names in self-improving-search.md). For an overview page this is acceptable, but the survey body should ground these commercial systems with a primary technical or product reference, or note they lack peer-reviewed sources. Not blocking for index.md.

## Changes made
None in this pass. The required repair (removal of all three " -- " em-dash substitutes from the single body paragraph on line 8) was already applied in the prior revision. This re-review verified the fix: a comma replaced the first instance and parentheses replaced the paired dashes around the computational-principles list. No content, citations, math, or frontmatter were altered.

## Left for human
- None

## Remaining issues after repair
None blocking. Three minor, non-blocking polish items remain (overview-to-section pointer for synthesis, method-vs-system phrasing in the RAG parenthetical, and missing citekeys for commercial deep-research systems in the survey body). These can be addressed in the body sections during normal editing and do not gate acceptance of this overview page.
