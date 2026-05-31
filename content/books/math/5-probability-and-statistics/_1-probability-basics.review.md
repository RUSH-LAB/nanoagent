# Review: books/math/5-probability-and-statistics/1-probability-basics.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Findings
- [resolved][blocker] Notation Consistency and Component Discipline: the notation table now uses $X \perp Y \mid Z$ (line 221) and $P(A \mid B)$ (line 214) with \mid, so neither row splits into spurious columns. Verified.
- [resolved][blocker] Notation Consistency and Component Discipline: the conditioning bar in the notation table cells is escaped via \mid. Verified the table renders as two columns.
- [resolved][major] Notation Consistency and Component Discipline: no prose "--" remain. A scan finds "--" only on the frontmatter delimiters (lines 1, 3) and three markdown table separator rows (lines 68, 187, 210), all legitimate. The intro line, the sigma-algebra bullet, and the LOTUS gloss were reworded.
- [minor] Correctness and Grounding: line 74 still reads "MAP estimation maximizes $P(\theta|\mathcal{D})$, which equals MLE + regularization." This conflates the estimator with the objective. Recommend "reduces to maximizing the log-likelihood plus a log-prior penalty (a regularizer)". Not fixed; does not block.
- [minor] Correctness and Grounding: line 188 Markov's inequality lists only $X \geq 0$ in the Conditions cell but also requires $a > 0$. Recommend adding $a > 0$. Not fixed; does not block.
- [minor] Worked Examples and Illustration: still only one fully worked numeric computation (the spam Bayes example, line 77). A second harder example with faded guidance (e.g. a total-probability marginalization) would improve illustration breadth. Not fixed; does not block.

## Changes made
None in this review pass. The prior repair pass had already fixed both blockers and the major finding; this pass independently verified those fixes hold: the notation table cells use \mid (no spurious column splits), and no prose "--" remains (only frontmatter and table separators). The citekey kolmogorov1933foundations resolves against references.yaml.

## Left for human
- Optional minor polish: reword the MAP "MLE + regularization" gloss (line 74), add $a > 0$ to Markov's conditions (line 188), and consider a second faded worked example. All are non-blocking quality improvements.

## Remaining issues after repair
- Three minor items remain open (MAP wording on line 74, Markov $a > 0$ condition on line 188, single worked example). None are gating; the section is correct, grounded, and renders cleanly.
