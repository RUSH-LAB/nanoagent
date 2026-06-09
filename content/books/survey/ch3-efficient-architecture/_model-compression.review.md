# Review: books/survey/ch3-efficient-architecture/model-compression.md

- Content type: literature-review
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 2, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality (gate): 4, Synthesis over Summary: 3, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification of prior fixes
- [resolved] Citation Integrity blocker: The Lottery Ticket Hypothesis citation now reads "Frankle and Carbin, 2019" in the prose (line 20), and references.yaml entry frankle2019lottery now lists "Michael Carbin" (line 2895). The misspelling "Carlin" no longer appears anywhere in the file or the bibliography.
- [resolved] Balance and Currency major: The BitNet b1.58 claim (line 43) now qualifies the 71.4x figure as "a theoretical 71.4x reduction in arithmetic energy for matrix multiplication at the 7nm node (an arithmetic-only figure; realized end-to-end and real-CPU gains are far smaller, roughly 2-5x on commodity hardware)." The memory claim is corrected and decoupled from the energy multiplier: "Weight memory drops more modestly, by roughly 10x relative to a full-precision 16-bit model (1.58 bits vs. 16 bits per weight)."
- [resolved] Prose "--" usage: The soft-targets line (line 12) now uses a colon and the DFloat11 line (line 47) now uses a comma. The only remaining "--" are the YAML frontmatter delimiters on lines 1 and 4, which are correct. No em-dash (U+2014) or en-dash (U+2013) characters remain.
- Citekey check: all 12 citekeys resolve (hinton2015distilling, sanh2019distilbert, han2015learning, frankle2019lottery, frantar2023sparsegpt, sun2024wanda, dettmers2022gpt3int8, frantar2023gptq, lin2024awq, wang2023bitnet, ma2024bitnet158, zhang2025dfloat11).

## Findings
- [minor] Problem Formulation and Evaluation Rigor: "At 4-bit, GPTQ achieves nearly lossless compression of most LLMs." (line 31) remains a setting-blind superlative. "Nearly lossless" is regime-dependent: it holds better at larger model scales and degrades on small models and harder tasks. Qualify by regime or attach the perplexity/accuracy delta and model-size range from the GPTQ paper. Not blocking.
- [minor] Synthesis over Summary: The pruning and quantization subsections still read partly as annotated lists and do not close with an explicit comparative takeaway tying the families together (for example unstructured vs structured sparsity tradeoff, or PTQ vs QAT vs lossless on the accuracy/cost frontier). Adding a one-sentence comparative takeaway per subsection would lift Synthesis from 3 to 4. Not blocking.

## Decision rationale
The citation-integrity blocker and the balance/currency major are both fully resolved, the taxonomy gate passes, and house style on dashes is satisfied. The two items still open are both minor and do not affect correctness or grounding, so the chapter clears the acceptance bar.

## Remaining issues after repair
- [minor] Qualify the GPTQ "nearly lossless at 4-bit" claim by regime or with concrete deltas (line 31).
- [minor] Add a one-sentence comparative takeaway closing the pruning and quantization subsections.
