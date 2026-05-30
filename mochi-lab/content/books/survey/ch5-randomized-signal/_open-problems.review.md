# Review: books/survey/ch5-randomized-signal/open-problems.md

- Content type: literature-review
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 11
- Broken citekeys: []

## Original scores
Scope & Coverage: 4, Taxonomy Quality: 4, Synthesis over Summary: 3, Citation Integrity: 5, Balance & Currency: 4, Problem Formulation & Eval Rigor: 3

## Findings
- [resolved] Balance & Currency: All 11 literal "--" tokens are gone. A fresh grep finds "--" only on lines 1 and 4, which are the YAML frontmatter delimiters. Em-dash count is 0 and en-dash count is 0. The house-style build blocker is cleared.
- [resolved] Citation Integrity: All eight citekeys (rahimi2009weighted, bach2017equivalence, chen2020slide, pennington2017nonlinear, louart2018random, robbins1951stochastic, srivastava2014dropout, tropp2015introduction) resolve against references.yaml.
- [minor] Synthesis over Summary: Line 23 still reads "This can dramatically reduce the number of features needed for a given approximation quality." The superlative "dramatically" remains ungrounded, with no number or regime. Optional polish: cite the Bach (2017) rate or qualify with the regime in which it holds.
- [minor] Synthesis over Summary: The "Spectral Theory of Large Language Models" section (lines 45 to 53) is still a list of open questions with no closing comparative takeaway. Optional polish: add one sentence naming the central tension (spectral tools that work for fixed random matrices break down under trained, data-dependent attention).
- [minor] Citation Integrity: Line 43 still attaches tropp2015introduction (a matrix concentration monograph) to a sentence about KV-cache management, MoE expert routing, and serving-time inference. The key resolves but does not directly support that claim. Optional polish: move it to a concentration-theoretic claim or add a primary serving-time citation.
- [minor] Problem Formulation and Eval Rigor: Line 43 still presents "unacceptable responses 5% of the time" as a concrete figure without marking it as illustrative. Optional polish: flag it as a hypothetical example or drop the specific percentage.

## Changes made
None in this pass. The revision under review had already removed all 11 "--" occurrences. This independent re-review verified that removal and confirmed no em-dashes, no en-dashes, and no broken citekeys.

## Left for human
- The four minor items above are optional substance polish, not blockers. They can be addressed in a future editing pass.

## Remaining issues after repair
- "dramatically reduce" superlative on line 23 is still ungrounded (minor, non-blocking).
- Spectral Theory of LLMs section lacks a synthesizing takeaway sentence (minor, non-blocking).
- tropp2015introduction on line 43 does not directly support the serving-time sentence it is attached to (minor, non-blocking).
- "5% of the time" on line 43 is an unsourced hypothetical presented as a concrete statistic (minor, non-blocking).
