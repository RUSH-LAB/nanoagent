# Review: books/math/3-linear-algebra/2-matrix-operations.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: REVISE
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 4, Motivation: 5, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 3, Completeness: 4

## Re-review scores
Correctness & Grounding: 4 (gate not cleared), Motivation: 5, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Findings
- [major] Correctness & Grounding (line 193): "$(AB)C$ costs $2 \times 10^7 + 2 \times 10^3 \approx 2 \times 10^7$" -> The second term is still wrong. With m=1000, k=10, n=1000, p=1 the term 2mnp = 2 x 1000 x 1000 x 1 = 2,000,000 = $2 \times 10^6$, not $2 \times 10^3$. This was flagged in the original review and was NOT fixed in the revision. The displayed worked computation contradicts its own arithmetic. The total ($\approx 2 \times 10^7$) and the 500x claim (actual 550x) remain fine; only the intermediate figure needs to change to $2 \times 10^6$.
- [minor] Completeness / Notation (line 7): "This chapter covers the core operations on matrices" -> This file is a section (sidebar_position 2), not a chapter. Change "This chapter" to "This section". Same wording also appears in the notation table caption (line 214, "Notation used in this chapter").
- [minor] Worked Examples: the section still has only one <Example> (attention), which illustrates the three views conceptually rather than walking a numeric computation step by step. Consider adding one fully worked numeric example (small explicit AB product or a 2x2 inverse/determinant) plus a harder follow-up with faded guidance, per the rubric's expectation of step-by-step computation. Not a gate failure, but it caps Worked Examples at 3.

## Resolved since original
- Em-dash / double-hyphen cleanup is complete and correct. The remaining "--" matches are only YAML frontmatter delimiters (lines 1, 3) and Markdown table separator rows (lines 34, 89, 201, 217), which are required syntax.
- "Moore-Penrose" now uses a single hyphen in both the Definition name (line 98) and the notation table (line 220).
- The "arrays of numbers" sentence (line 7) and the "500x difference" parenthetical (line 193) no longer use the forbidden dash.

## Why not ACCEPT
The Correctness & Grounding gate is not cleared: a numeric worked computation displays an incorrect intermediate FLOP figure ($2 \times 10^3$ where $2 \times 10^6$ is correct). This is a one-character fix but it is a factual error in displayed math, so the verdict stays REVISE.

## Left for human
- None

## Remaining issues after repair
- [major] line 193: change $2 \times 10^3$ to $2 \times 10^6$.
- [minor] lines 7 and 214: replace "chapter" with "section".
- [minor] add a step-by-step numeric worked example to lift Worked Examples above 3.
