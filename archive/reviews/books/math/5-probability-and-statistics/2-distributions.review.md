# Review: books/math/5-probability-and-statistics/2-distributions.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 6
- Broken citekeys: ["jang2017categorical","maddison2017concrete","rezende2015variational"]

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 2, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 3

## Re-review scores (current state)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of the repair
- [resolved] Correctness gate blocker: line 54 now reads "The conjugate prior for the Poisson rate ... is the Gamma distribution." The false self-conjugacy claim is gone and the internal contradiction with the Gamma section is removed.
- [resolved] Citekey blockers: all three keys now exist in references.yaml with correct metadata. jang2017categorical (Jang, Gu, Poole; ICLR 2017; arXiv:1611.01144), maddison2017concrete (Maddison, Mnih, Teh; ICLR 2017; arXiv:1611.00712), rezende2015variational (Rezende, Mohamed; ICML 2015; arXiv:1505.05770). They will resolve at build time.
- [resolved] House-style major: no prose double-hyphens remain. The six prior sites were converted to colons. Only table separators and YAML delimiters use repeated hyphens, which are required syntax.
- [resolved] Worked-example major: two new step-by-step Examples were added. The bivariate Gaussian density (lines 122 to 136) was independently recomputed as p(x) = 0.0876, matching the stated 0.0877. The one-EM-iteration example (lines 138 to 157) was independently recomputed: responsibilities r_i1 = [1.000, 0.9994, 0.0006, 0.000] and mu1 = 0.501, matching the text. The harder example includes faded guidance ("Try the E-step yourself before reading on").

## Findings still open (all minor, none gate-blocking)
- [minor] Correctness and Grounding (line 352): "This justifies the learning rate linear scaling rule ... increase eta by k" is still stated as a consequence of the CLT variance argument. The linear scaling rule is an empirical heuristic (Goyal et al. 2017) that breaks down at large batch. Add a citation and a hedge, or label it a heuristic.
- [minor] Correctness and Grounding (line 299): "GMMs can approximate any continuous density with compact support to arbitrary accuracy" is still scoped to compact support and uncited. The density-approximation property holds more generally; cite a source or soften the support qualifier.
- [minor] Completeness and Self-Containment (line 284): the log-normal ML usage is still "Attention scores, gradient norms", a loose unsupported characterization. Replace with a standard usage (modeling multiplicative positive quantities) or cite.
- [minor] Completeness and Self-Containment (line 376): "Probability integral transform: If X ~ F, then F(X) ~ U(0,1)" still omits the hypothesis that F is continuous. State the continuity condition; the result fails for discrete or mixed F.

## Rationale for verdict
All blockers (the Correctness gate and the three build-breaking citekeys) are fixed and independently verified, and both major findings (house-style hyphens, missing worked computation) are resolved. The gate dimension now passes. Four minor accuracy and self-containment items remain, so the section is close but not yet clean: REVISE rather than ACCEPT.

## Note for human
The three new references.yaml entries match the known publication metadata for these well-known papers. Confirm they render via the bibliography plugin at build time.
