# Review: books/survey/ch4-agentic-search/retrieval-augmented-generation.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 6
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 3, Synthesis over Summary: 2, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Re-review scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Findings
- [resolved] Citation Integrity: The RETRO mechanism claim is now correct. Line 34 reads "integrates them at a subset of decoder layers via chunked cross-attention rather than at every layer," matching RETRO's interleaved chunked-cross-attention design.
- [resolved] Synthesis over Summary: The file no longer ends on a per-paper summary. A new "Comparing the Architecture Families" section (lines 64 to 75) synthesizes the architectures along three consistent axes (retriever training, augmentation stage, primary aim) in prose plus a comparison table, and the Atlas section now carries a comparative takeaway contrasting RETRO (frozen-retriever, pre-training-time) with Atlas (joint fine-tuning).
- [resolved] Synthesis over Summary: The setting-blind RETRO result is fixed. Line 34 now states the regime explicitly: 7B RETRO reaches Pile language-modeling perplexity comparable to Jurassic-1 (178B) and Gopher, removing the implied GPT-3 175B comparison.
- [resolved] Balance & Currency (house style): All prose "--" occurrences are gone. A grep finds "--" only in the YAML frontmatter delimiters (lines 1 and 4), and no em-dash characters are present anywhere. The table delimiter row uses single dashes.
- [open, minor] Balance & Currency: The opening still frames RAG as "the dominant paradigm... offering a practical solution to LLM hallucination" without surfacing per-family limitations near each method. Limitations appear only late (CRAG, Self-RAG, ALCE). Consider softening "practical solution to hallucination" to "reduces hallucination" and adding a brief limitation note per family. Not blocking.
- [open, minor] Problem Formulation & Eval Rigor: The Atlas "50x parameter efficiency" claim (line 38) still names no benchmark, few-shot setting, or metric in-text. Naming NQ, the 64-shot setting, and the metric would make it verifiable. Not blocking.
- [open, minor] Taxonomy Quality: Per-system H3 headings (REALM, RAG, FiD, RETRO, Atlas, Self-RAG) and thematic H3 headings (Advanced RAG Architectures, Query Enhancement and Re-Ranking, Attribution) still sit at the same level with different organizing principles. The new closing comparison mitigates this, so it is no longer gate-failing, but a single consistent axis would be cleaner. Not blocking.

## Decision rationale
All three major findings (RETRO mechanism, RETRO setting-blind result, synthesis-over-summary) are fully resolved, and the house-style dash violation is fixed with no em-dashes remaining. The Taxonomy gate now passes thanks to the added comparative section. The remaining items are minor (one-sided opening framing and an unnamed Atlas benchmark) and do not affect correctness or grounding. Verdict raised from REVISE to ACCEPT.

## Note on the dash count
The original review counted 6 "--" occurrences; only 4 existed in prose. The repair correctly fixed all 4 prose dashes and left the 2 required YAML frontmatter delimiters intact. No discrepancy remains in the document.

## Remaining issues after repair
- [minor] Opening paragraph frames RAG one-sidedly; soften the hallucination claim and add per-family limitations.
- [minor] Atlas "50x" claim lacks an in-text benchmark, few-shot setting, and metric.
- [minor] Mixed organizing principle across H3 headings (per-system vs thematic).
