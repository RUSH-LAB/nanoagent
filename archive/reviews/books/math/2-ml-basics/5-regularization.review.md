# Review: books/math/2-ml-basics/5-regularization.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 4, Motivation: 5, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Re-review scores
Correctness & Grounding: 5, Motivation: 5, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 5, Completeness: 4

## Verification of prior findings
- [resolved] zhang2021understanding now resolves; references.yaml has a valid entry (Zhang, Bengio, Hardt, Recht; "Understanding Deep Learning (Still) Requires Rethinking Generalization").
- [resolved] The draft no longer uses ioffe2015batch. It now cites [@ioffe2015batchnorm], which exists in references.yaml.
- [resolved] ba2016layer now resolves (Ba, Kiros, Hinton; "Layer Normalization"; 2016).
- [resolved] belkin2019reconciling now resolves (Belkin, Hsu, Ma, Mandal; "Reconciling Modern Machine-Learning Practice and the Classical Bias-Variance Trade-off").
- [resolved] bishop2006pattern now resolves (Bishop, "Pattern Recognition and Machine Learning", Springer, 2006).
- [resolved] No em-dash characters and no prose double-hyphen remain. The only double-hyphen matches are YAML frontmatter delimiters and Markdown table separator rows, which are required syntax. Headings now read "Bias-Variance Tradeoff" and "Bias-Variance Decomposition" with single hyphens.

I independently confirmed all nine citekeys used in the file resolve against references.yaml: zhang2021understanding, loshchilov2019adamw, srivastava2014dropout, ioffe2015batchnorm, ba2016layer, bishop2006pattern, zhang2018mixup, belkin2019reconciling, nakkiran2021deep.

## Remaining issues after repair
- [minor] Worked Examples: Ridge regression remains the only fully worked closed-form example. L1/Lasso still lacks a concrete worked example (for instance a one-step soft-thresholding calculation driving a coordinate to zero). Non-blocking; the sparsity mechanism is well explained conceptually in rmk-l1-sparsity.
- [minor] Completeness: "Label smoothing" and "Gradient clipping" appear only in the summary table (tab-regularization-summary) and are never defined or motivated in the body, unlike every other listed technique. Non-blocking, but adding a one-line definition for each, or a caption note that they are covered elsewhere, would remove the dangling references.

## Note for human
- The zhang2021understanding entry title is the CACM 2021 follow-up phrasing ("(Still) Requires Rethinking Generalization"), not the original ICLR 2017 "Understanding deep learning requires rethinking generalization". Both refer to the same line of work; confirm which you want cited if house style is strict.

## Decision
All blocker and major findings from the original review are fixed and independently verified. Only two minor, non-gating polish items remain. Verdict: ACCEPT.
