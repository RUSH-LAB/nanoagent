# Review: books/survey/ch3-efficient-architecture/problem-formulation.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Scope and Coverage Completeness: 3, Taxonomy Quality: 4, Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 2, Problem Formulation and Evaluation Rigor: 3

## Re-review scores
Scope and Coverage Completeness: 4, Taxonomy Quality: 4 (gate passes), Synthesis over Summary: 4, Citation Integrity: 4, Balance and Currency: 3, Problem Formulation and Evaluation Rigor: 4

## Findings
- [resolved] Scope and Coverage: The previously uncited name-drops now carry primary citations, all verified present in references.yaml: FlashAttention [@dao2022flashattention], MoE [@shazeer2017outrageously; @fedus2022switch], quantization [@dettmers2022gpt3int8; @frantar2023gptq], KV-cache management [@kwon2023efficient], speculative decoding [@leviathan2023fast], and LoRA/PEFT [@hu2022lora]. A forward-reference note signals each is covered in depth later in the chapter, so coverage is no longer laundered through bare names.
- [resolved] Problem Formulation and Evaluation Rigor: MFU is now defined by formula (achieved FLOPs per second divided by hardware peak FLOPs per second) with interpretation, and the latency-vs-throughput relation Throughput is approximately B over L is stated with the explanation of why the two optimizations conflict. The Rubric C "metrics named but never defined" red flag is cleared for the two load-bearing metrics.
- [partially resolved] Balance and Currency: A post-Chinchilla paragraph now distinguishes training-compute-optimal from inference-optimal allocation and discusses deliberate over-training past compute-optimal, cited to the LLaMA series [@touvron2023llama]. This moves currency past 2022. The Chinchilla replication/critique line is still absent because no corresponding citekey exists in references.yaml; this is a single discretionary addition, not an accuracy defect, so it does not block acceptance.
- [verified] Citation Integrity: All 12 citekeys in the file resolve against /Users/zy45/Documents/Code/mochi-lab/mochi-lab/references.yaml. The Kaplan exponents (alpha_N approximately 0.076, alpha_D approximately 0.095, alpha_C approximately 0.050) and the Chinchilla 70B-beats-Gopher-280B claim were previously spot-checked against primary sources and hold.
- [verified] CLAUDE.md compliance: A fresh scan for double-hyphens and em-dashes in prose returns only the two YAML frontmatter delimiters on lines 1 and 4. All 11 prior prose occurrences are removed.

## Changes made
No new edits in this pass. The prior revision was verified independently: all 12 citekeys confirmed present in references.yaml, prose confirmed free of em-dashes and double-hyphens, and the MFU and throughput formulas confirmed present and correct.

## Left for human
- Add a Chinchilla scaling-law replication/critique citation (e.g., Besiroglu et al. 2024 "Chinchilla Scaling: A replication attempt") to references.yaml and a sentence noting the Chinchilla coefficients have been subject to replication scrutiny. No citekey exists today and none was fabricated.

## Remaining issues after repair
- Optional currency enhancement only: the replication/critique citation noted above. This is discretionary and not a blocker for acceptance.
