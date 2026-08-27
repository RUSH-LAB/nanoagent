# Review: books/math/3-linear-algebra/3-eigendecomposition.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior repairs
- [resolved] Correctness and Grounding: `dauphin2014identifying` now has a complete, correctly attributed entry in references.yaml (Dauphin, Pascanu, Gulcehre, Cho, Ganguli, Bengio; NeurIPS 2014; arXiv:1406.2572). YAML parses; key present. The [@dauphin2014identifying] citation will render.
- [resolved] Notation Consistency: the overloaded $L$ is fixed. Gradient Lipschitz constant is now $\beta$ (line 98), graph Laplacian is $L_{\text{graph}} = D - W$ (line 100), and $L$ is reserved for the Cholesky factor. All three appear in the Notation Summary (lines 227 to 229).
- [resolved] Notation Consistency: the generic input matrix $A$ is no longer silently redefined; the adjacency matrix uses $W$.
- [resolved] House style: no prose em-dashes or double hyphens remain. The only `--` matches are YAML frontmatter delimiters (lines 1, 3) and Markdown table separator rows (lines 116, 138, 164, 215), which are required syntax.

## Remaining findings
- [minor] Worked Examples and Illustration: still only one fully computed numerical Example (ex-eigen-2x2). The power-iteration block (ex-power-method) states a formula and applications but works no numerical iteration. Rubric B expects a second, harder fully worked example with faded guidance (e.g. a 3x3 symmetric spectral decomposition or a couple of numeric power-iteration steps) to satisfy the expertise-reversal progression. This caps the Worked Examples score at 3 and is the main reason the verdict is REVISE rather than ACCEPT.
- [minor] Correctness and Grounding: "GD converges as $\left(\frac{\kappa - 1}{\kappa + 1}\right)^t$" (line 172) holds for the optimal fixed step size on the quadratic (per-iteration A-norm error contraction). State the step-size assumption so a reader does not apply it to an arbitrary GD run.
- [minor] Correctness and Grounding: the PD vs PSD minors row (line 118) is correct but subtle; PD needs only leading principal minors positive (Sylvester), whereas PSD needs ALL principal minors nonnegative. A one-line note would prevent a reader inferring that leading minors suffice for PSD.

## Verdict rationale
Correctness gate now passes: the only prior correctness blocker (a citekey with no entry) is fixed, and no claims were altered. All notation blockers are resolved and self-consistent within the chapter. Remaining items are minor (one missing harder worked example, two optional clarifying caveats), so the verdict moves from REJECT to REVISE.

## Left for human
- The graph-Laplacian rename to $L_{\text{graph}}$ and $W$ for adjacency is self-consistent within this chapter; if sibling linear-algebra chapters use $L = D - A$, align notation across the book.
