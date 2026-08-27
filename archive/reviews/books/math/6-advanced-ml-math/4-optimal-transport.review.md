# Review: books/math/6-advanced-ml-math/4-optimal-transport.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (re-review)
Correctness and Grounding (gate): 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior repairs
- All four previously broken citekeys now resolve in references.yaml: gulrajani2017improved (Improved Training of Wasserstein GANs, NeurIPS 2017), miyato2018spectral (Spectral Normalization for GANs, ICLR 2018), lipman2023flow (Flow Matching for Generative Modeling, ICLR 2023), liu2023flow (Flow Straight and Fast / Rectified Flow, ICLR 2023). Each entry carries accurate authors, year, venue, and arXiv URL. arjovsky2017wgan also present.
- Brenier's theorem now stated correctly. The Monge vs. Kantorovich remark reads the optimal map as T*(x) = grad(psi) with psi convex, and explicitly notes that when T*(x) = x - grad(phi), the convex Brenier potential is psi(x) = (1/2)||x||^2 - phi(x), not phi itself. The earlier wrong attribution of convexity to phi is fixed.
- No prose double-hyphens or em-dashes remain. The only "--" matches are required syntax: frontmatter delimiters (lines 1, 3) and markdown table separator rows (lines 51, 199, 217, 232). Both flagged prose dashes (Kantorovich definition line 18, Sinkhorn GPU bullet line 146) were reworded.
- Working math, code (Sinkhorn algorithm block), frontmatter, and custom MDX components (Definition, Equation, Remark, Theorem, Algorithm, Table, Example) are intact.

## Findings
- [minor] Notation Consistency and Component Discipline: line 78, the diagonal Bures formula W_2^2 = ||m_1 - m_2||^2 + sum_i (sigma_{1,i} - sigma_{2,i})^2 uses sigma while lines 70 and 74 use Sigma for the covariance. The identity is correct only if sigma_i denotes the standard deviation (square root of the diagonal variance). A one-line clarification that sigma_{k,i} is the per-coordinate standard deviation, or switching to sqrt(Sigma_{k,i}), would remove the one-symbol-two-quantities ambiguity. Cosmetic; does not affect the gate.

## Decision
The original REJECT was driven entirely by gate-level correctness failures: four unresolved citations and a misstated Brenier theorem. All gate blockers are now fixed and verified against references.yaml. The remaining sigma-vs-Sigma item is a minor, non-blocking notation polish. The section is correct, well motivated, well scaffolded, and self-contained. Verdict: ACCEPT.

## Remaining issues after repair
- [minor, optional] Disambiguate sigma vs Sigma in the diagonal Bures formula on line 78 (clarify sigma is the standard deviation, or write sqrt(Sigma)).
