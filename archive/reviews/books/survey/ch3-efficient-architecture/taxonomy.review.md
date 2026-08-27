# Review: books/survey/ch3-efficient-architecture/taxonomy.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 4
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 3, Synthesis over Summary: 3, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Taxonomy Quality (was major, gate): The flat nine-family list now declares a single organizing principle per level. The intro paragraph names two axes (Axis 1 = model architecture, families 1 through 4; Axis 2 = model lifecycle/deployment, families 5 through 9), and explicit "### Axis 1: Architectural families" and "### Axis 2: Lifecycle and deployment optimizations" headers separate them. The mixed level is now acknowledged rather than implicit. Gate passes.
- [resolved] Taxonomy Quality (was major): Families 2 and 3 are now MECE. Family 2 (SSMs) states the demarcation criterion "a model belongs here when its recurrence is obtained by discretizing a continuous dynamical system," and family 3 (sub-quadratic) explicitly excludes that derivation ("whose efficient form does not arise from a continuous-time state-space derivation"). Both note the boundary is one of derivation and that some models are described as SSM-adjacent in the literature.
- [resolved] Taxonomy Quality (was minor): Both prose "--" occurrences removed. The intro clause was restructured and the MoE/family-4 sentence now uses a colon. The only remaining "--" are the YAML frontmatter delimiters on lines 1 and 4, which are valid syntax. No unicode em/en-dash characters exist in the file.
- [minor, open] Synthesis over Summary: The spine still closes on four qualitative cross-cutting principles (low-rank structure, conditional computation, hardware-algorithm co-design, resource trading) with no comparative table or per-family comparative takeaway. A short table (family vs. complexity vs. tradeoff vs. representative speedup) or a one-line comparative pointer per family would close the taxonomy with grounded comparison rather than a list plus principles. Non-gating; the spine intentionally defers numbers to the deep-dive sections.
- [minor, open] Scope and Coverage Completeness: Line 30 still reads "serving system design (vLLM, SGLang [@zheng2024sglang])." vLLM and "continuous batching" are named as systems/techniques but carry no citekey, while the adjacent SGLang resolves. The PagedAttention paper (kwon2023efficient, which is the vLLM system) is cited one clause earlier for KV-cache; attaching it to vLLM or adding an explicit vLLM citekey would make every named primary system resolve.
- [minor, open] Balance and Currency: Family 3 still claims "competitive perplexity on language modeling" without noting the documented weakness of sub-quadratic/recurrent models on copying and exact in-context retrieval. A one-clause limitation would balance advantages and limitations for that family.

## Citation verification
All 53 citekeys in the file were checked against references.yaml; every one resolves. Note the original review referenced "@zheng2024sglangradixtree" but the file uses "@zheng2024sglang", which is the key present in references.yaml. Broken citekeys: none.

## Verdict rationale
Both gating/major Taxonomy Quality issues (mixed organizing principle, families 2/3 not MECE) are fully resolved, and the gate now passes. Citation integrity is clean. The three remaining items are all minor, non-gating polish on synthesis and balance. Verdict moves from REVISE to ACCEPT.

## Remaining issues after repair
- Add a comparison table or per-family comparative takeaway so the spine closes with grounded comparison (minor).
- Attach a citekey to vLLM (kwon2023efficient is available) and to continuous batching (minor).
- Add a one-clause limitation to family 3 (copying / exact in-context retrieval weakness) for balanced advantages and limitations (minor).
