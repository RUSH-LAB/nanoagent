# Review: books/math/4-calculus-and-optimization/4-constrained-optimization.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 60
- Broken citekeys: ["duchi2008simplex"]

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Findings
- [blocker] Correctness and Grounding: "set $\Pi(z)_i = \max(z_i - \tau, 0)$ [@duchi2008simplex]" -> The citekey duchi2008simplex did not resolve in references.yaml. RESOLVED: a complete entry now exists at references.yaml lines 36-46 (Duchi, Shalev-Shwartz, Singer, Chandra; "Efficient Projections onto the l1-Ball for Learning in High Dimensions"; ICML 2008). The in-text citation on line 172 now resolves.
- [blocker] Notation Consistency and Component Discipline: prose and title used "--" as an em-dash substitute, which the repo house style forbids. RESOLVED: a full-file scan now shows "--" only on lines 1 and 3 (frontmatter fences) and lines 147, 182, 200 (Markdown table separator rows), all of which the rules permit. The six prose connectors were rewritten with commas, colons, or light rephrasing, and the "Karush-Kuhn-Tucker" name uses single hyphens in both the theorem title (line 65) and the notation table (line 210). No unicode em-dash or en-dash characters are present.

## Re-review scores (Rubric B)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verdict rationale
Both blockers from the original review are fixed and independently verified: the citekey resolves to a complete bibliographic entry, and no forbidden "--" remains in prose or component titles. The correctness gate passes with no math errors. The remaining items are minor precision and pedagogy notes that do not block publication.

## Remaining issues (minor, non-blocking)
- [minor] Worked Examples: the SVM dual on lines 130-134 jumps from the Lagrangian setup to the final dual form. Consider adding one or two intermediate lines (stationarity in w, b, xi giving $w = \sum_i \alpha_i y_i x_i$, $\sum_i \alpha_i y_i = 0$, $\alpha_i + \mu_i = C$) so the box constraint $0 \le \alpha_i \le C$ is derived rather than asserted.
- [minor] Completeness: the KKT theorem (lines 65-72) states necessity without noting that necessity requires a constraint qualification (such as Slater or LICQ). One clause would prevent a reader from applying KKT where it fails.
- [minor] Correctness precision: the dual function definition on line 101 omits that $d$ may equal $-\infty$ off the domain; the dual domain $\lambda \ge 0$ is stated correctly in the dual problem on line 105, so this is a precision note only, not an error.

## Left for human
- Confirm the URL on references.yaml line 46 (https://dl.acm.org/doi/10.1145/1390156.1390191) matches the project's preferred citation link convention. The bibliographic fields are verified; only the link style needs a glance.
