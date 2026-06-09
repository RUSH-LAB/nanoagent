# Review: books/survey/ch1-continual-learning/llm-continual-learning.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0 (15 in original; all removed)
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality (gate): 4, Synthesis over Summary: 3, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality (gate): 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Verification performed
- Confirmed 0 prose "--" occurrences remain; only the two frontmatter delimiters (lines 1 and 4) are present.
- All 24 citekey references in the file resolve to entries in references.yaml (no broken citekeys).
- references.yaml ibrahim2024investigating now reads title "Simple and Scalable Strategies to Continually Pre-train Large Language Models", venue "TMLR", url arxiv.org/abs/2403.08763. Corrected metadata is in place.
- references.yaml gupta2023continual title now reads "Continual Pre-Training of Large Language Models: How to Re-warm Your Model?", consistent with the re-attribution of re-warming to Gupta 2023.

## Resolution of original findings
- [major] Citation Integrity (Llama attribution): RESOLVED. Line 20 now reads "on models of 405M and 10B parameters" and softens the claim to "can match the performance of training from scratch", removing the incorrect Llama-family attribution.
- [major] Citation Integrity (ibrahim2024investigating metadata): RESOLVED. references.yaml entry corrected to the real paper (title, venue TMLR, url arxiv.org/abs/2403.08763).
- [major] Citation Integrity (re-warming priority): RESOLVED. Line 18 credits Gupta et al. 2023 with introducing learning rate re-warming; line 20 reframes Ibrahim et al. 2024 as the combined re-warming + re-decaying + replay recipe.

## Remaining minor findings (non-blocking)
- [minor] Citation Integrity: Line 16 still attributes the "1-5%" replay fraction to Gupta 2023. Worth confirming whether the precise 1-5% sweep figure originates from Ibrahim 2024 and aligning if so.
- [minor] Problem Formulation and Eval Rigor: Line 8 still states no formal LLM-CL problem setting and no metrics (forgetting, backward/forward transfer) or benchmark grounding; a cross-reference to the chapter problem-formulation/benchmarks pages or a brief eval-setting note (including pre-training contamination/leakage) would strengthen it.
- [minor] Synthesis over Summary: The Adapter-Based and LoRA-Based subsections (lines 52 to 58) read as annotated bibliography; no comparative number contrasts O-LoRA, LoRAMoE, and AdapterCL, and there is no takeaway naming the parameter-growth vs interference tradeoff.
- [minor] Balance and Currency: The model-merging closing paragraph (line 76) presents mostly upsides; balancing with the known DARE limitation (works only for small SFT delta ranges, breaks down for larger deltas after continued pre-training) would give each family both advantages and limitations.

## Rationale for ACCEPT
All three major citation-integrity defects are fixed, every citekey resolves, and the file is free of prose em-dashes. Citation Integrity rises from 2 to 4. The taxonomy gate passes (lifecycle-stage organization is clear and mutually exclusive). The remaining items are minor synthesis, balance, and formulation refinements that do not block publication.

## Author-verification note (carried from repair)
The corrected ibrahim2024investigating entry still lists only "Adam Ibrahim" as sole author; the real paper has multiple coauthors. The author list was left unchanged to avoid fabricating names. A human should backfill the coauthors from arXiv:2403.08763.
