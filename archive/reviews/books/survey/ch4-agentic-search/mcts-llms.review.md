# Review: books/survey/ch4-agentic-search/mcts-llms.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification performed
- Dash check: only the two YAML frontmatter fences on lines 1 and 4 remain. All five prior in-prose double-hyphen violations are gone. emDashCount is 0, in-prose double-hyphen count is 0.
- Citation check: all 13 citekeys resolve against references.yaml (yao2023tree, hao2023reasoning, zhou2024lats, deepmind2024alphaproof, wang2023selfconsistency, lightman2023prm, chen2024cot_decoding, snell2024scaling_testtime, openai2024o1, zelikman2022star, zelikman2024quietstar, shinn2023reflexion, madaan2023selfrefine). No broken citekeys.

## Findings
- [resolved] Taxonomy Quality (gate): The node was renamed to "Search and Self-Improvement at Inference and Training Time" and the intro now states the unifying principle and assigns each family a home. STaR and Quiet-STaR are explicitly flagged as training-time bootstrapping (line 40) rather than inference search. The gate now passes: every method's label matches its node.
- [resolved] Synthesis over Summary: Comparative closing sentences were added to ToT (line 12), RAP (line 16), LATS (line 20), STaR/Quiet-STaR (line 40), Reflexion (line 44), and Self-Refine (line 48). Cross-method synthesis is present on what supplies the value function and search budget (ToT/RAP self-eval plus fixed/adaptive budget vs LATS external feedback) and on structured vs verbal search (Self-Refine single-episode vs Reflexion cross-episode memory). The file now compares rather than merely summarizes.
- [resolved] Balance and Currency: Limitations were added for best-of-N (linear cost scaling, reward hacking on line 28), ToT/RAP and Self-Refine/Reflexion (dependence on a reliable LLM self-evaluator, lines 16/44/48), Reflexion (self-generated unit tests yielding false positives, line 44), and STaR (rationalization reinforcing unfaithful rationales, reliance on answer-checkable problems, line 40). The verified 80%-to-91% pass@1 figure is unchanged.
- [resolved] Scope and Coverage: A one-line scope statement now opens the file (line 8) defining the four sub-families and the unifying principle.
- [minor, open] Problem Formulation and Evaluation Rigor: Line 28 still states "generating 256 solutions and selecting the best via PRM scoring improves accuracy from ~50% to ~78%." The 78% endpoint is verified (Lightman et al., arXiv:2305.20050, report 78.2% best-of-N with the PRM), but the "~50%" baseline and the N=256 figure are not the cited paper's headline result. This is a load-bearing number shared with taxonomy.md; either pin it to the exact base-rate and N or hedge both. Not blocking on its own.
- [minor, open] Cross-file consistency: taxonomy.md node 5 is still labeled "Search with Planning (MCTS + LLMs)" and lists members under that name, while this file's title is now "Search and Self-Improvement at Inference and Training Time." The filename (mcts-llms.md) was also left unchanged. Reconcile the node 5 label with the broader section title so the taxonomy and the section agree. Not blocking.
- [minor, open] Scope gap: recent MCTS-for-LLM works (rStar, AlphaLLM/TS-LLM, ReST-MCTS*) remain absent. AlphaProof (2024) provides one 2024 MCTS-specific anchor, so the gap is acknowledged but not fully closed.

## Decision rationale
All three major findings from the prior round (taxonomy mismatch at the gate, summary-over-synthesis, one-sided coverage) are resolved, and the gate now passes. Remaining items are minor: an unverified base-rate/N pair on a single sentence, a cross-file label sync, and an optional currency gap. None warrant another revision cycle, so the verdict is ACCEPT with these items noted for a light future touch-up.

## Remaining issues after repair
- Line 28: hedge or pin the "~50%" baseline and the N=256 figure to the exact source (shared with taxonomy.md).
- Reconcile taxonomy.md node 5 label and the mcts-llms.md filename with the new broader section title.
- Optionally add a 2024 MCTS-specific method (rStar, AlphaLLM/TS-LLM, or ReST-MCTS*) to close the currency gap.
