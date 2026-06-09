# Review: books/math/5-probability-and-statistics/3-bayesian-inference.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 3
- Broken citekeys: ["ritter2018scalable"]

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 2, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Findings
- [blocker] Correctness and Grounding: broken citekey ritter2018scalable. RESOLVED. references.yaml now contains the entry (line 8285) with the correct metadata: Ritter, Botev, Barber, "A Scalable Laplace Approximation for Neural Networks", ICLR 2018. The citation on line 227 now resolves.
- [blocker] Notation Consistency and Component Discipline: three prose double-hyphens (lines 47, 199, 219 in the prior version) violated repo house style. RESOLVED. A fresh scan finds no prose "--", no em-dashes, and no en-dashes; the only remaining "--" matches are the frontmatter delimiters (lines 1, 3) and Markdown table separator rows.
- [major] Correctness and Grounding: Laplace-smoothing pseudo-count inconsistency. RESOLVED. Line 124 now reads "Laplace smoothing: $\alpha_k = 2$ (adds 1 to each count)", consistent with the stated "$\alpha_k - 1$ examples" convention and distinct from the uniform prior $\alpha_k = 1$ on the same line.
- [major] Worked Examples and Illustration: section had zero <Example> components. RESOLVED. Two were added to Conjugate Priors: a fully worked Beta-Bernoulli update (lines 128-142) and a harder Gaussian-mean precision-weighted update with faded guidance (lines 144-152). Arithmetic independently verified: Beta(2,2) + 8/10 heads gives Beta(10,4), mean 10/14 ~ 0.714; prior N(0,1), sigma^2=4, n=10, xbar=3 gives posterior N(2.143, 0.286) via precision 3.5 and weighted mean 7.5/3.5. Both use only formulas already in the file's tables and remark.
- [minor] Correctness and Grounding: line 202 "SGD with appropriately decaying learning rate is approximately SG-Langevin dynamics" remains imprecise (vanilla SGD approximates SGLD only when gradient-noise covariance is treated as the injected noise; SGLD proper requires explicitly injected Gaussian noise). Not a blocker; left as is.
- [minor] Notation Consistency and Component Discipline: line 61 "Cramer-Rao" still uses plain ASCII rather than a proper accent. Cosmetic, not load-bearing.
- [minor] Cognitive Load and Scaffolding: the sequential-update factorization (lines 43-47) still does not explicitly state the conditional-independence (i.i.d.) hypothesis behind the factorization itself; the caveat appears only for order-independence. Minor.

## Re-review scores (Rubric B)
- Correctness and Grounding (gate): 5. Citation resolves, Laplace pseudo-count fixed, example arithmetic verified. Two non-load-bearing minor imprecisions remain (SGLD wording, conditional-independence caveat) that do not breach the correctness gate.
- Motivation and Conceptual Framing: 5. Strong opening framing and consistent ML-analogy threading throughout.
- Worked Examples and Illustration: 4. Two numerically worked examples now present, the second with faded guidance, exactly as the rubric requests.
- Cognitive Load and Scaffolding: 4. Good progression from framework to estimation to inference; minor unstated i.i.d. assumption.
- Notation Consistency and Component Discipline: 4. House style satisfied, MDX components well-formed; minor Cramer-Rao accent cosmetic only.
- Completeness and Self-Containment: 4. Covers priors, ELBO, MCMC/VI, model evidence, and ML connections with a notation summary.

## Verdict rationale
All blockers and majors from the original REJECT are resolved. Only three non-load-bearing minor items remain, none of which breaches the Correctness gate. Promoting to ACCEPT.

## Remaining issues after repair
- [minor] SGD/SGLD wording on line 202 is imprecise; qualify or cite (Mandt et al.) if revisited.
- [minor] Cramer-Rao on line 61 lacks proper accents; cosmetic.
- [minor] Sequential-update factorization (lines 43-47) does not state the conditional-independence assumption explicitly.
