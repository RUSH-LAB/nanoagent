# Review: books/survey/ch1-continual-learning/architecture-methods.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 3, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 4, Problem Formulation and Evaluation Rigor: 3

## Verification
- All prose "--" occurrences removed; the only 2 remaining "--" matches are the YAML frontmatter delimiters (lines 1 and 4). No em-dash characters present.
- All 12 citekeys resolve against references.yaml: mallya2018packnet, serra2018overcoming, wortsman2020supermasks, frankle2019lottery, rusu2016progressive, yoon2018lifelong, wang2022foster, yan2021der_cl, zhou2022memo, aljundi2017expert, yu2024boosting_moe_cl, mendez2022modular_cl.

## Findings (resolved)
- [resolved][major] Citation Integrity (MEMO): Now correctly describes decoupling into shared generalized (shallow) blocks and task-specific specialized (deep) blocks, expanding only the deep specialized blocks. The false adapter/parameter-efficient-fine-tuning framing is gone, and MEMO's memory-aligned (model-vs-exemplar budget) fairness analysis is now stated as its central contribution.
- [resolved][major] Synthesis over Summary (DER): The omitted channel-level mask pruning mechanism is now included and called out as DER's key efficiency mechanism. The Dynamic Expansion section now closes with a comparative takeaway contrasting PNN (linear growth), DEN (sub-linear), DER (pruned growth), and FOSTER/MEMO (expand-then-compress).
- [resolved][minor] Citation Integrity (FOSTER): The expand-then-compress description is acceptable as written.
- [resolved][minor] Synthesis: All eleven literal "--" occurrences replaced with proper punctuation.

## Findings (still open)
- [major] Problem Formulation and Evaluation Rigor: No concrete comparative benchmark number with its evaluation setting appears anywhere in the chapter. The repeated zero-forgetting claim is now correctly qualified as structural (frozen parameters under parameter isolation, which is also why backward transfer is impossible) in both the intro (line 8) and Tradeoffs (line 68), which is a genuine improvement. But per Rubric C, a survey that makes repeated quantitative-sounding comparative claims should anchor at least one with a verified number and its setting (e.g., DER or FOSTER class-IL accuracy on CIFAR-100 or ImageNet-100, or a PackNet/HAT capacity-vs-task-count tradeoff). The reviewer correctly declined to fabricate this; a human should insert a verified figure with its benchmark setting.
- [minor] Scope and Coverage Completeness: Adapter-based continual learning for pre-trained models is no longer named at all (the inaccurate MEMO framing that previously pointed at it was corrected). The boundary with the prompt-based and LLM chapters is still not explicitly stated. Add a one-line honest pointer to adapter-based CL distinct from prompt-based-methods.md, or explicitly scope it out.

## Recommendation
The major accuracy and synthesis defects are fixed and the chapter is substantially stronger. Verdict remains REVISE because the eval-rigor finding is only partially closed: the chapter still contains no verified empirical anchor, which a human must supply, plus a small scope-boundary note. These are bounded, low-risk edits.

## Remaining issues after repair
- Insert at least one verified comparative benchmark number with its evaluation setting (human-supplied, do not fabricate).
- State the boundary with adapter-based / prompt-based CL: add a brief honest pointer or an explicit scope-out.
