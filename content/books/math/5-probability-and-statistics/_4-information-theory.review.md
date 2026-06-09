# Review: books/math/5-probability-and-statistics/4-information-theory.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (Rubric B)
Correctness & Grounding: 5, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Verification performed
- All eight citekeys in the file resolve in references.yaml: csiszar1967information, ali1966general, nowozin2016fgan, tishby2000information, belghazi2018mine, tishby2015deep, kullback1951information, oord2018infonce. The six previously missing keys are now present with accurate metadata (verified titles, authors, years, venues, and canonical arXiv/DOI URLs; the Csiszar 1967 print article correctly carries no fabricated URL).
- references.yaml parses as valid YAML (673 keys via js-yaml).
- No prose em-dashes or double-hyphens remain. The only "--" sequences are the frontmatter delimiters (lines 1, 3) and markdown table separator rows (lines 108, 150, 202, 318), all of which are required syntax. The previously flagged prose occurrences (lines 27, 28, 117, 118, 132, 171, 205, 208, 254) now read with colons, commas, or parentheticals.
- The rmk-mutual-info-ml table is now wrapped in a Table component with id "tab-mutual-info-ml" and a caption, matching the section's component discipline.

## Rationale for ACCEPT
Every blocker from the original review is resolved. The gate dimension (Correctness and Grounding) now passes: all citations resolve and the substantive content is accurate. The one major component-discipline issue (uncaptioned data table) is fixed. The house-style em-dash ban is satisfied. The remaining items are all minor polish that do not block publication.

## Remaining issues (minor, non-blocking)
- Worked Examples: no example is carried through to a concrete numeric value. The binary-entropy example (ex-entropy-binary) states the closed form and the maximizer but never plugs in a point such as p = 1/4 to show H is about 0.811 bits. Adding one fully computed numeric instance would strengthen faded-guidance scaffolding.
- Correctness (caveat, not error): the Tishby two-phase information-bottleneck claim (line 258) is presented as a conjecture, which is good, but it would benefit from a one-clause note that the two-phase compression behavior is empirically contested (Saxe et al. 2018 found it depends on the nonlinearity and largely disappears with ReLU).
- Completeness: rmk-information-diagram tells the reader the relationships "can be visualized as a Venn diagram" but no Figure is rendered. Either add the figure or reword so no absent diagram is referenced.
- Notation: the default log base is flagged as ambiguous only in the closing notation table, while the body mixes bits (binary entropy) and nats (perplexity). Stating the default base once near the top would make H = log 2 = 1 bit read consistently.

## Left for human
- Optionally add a stable URL for csiszar1967information if a print-to-digital link is desired (currently omitted by design).
- Optionally double-check the exact venue strings of the six added references against the site citation style.
