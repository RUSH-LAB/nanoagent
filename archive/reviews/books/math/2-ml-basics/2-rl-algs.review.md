# Review: books/math/2-ml-basics/2-rl-algs.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 2, Motivation: 4, Worked Examples: 2, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 2, Completeness: 4

## Re-review scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 5, Completeness: 4

## Verification of prior blockers
- [resolved] Correctness & Grounding (KL estimator equation): The GRPO token-level KL approximation now uses the ratio pi_ref/pi_theta in both the ratio and log terms. With p = pi_theta and q = pi_ref, the control variate E_p[q/p - 1] = 0 holds, so the expression is the unbiased k3 estimator matching DeepSeekMath (Shao et al. 2024). Fixed.
- [resolved] Correctness & Grounding (KL identity): The stated identity now reads D_KL(p||q) = E_p[q/p - log(q/p) - 1], which is the correct k3 form. Fixed.
- [resolved] Correctness & Grounding (schulman2016gae): Entry added to references.yaml (arXiv 1506.02438, ICLR 2016, full author list present). Resolves.
- [resolved] Correctness & Grounding (deepseekai2025r1): Entry added to references.yaml (arXiv 2501.12948, 2025). Resolves both the GRPO remark and the trends remark.
- [resolved] Correctness & Grounding (guo2024direct): Entry added to references.yaml (arXiv 2402.04792, "Direct Language Model Alignment from Online AI Feedback"). Resolves.
- [resolved] Notation & Component Discipline (prose double-hyphens): All 16 prose "--" occurrences removed. "Bradley--Terry" is now "Bradley-Terry" and "0.1--0.2" is now "0.1 to 0.2". The only remaining "--" tokens are frontmatter delimiters (lines 1, 3) and markdown table separators (lines 256, 278), which are legitimate. Fixed.
- [resolved] Worked Examples: Two faded numeric Example blocks added: ex-grpo-advantage (G=4, rewards {1,0,1,0}, group-normalized advantages +/-1) and ex-rloo-baseline (K=4, leave-one-out baselines and +/-2/3 advantages, with an explicit comparison to GRPO). Both are arithmetically correct. Resolves.

## Remaining issues after repair
- [minor, optional] Correctness & Grounding (rmk-grpo-kl): The estimator is value-unbiased but its gradient is biased relative to the true KL gradient, a known GRPO subtlety. A one-line caveat clarifying that "unbiased" refers to the value, not the gradient, would prevent over-trust. Not a gate.
- [minor] Completeness: Could not confirm that the chapter index.md (2-ml-basics) lists this section with a working link; worth a human spot-check.
- [minor] Completeness: The comparison table lists REINFORCE "Reward Model: Yes", but the REINFORCE section uses a generic R(x, y) and never states a reward model is required. A one-line reconciliation would help, though the RLHF framing makes "Yes" defensible.

## Verdict rationale
Correctness gate is now passed: both KL blockers are corrected and all three missing citekeys resolve with accurate metadata. The required worked examples were added and check out arithmetically. House-style violations are fully cleared. The three remaining items are minor or optional and do not gate publication. Verdict moves from REJECT to ACCEPT.
