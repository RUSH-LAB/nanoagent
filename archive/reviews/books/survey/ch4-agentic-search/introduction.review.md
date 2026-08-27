# Review: books/survey/ch4-agentic-search/introduction.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 13
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality (gate): 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [minor] Balance & Currency: "implemented through systems like BM25 [@robertson1995okapi] and TF-IDF, has served as the backbone of web search for decades" -> TF-IDF is not an implementation of the Robertson-Zaragoza probabilistic relevance framework; it is a distinct, earlier weighting scheme. Reword so TF-IDF is listed as a separate classical IR method rather than as an implementation of the probabilistic relevance framework attributed to robertson2009probabilistic. Still present after revision; non-blocking.
- [minor] Synthesis over Summary: "The convergence of four capabilities enables this transformation:" -> The four-capability list (reasoning/planning, tool use, self-evaluation, synthesis) reads as parallel enumeration without a comparative takeaway. Acceptable for an introduction, but add one synthesizing sentence on how the capabilities interact or which is the binding constraint, so the intro previews tradeoffs rather than just listing enablers. Still present after revision; non-blocking.
- [minor] Problem Formulation & Eval Rigor: "the system actively pursues answers through multi-step information-seeking strategies" -> The intro names the core tensions (sequential decision-making, explore-exploit, verification) but defers all formalization. This is appropriate for an introduction since problem-formulation.md exists; no change required to substance, but ensure the cross-reference to problem-formulation.md is explicit so readers know where the formal framework lives. The closing paragraph still does not explicitly point to problem-formulation.md; non-blocking.
- [minor] Scope & Coverage: "A researcher investigating a complex question ("What are the most promising approaches to carbon capture, and what are their economic viability projections?") cannot answer this from a single search query." -> House-style violation now resolved: the prior 13 occurrences of "--" used as prose em-dashes have been removed, satisfying the repo instruction "Avoid using -- in writing."

## Changes made
Confirmed the revision removed all 13 "--" em-dash instances from the prose by restructuring each into parentheticals (carbon-capture example question, tool lists in paragraph 3 and bullet 2, computational-principles aside in paragraph 5) or commas ("all autonomously" and "interactions between them"). The only remaining "---" matches are the YAML frontmatter delimiters on lines 1 and 4, which are required and preserved. Hyphenated compounds like "decision-making" and "explore-exploit" use single hyphens and were left untouched. Verified independently that all 12 citekeys (robertson2009probabilistic, robertson1995okapi, metzler2021rethinking, nakano2021webgpt, singh2025agentic, wang2024survey, qin2023tool, schick2023toolformer, wei2022chain, kojima2022large, zhou2023leasttomost, wang2023selfconsistency) resolve against references.yaml. No citations, math, code, or author voice were altered.

## Left for human
- None

## Remaining issues after repair
- [minor, non-blocking] TF-IDF is grouped as an implementation of the probabilistic relevance framework; should be reworded as a separate classical IR weighting scheme.
- [minor, non-blocking] Four-capability list could add one sentence on how the capabilities interact or which is the binding constraint.
- [minor, non-blocking] No explicit cross-reference to problem-formulation.md where the formal framework lives.
