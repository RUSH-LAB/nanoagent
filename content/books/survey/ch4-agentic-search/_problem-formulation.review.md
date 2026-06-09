# Review: books/survey/ch4-agentic-search/problem-formulation.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 3, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Verification
- All 11 citekeys resolve in mochi-lab/references.yaml: sutton2018reinforcement, gao2023enabling, liu2023evaluating, rashkin2023measuring, lightman2023prm, asai2024selfrag, jiang2023flare, ferguson2006optimal, min2023factscore, wei2024longform, jeong2024adaptive.
- wei2024longform entry is present and well-formed (Wei et al., "Long-form factuality in large language models", with full author list).
- No prose em-dashes or "--" remain; the only "--" matches are the YAML frontmatter delimiters on lines 1 and 4. The minus sign in the objective formula on line 16 is preserved as a genuine operator.

## Resolved since prior review
- [major, Citation Integrity] SAFE claim now cited [@wei2024longform] with concrete figures (~72% agreement with crowdsourced annotators; 76% win on a 100-case disagreement subset). The unsupported "superhuman agreement" framing is gone.
- [major, Eval Rigor] OpenAI Deep Research operational numbers (line 58) are now explicitly labeled an illustrative estimate, with a note that these systems do not publish per-query figures.
- [major, Eval Rigor] Cost paragraph (line 58) is now internally consistent: B=100, K=5, 4K tokens, with the 100 x 5 x 4K = 2M-input-token arithmetic shown inline, framed as back-of-envelope, and the assumed price stated ("a few dollars per million input tokens").

## Remaining issues after repair
- [minor] Citation Integrity, line 40: "process reward models (PRMs) that can evaluate intermediate search steps, not just final outcomes [@lightman2023prm]." lightman2023prm introduces PRMs for math reasoning; the extension to search-step evaluation is the chapter's own inference and still reads as attributed to that paper. Rephrase so the citation supports the PRM concept while the search-step application is flagged as an extrapolation. Non-blocking.
- [minor] Balance and Currency, line 12: "most current approaches rely on LLMs' emergent planning capabilities rather than explicit RL training" remains an uncited, currency-sensitive assertion (RL-trained search agents such as Search-R1 and R1-Searcher are an active 2025 line). Qualify with a date/scope or cite. Non-blocking.
- [minor] Citation Integrity, lines 37-38: the "Completeness" and "User satisfaction ratings" reward proxies are still uncited while listed alongside cited ones; cite each or note that the last two are uncited conventions. Non-blocking.
- [minor] Synthesis over Summary, lines 14-28: the objective and the (S, A, T, R, gamma) tuple still read as a standalone definition dump; one synthesizing sentence tying R or gamma to how specific method families instantiate them would lift this. Non-blocking.

## To confirm before publishing (carried from repair notes)
- Verify the SAFE figures (~72% agreement; 76% win on the 100-case subset) against the published numbers in arXiv:2403.18802.
- Verify "a few dollars per million input tokens" matches the specific frontier model intended, since prices vary by provider and tier.
