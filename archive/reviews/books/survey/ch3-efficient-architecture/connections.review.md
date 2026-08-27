# Review: books/survey/ch3-efficient-architecture/connections.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 2
- Broken citekeys: []

## Original scores
Scope & Coverage: 3, Taxonomy Quality: 3, Synthesis over Summary: 4, Citation Integrity: 2, Balance & Currency: 3, Problem Formulation & Eval Rigor: 3

## Findings
- [major] Citation Integrity: "Random projections underlie the dimensionality reduction in SSM state initialization (HiPPO)." -> Factually wrong. HiPPO stands for High-order Polynomial Projection Operators; its state matrix is initialized from orthogonal polynomial (Legendre/Fourier) projections, not random projections (Gu et al. 2020). RESOLVED: recast to deterministic structured projections onto orthogonal polynomial bases, with citekey [@gu2020hippo].
- [major] Citation Integrity: "Multi-turn agentic conversations can reuse KV-cache across turns (RadixAttention in SGLang)." -> Named, load-bearing systems claim with no [@citekey]. RESOLVED: added [@zheng2024sglang].
- [minor] Citation Integrity: "The Johnson-Lindenstrauss lemma provides the theoretical foundation for why low-rank approximations (LoRA) and random projections preserve the essential structure of high-dimensional computations." -> Still present and unaddressed. Overstated and imprecise: JL concerns distance-preserving random projections; it is not the theoretical foundation for LoRA, which is a learned (not random) low-rank adaptation justified by low intrinsic dimensionality of fine-tuning (Aghajanyan et al. 2020; Hu et al. 2021). Separate the random-projection claim (where JL applies) from the LoRA claim (where it does not), and cite.
- [minor] Synthesis over Summary: "Quantization can be viewed as a form of random rounding with provable approximation guarantees." -> Still present and unaddressed. Asserted tradeoff/guarantee with no source and no regime qualification; most production quantization (GPTQ, AWQ, round-to-nearest) is deterministic, not random rounding. Qualify to stochastic rounding specifically or cite the provable-guarantee result.
- [minor] Balance & Currency: "MoE architectures naturally support continual learning by routing new tasks to new or existing experts while freezing old ones, providing both computational efficiency and forgetting prevention through conditional computation." -> Still present and unaddressed. One-sided: MoE-for-continual-learning has known limitations (router collapse, expert under-utilization, capacity growth, interference when experts are shared). Add the counterbalancing limitation, and ideally a citation.
- [minor] Notation/House Style: two "--" occurrences in the streaming-algorithms sentence. RESOLVED: replaced with parentheses; only the YAML frontmatter delimiters (lines 1 and 4) remain, which must stay.

## Changes made
No new edits made in this re-review pass; verification only. The three repairs claimed in the prior pass are confirmed in place: (1) HiPPO claim recast to deterministic structured projections with [@gu2020hippo]; (2) [@zheng2024sglang] added to the RadixAttention/SGLang claim; (3) body-text em-dashes replaced with parentheses. All three citekeys ([@wang2023orthogonal], [@gu2020hippo], [@zheng2024sglang]) resolve in references.yaml, and the resolved entries match the claims (gu2020hippo title "Optimal Polynomial Projections"; zheng2024sglang is the SGLang paper).

## Left for human
- Decide whether to qualify or cite the three remaining minor claims (JL/LoRA, quantization random rounding, MoE-for-continual-learning balance), or accept them as informal cross-chapter framing in a connections section.

## Remaining issues after repair
- [minor] JL lemma overstated as the theoretical foundation for LoRA (line 14): should separate the random-projection case (JL applies) from LoRA (learned low-rank, JL does not apply), and cite.
- [minor] "Quantization can be viewed as a form of random rounding with provable approximation guarantees" (line 14): unqualified and uncited; most production quantization is deterministic. Qualify to stochastic rounding or cite the guarantee.
- [minor] MoE-for-continual-learning presented as a clean win (line 8): add counterbalancing limitations (router collapse, expert under-utilization, capacity growth, interference).
