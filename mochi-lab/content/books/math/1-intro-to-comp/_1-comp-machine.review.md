# Review: books/math/1-intro-to-comp/1-comp-machine.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 50
- Broken citekeys: ["katz2017reluplex","blum1989training","alman2021refined","telgarsky2016benefits","eldan2016power","yarotsky2017error","montufar2014number","belkin2019reconciling"]

## Original scores
Correctness & Grounding: 2, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 2, Completeness: 3

## Re-review scores
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 3

## Verification of prior fixes
- [resolved] Correctness gate: the cuBLAS/Strassen claim (line 96) now reads correctly. Classical GEMM in cuBLAS is O(n^3); Strassen achieves O(n^2.81) but is rarely used in production due to numerical error and memory overhead; the galactic O(n^2.37) bound [@alman2021refined] is theoretical only. This matches the reviewer-specified correction and removes the false "cuBLAS uses Strassen" assertion.
- [resolved] Notation gate: all eight previously broken citekeys now resolve exactly once in references.yaml: katz2017reluplex, blum1989training, alman2021refined, telgarsky2016benefits, eldan2016power, yarotsky2017error, montufar2014number, belkin2019reconciling. Confirmed via per-key count.
- [resolved] Double descent (line 149) cites belkin2019reconciling, which now resolves to Belkin et al. 2019 PNAS, "Reconciling Modern Machine-Learning Practice and the Classical Bias-Variance Trade-off", the correct origin paper. It was not silently swapped to nakkiran2021deep.
- [resolved] House style: no prose double-hyphen remains. The only matches are the YAML frontmatter fences (lines 1, 3) and markdown table separators (lines 80, 133, 160), all required syntax. Church-Turing now uses a single hyphen in the heading and Definition name (lines 27, 29).
- [resolved] Completeness: index.md in 1-intro-to-comp lists this section with a working relative link to ./1-comp-machine.md, so the section is not orphaned.

## Remaining issues after repair (minor, non-blocking)
- [minor] Completeness: the complexity table introduces #P, PSPACE, and BPP (lines 85-87) but the Notation Summary table (lines 159-172) lists only P, NP, NP-hard. Add these three classes to the notation table or gloss each once in prose so the table is self-contained.
- [minor] Worked Examples: both examples (palindrome at line 24, ReLU regions at line 125) assert results rather than walk a faded step-by-step computation. Rubric B prefers at least one fully worked numeric instance. Consider a small concrete 2-neuron ReLU net producing 3 explicit linear pieces.
- [minor] Correctness: the halting-problem diagonalization (lines 53-57) defines D via H(P,P) but the contradiction uses H(D,D). It is correct, but adding one clause stating that D(P) runs H(P,P) (so D feeds P its own source and the self-application D(D) is well defined) would prevent a careful reader stumbling.

## Decision rationale
The correctness gate now passes and both original blockers (false cuBLAS/Strassen claim and eight unresolved citekeys) are fixed and verified. The three remaining items are minor polish, not blockers, so the verdict moves from REJECT to ACCEPT.

## Left for human
- The seven newly added references plus the concurrently added belkin entry use bibliographic details from general knowledge of these well-known papers; confirm venue/year/URL fields match house conventions, especially blum1989training (often cited as "Training a 3-node neural network is NP-complete", NeurIPS/NIPS 1988 proceedings) and alman2021refined (SODA 2021).
- references.yaml was edited concurrently during the session and grew substantially; run a final dedup/lint pass after all jobs finish. A spot check found no duplicate top-level keys among the keys cited here.
