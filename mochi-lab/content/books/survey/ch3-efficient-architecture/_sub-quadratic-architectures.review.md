# Review: books/survey/ch3-efficient-architecture/sub-quadratic-architectures.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 5, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 3

## Re-review scores (after revision)
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 4

## Verification performed
- Dash check: grep for em-dash and en-dash returns none; grep for "--" returns only the YAML frontmatter delimiters on lines 1 and 4. No prose "--" remains. Confirms the house-style fix.
- Citekey check: all 8 citekeys (poli2023hyena, peng2023rwkv, touvron2023llama, sun2023retentive, arora2024based, de2024griffin, beck2024xlstm, lieber2024jamba) resolve against references.yaml. None broken.

## Findings
- [resolved] Balance and Currency: each architecture now carries at least one limitation. Hyena (line 12), RWKV (line 16), and RetNet (line 20) all state the fixed-state recall limitation versus full attention; Griffin/RecurrentGemma (line 28) notes the pure-recurrent HAWK variant trails the hybrid on precise token matching; xLSTM (line 32) notes the fixed-size matrix-memory recall ceiling and the modest 1.3B validation scale. The section now reads even-handed.
- [resolved] Problem Formulation and Evaluation Rigor: the vague BASED claim is reframed (line 24) around the recall-throughput Pareto tradeoff with concrete numbers (up to 24x decoding throughput over FlashAttention-2; recall-slice perplexity roughly 2.29 vs a Transformer 1.87). Setting-blind language is gone.
- [resolved] Balance and Currency: all prose "--" occurrences converted to colons; only frontmatter delimiters remain.
- [minor, unresolved] Citation Integrity: line 16 still asserts "RWKV-v5 and v6 introduced data-dependent time mixing that further closes the gap with attention-based models" with no citation. This claim postdates the cited peng2023rwkv (RWKV-4 era) and remains an uncited extrapolation. The original minor finding asked to either cite the Eagle/Finch (RWKV-5/6) paper or drop the sentence; neither was done.
- [minor, partially addressed] Synthesis over Summary: line 12 still reads "Hyena matches attention-based models at sequence lengths up to 8K tokens while being significantly faster for longer sequences." The phrasing remains ambiguous: it can be read as an 8K quality ceiling rather than attaching 8K to the speed crossover. Quality parity in the source is general, with 8K as the speed crossover point. Wording is acceptable but still slightly imprecise.

## Decision rationale
The two major findings (balance, BASED evaluation rigor) are fully resolved, the house-style dash violations are eliminated, and all citekeys resolve. Two minor issues remain: one uncited RWKV-v5/v6 claim and one imprecise Hyena phrasing. Neither rises to a blocking defect, and the chapter is now even-handed and quantitatively grounded. Verdict moves from REVISE to ACCEPT, with the two minor items flagged for a light follow-up pass.

## Remaining issues after repair
- [minor] Line 16: cite the RWKV-5/6 (Eagle/Finch) paper for the v5/v6 data-dependent time-mixing claim, or drop that sentence; as written it is an uncited claim beyond the resolved peng2023rwkv citekey.
- [minor] Line 12: reword so the 8K figure attaches to the speed crossover rather than reading as a quality ceiling.
- [human] Confirm the BASED figures (24x throughput over FlashAttention-2; recall-slice perplexity 2.29 vs 1.87) against the published BASED paper; they were carried verbatim from the reviewer finding and not independently verified against the primary source.
