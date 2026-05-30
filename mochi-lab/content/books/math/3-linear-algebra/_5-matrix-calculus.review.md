# Review: books/math/3-linear-algebra/5-matrix-calculus.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 2, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Verification of claimed fixes
- [confirmed] Blocker fix (line 178): $\text{tr}(A^{-1}B)$ gradient now reads $-A^{-\top}B^\top A^{-\top}$. Verified via differential: $d\,\text{tr}(A^{-1}B) = -\text{tr}(A^{-1}BA^{-1}\,dA)$, so the gradient is $-(A^{-1}BA^{-1})^\top = -A^{-\top}B^\top A^{-\top}$. This is correct for general $B$. The correctness gate now passes.
- [confirmed] Line 89: the prose now reads "rather than full Jacobians: the VJP" with no literal "--".
- [confirmed] Line 130: the prose now reads "$10^{18}$ bytes, hence" with no literal "--".
- [confirmed] No prose "--" and no Unicode em-dash remain. The only "--" matches in the file are the frontmatter delimiters (lines 1, 3) and Markdown table header separators, which are required syntax.
- [spot-check] Related identity $a^\top A^{-1}b \to -A^{-\top}ab^\top A^{-\top}$ (line 181) independently verified correct.

## Findings (remaining, all minor, non-blocking)
- [minor] Correctness & Grounding (line 130): "For a neural network with $n = 10^9$ parameters, $H$ would require $10^{18}$ bytes". $H$ has $n^2 = 10^{18}$ entries; in bytes this is 4 to 8 times larger (single or double precision). The order of magnitude is defensible, but conflating entry count with byte count is loose. Consider stating "about $10^{18}$ entries" or scaling the byte figure to "several exabytes" so the units are exact. Does not block ACCEPT.

## Changes made
None in this re-review pass. The prior revision already fixed the blocker and both house-style "--" violations; this pass independently verified those fixes.

## Left for human
- Optional: tighten the byte-vs-entry-count phrasing on line 130 for unit precision.

## Remaining issues after repair
- The line-130 byte-count imprecision (entries vs. bytes) is the only open item. It is a minor numerical-phrasing nit, order-of-magnitude defensible, and does not block ACCEPT.
