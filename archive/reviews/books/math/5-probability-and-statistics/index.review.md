# Review: books/math/5-probability-and-statistics/index.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 5
- Broken citekeys: []

## Original scores
Correctness & Grounding: 5, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 5, Notation & Component Discipline: 2, Completeness: 4

## Findings
- [blocker] Notation & Component Discipline: "- **[Probability Basics](./1-probability-basics.md)** -- Axioms, conditional probability, Bayes' theorem, expectation, variance" -> Replace the literal `--` separator with an en/em-free dash per house style, e.g. a colon or the word break: "**[Probability Basics](./1-probability-basics.md)**: Axioms, conditional probability, ...". The rubric flags `no -- or em-dash` as a component-discipline blocker and CLAUDE.md says "Avoid using -- in writing."
- [minor] Notation & Component Discipline: "- **[Distributions](./2-distributions.md)** -- Bernoulli, Gaussian, Categorical, Softmax, multivariate Gaussian, mixture models" -> Same `--` fix; also note this list mixes a distribution (Softmax is a function/parameterization of the Categorical, not a distribution) with true distributions. Consider "Categorical and softmax" or rephrasing so the entry does not present Softmax as a distribution on equal footing with Gaussian and Bernoulli.
- [minor] Worked Examples: "Probability is the other foundational language of machine learning. Models define distributions, training maximizes likelihood, and generalization is a statistical guarantee." -> As a chapter index this page is intentionally short and carries no worked example, which is acceptable for a landing page; if the rubric's Worked Examples dimension is applied strictly it scores low by design. No fix needed beyond optionally adding one sentence of through-line motivation tying the five sections together (e.g. how likelihood in section 1 feeds Bayesian inference in section 3).

## Changes made
Replaced all five literal `--` separators in the chapter overview list of /Users/zy45/Documents/Code/mochi-lab/mochi-lab/content/books/math/5-probability-and-statistics/index.md with colons, satisfying the house-style no-dash rule. The link text, descriptions, and all other content were preserved unchanged.

## Left for human
- None

## Remaining issues after repair
- [minor, optional] "Softmax" is listed in the Distributions entry alongside Bernoulli and Gaussian, but it is a parameterization of the Categorical distribution rather than a distribution in its own right. Cosmetic only; does not block acceptance.
- [minor, optional] The index page carries no through-line sentence connecting the five sections. Acceptable for a landing page; could be enriched but not required.
