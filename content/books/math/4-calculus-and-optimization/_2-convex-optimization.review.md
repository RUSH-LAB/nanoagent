# Review: books/math/4-calculus-and-optimization/2-convex-optimization.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (Rubric B, this pass)
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Verification of prior blockers and majors
- [resolved] Notation & Component Discipline: all four prose "--" usages are gone. Line 54 reads "guarantee fails, but empirically"; rmk-acceleration (line 166) uses parentheses for the rate comparison; rmk-conjugate-ml (line 216) uses "Donsker-Varadhan" (hyphen). A unicode scan confirms no em-dash or en-dash characters remain. The only "--" left are the frontmatter delimiters (lines 1, 3) and Markdown table separator rows (lines 60, 158, 226, 244), which are structural and must stay.
- [resolved] Notation & Component Discipline: the $f^*$ overload is gone. The Notation Summary optimal-value row now reads "$f(x^*)$ | Optimal value (the minimum of $f$)" (line 250), and the body convergence theorems (eq-convex-convergence, eq-strong-convex-rate) consistently write $f(x^*)$, never $f^*$. So $f^*(\cdot)$ (line 252) now unambiguously denotes the convex conjugate.
- [resolved] Worked Examples: ex-proximal-l1 now contains a step-by-step numeric soft-threshold computation (theta=(3,-0.4,0.5,-2), threshold 0.5, result (2.5,0,0,-1.5), coordinate by coordinate). A second harder faded example, ex-gd-iteration-count, derives the 20,000-step count to reach epsilon=1e-3 from the O(1/t) bound and discusses 1/epsilon scaling. Rubric requirement for at least one concrete worked computation plus a harder example is satisfied.
- [not applicable] Correctness & Grounding (nesterov1983method): the citekey resolves. references.yaml contains the entry at line 3634 (type article, title "A Method for Solving the Convex Programming Problem with Convergence Rate O(1/k^2)", author Yurii Nesterov, year 1983, venue Doklady Akademii Nauk SSSR). The original "broken reference" blocker was incorrect; the prior agent correctly left the citation unchanged. The claim that the rates are first-order optimal is itself correct.

## Remaining minor issues (non-gating)
- [minor] Correctness & Grounding (line 148): eq-strong-convex-rate states the contraction $(1-\mu/L)^t$ on the function gap with step size eta=1/L, which is stated. Some references give the tighter contraction on iterate distance with a squared exponent. The stated form is a standard textbook bound; naming the contracting quantity (function gap vs distance) explicitly would prevent a reader mismatch. Optional.
- [minor] Correctness & Grounding (line 115): $\kappa=(L+\lambda)/\lambda$ after L2 regularization is correct. Optionally note that $L$ here is the smoothness of the original loss, to stay consistent with the chapter's $\kappa=L/\mu$ definition.
- [minor] Correctness & Grounding (line 230): hard-margin SVM in the standard primal is strongly convex only in $w$, not jointly over $(w,b)$. The "Strongly Convex? Yes" cell could be scoped to $w$ or qualified. Low impact since the table is a summary.

## Verdict rationale
The correctness gate passes: no incorrect claims, and the only cited reference resolves. Both original blockers and both majors are fully resolved, and notation discipline is now clean. The three remaining items are minors that do not gate. ACCEPT.
