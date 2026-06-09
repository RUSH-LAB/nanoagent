# Review: books/survey/ch4-agentic-search/multi-hop-reasoning.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 8
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 2

## Findings
- [resolved][blocker] Citation Integrity (feng2024retrieval): The fabricated "RL-trained policy outperforms always-retrieve and heuristic" claim is gone. The description now matches the actual paper (ITRG: an iterative RAG / generation-augmented-retrieval synergy loop, "even without a learned policy"). The references.yaml title at line 556 confirms "Retrieval-Generation Synergy Augmented Large Language Models." Accurate.
- [resolved][blocker] Citation Integrity (IRCoT HotpotQA): "15+ F1 over one-shot RAG" replaced with the paper's actual HotpotQA Answer-F1 gains over OneR (9.4 Flan-T5-XXL, 7.1 GPT-3); the 15-point figure is correctly reframed as "the largest single-dataset Answer-F1 gain the paper reports."
- [resolved][major] Synthesis over Summary: A "Comparing the Approaches" section now provides a comparison table (triggering signal, number of hops, query-formulation strategy) plus a synthesis paragraph framing the methods as a progression from fixed to signal-driven retrieval. Per-method takeaway sentences added for IRCoT (line 16), FLARE (line 22), and ITER-RETGEN (line 32).
- [resolved][major] Problem Formulation & Eval Rigor (2WikiMultiHopQA): The setting-blind "improvement was even larger" superlative is removed; HotpotQA and 2WikiMultiHopQA now carry brief definitions.
- [resolved][minor] Em-dashes: 0 em-dash characters and 0 prose "--" remain (only frontmatter delimiters and table separators). House style satisfied.
- [open][major] Problem Formulation & Eval Rigor (compositionality gap): Press et al. 2023 is still cited with the qualitative "found it to remain substantial even in frontier models." This is the chapter's central gap evidence and remains unquantified. The specific gap fraction and the model it was measured on are still needed. Left for human (cannot be supplied without fabrication).
- [open][minor] Eval Rigor (comparison table): The table has no "reported gains" column, so cross-method magnitude is still not comparable. Acceptable to defer, since verified model/setting-matched gain figures are unavailable for FLARE, DSP, ITER-RETGEN, ITRG, and Adaptive-RAG without risking fabrication.
- [open][cosmetic] Citation Integrity (citekeys): geva2023strategyqa cites a 2021 TACL paper (in-text year 2021 is correct); feng2024retrieval is arXiv Oct 2023 / ICASSP 2024. Both resolve and build; renaming for year accuracy is optional and non-blocking.

## Verdict rationale
All three blockers and the two highest-priority majors are resolved, lifting the draft well above REJECT. The remaining open items are one quantitative gap (compositionality-gap fraction) that is load-bearing for the chapter's central claim plus two minor or cosmetic items. Because a load-bearing quantitative claim is still qualitative, the draft is not yet a clean ACCEPT, but it is close: REVISE.

## Remaining issues after repair
- Add the precise compositionality-gap fraction and the model it was measured on from Press et al. 2023 (currently qualitative; left for human).
- Optionally add a model/protocol-matched "reported gains" column to the comparison table.
- Optional cosmetic citekey rename (geva2023strategyqa to geva2021strategyqa) for year accuracy.
