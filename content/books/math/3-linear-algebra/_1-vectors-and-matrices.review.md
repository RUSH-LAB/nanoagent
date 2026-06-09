# Review: books/math/3-linear-algebra/1-vectors-and-matrices.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 5, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior fixes
- Dashes: confirmed clean. The only "--" tokens left are the frontmatter delimiters (lines 1, 3) and markdown table separators (lines 82, 199); no prose dash pairs and no em-dash or en-dash characters anywhere. The Frobenius/Spectral unit-ball cells now read "n/a" (lines 87-88), and "Gram-Schmidt" uses a single hyphen (lines 137, 142). Resolved.
- Numeric worked example: confirmed. ex-projection-numeric (lines 127-135) projects b=[5,0] onto a=[3,4] step by step, yields proj=[9/5,12/5], and checks the residual is orthogonal (a-dot-residual = 48/5 - 48/5 = 0). I recomputed it independently and it is correct. The Gram-Schmidt example (lines 137-151) now adds a numeric run on a1=[1,1,0], a2=[1,0,1] producing qtilde2=[1/2,-1/2,1] with an orthogonality check. I recomputed and the result is correct.
- Citekey: @hu2022lora (line 171) resolves to an entry in mochi-lab/references.yaml (line 3722). Valid.

## Remaining issues after repair
- [minor] Notation Consistency: theta still does double duty as the angle between vectors (line 44) and as regression parameters (lines 34, 124, 191). A one-line note disambiguating, or distinct symbols, would help. Not a gate.
- [minor] Completeness: the notation summary table (lines 196-213) still omits load-bearing symbols introduced in the text: theta, sigma_max (spectral norm), tr, det, nullity, and the Mahalanobis Sigma/mu. Adding the most-used ones would make the table self-contained.
- [minor] Correctness: line 184 still says the paired subspaces "partition" R^m and R^n. They form orthogonal direct-sum decompositions (col(A) plus ker(A^T) = R^m, row(A) plus ker(A) = R^n), not set partitions, since they share the zero vector. Wording only; the orthogonality claims above it are correct.
- [minor] Correctness: the inner-product axiom (line 51) states positive definiteness as the strict-for-nonzero shorthand without the non-negativity clause. Common shorthand, acceptable.
- [trivial] Gram-Schmidt example, line 146 writes "a_2 - (1/sqrt2) q_1" where the displayed substitution correctly uses (1/2)[1,1,0]; the coefficient phrasing is slightly loose but the computation and result are correct.

## Verdict rationale
The correctness gate passes: all worked arithmetic is recomputable and correct, and the single citekey resolves. Both major findings from the original review (house-style dashes and the absence of a recomputable numeric worked example) are fully resolved. All open items are minor or cosmetic and do not block publication.

## Left for human
- Optional: address the four minor items above (theta disambiguation, notation-table completeness, "partition" wording, axiom phrasing) in a future pass.
