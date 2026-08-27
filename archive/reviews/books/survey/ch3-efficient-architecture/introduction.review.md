# Review: books/survey/ch3-efficient-architecture/introduction.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 9
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 2, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Re-review scores (after revision)
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance & Currency: 4, Problem Formulation & Eval Rigor: 4

## Findings
- [resolved] Citation Integrity: The Strubell et al. (2019) carbon claim now reads "training a Transformer with neural architecture search produces carbon emissions comparable to five cars over their lifetimes," correctly attributing the figure to the NAS/full development pipeline rather than to a single model training run.
- [resolved] Citation Integrity: The "10x annually" compute-growth claim is replaced with "doubling roughly every six months (about 4x per year)," matching Sevilla et al. (2022).
- [resolved] Problem Formulation & Eval Rigor: The unverifiable ">$1 billion" projection, the uncited "GPT-4 over $100 million" figure, and the mis-cited epoch2023trends citation were removed. The cost statement is now a qualified "tens to hundreds of millions of dollars" with a general rising-trend note. epoch2023trends no longer appears in the file.
- [resolved] Citation Integrity: The uncited precise "transistor density 2x every 3-4 years" figure was removed. The compute-wall paragraph now keeps the historical "doubling roughly every 18 months no longer holding" reference and softens to "improvements now arriving far more slowly."
- [resolved] Citation Integrity: The references.yaml entry for frankle2019lottery now lists the second author as "Michael Carbin" (was "Michael Carlin").
- [resolved] Balance & Currency: All 9 prose "--" occurrences are removed. The only remaining "--" instances are the required YAML frontmatter delimiters on lines 1 and 4.
- [minor, open] Balance & Currency: The democratization paragraph (line 20) still names GPTQ, GGML, LoRA, and QLoRA as load-bearing examples without citations, unlike comparable named-technique claims elsewhere in the intro. Adding a citekey for each would make the grounding standard consistent. Non-blocking.

## Changes made (by prior revision)
Removed all 9 prose "--" occurrences via parentheses, semicolons, and commas (keeping only the YAML frontmatter delimiters). Reworded the Strubell et al. (2019) claim to attribute the five-cars figure to a Transformer trained with neural architecture search. Replaced "10x annually" with "doubling roughly every six months (about 4x per year)." Softened the transistor-density deceleration claim and dropped the uncited "2x every 3-4 years" figure. Removed the unsupported epoch2023trends citation along with the ">$1 billion" and "GPT-4 over $100 million" figures, replacing them with a qualified statement. Corrected the frankle2019lottery author metadata to "Michael Carbin."

## Left for human
- Training-cost projection: the >$1B projection and the GPT-4 >$100M figure were removed rather than fabricated. To restore quantitative cost claims, add a verified Epoch cost-of-training citation (their training-cost analyses, not the hardware-trends entry) and reinsert the figures.
- Transistor-density deceleration: the precise "2x every 3-4 years" figure was removed for lack of a source. Restore the quantitative form only with a citation (e.g., an Epoch or industry hardware-trends reference).

## Remaining issues after repair
- [minor, non-blocking] Add citations for GPTQ, GGML, LoRA, and QLoRA in the democratization paragraph (line 20) for grounding consistency.
