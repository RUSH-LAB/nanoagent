# Review: books/build-with-ai/components-of-textbooks/3-code.md

- Content type: docs
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 3

## Re-review scores
Correctness: 4, Clarity and structure: 5, Completeness: 4, House style: 5

## Verification performed
- Confirmed the file lives at content/books/builder/components-of-textbooks/3-code.md (the task path said build-with-ai; the actual book directory is builder).
- Confirmed Code, Table, and Algorithm are real components exported from src/components/Math.js and registered in src/theme/MDXComponents.js. Their signatures all accept the documented props: Code({ id, caption, children }), Table({ id, caption, columns, children }), Algorithm({ id, caption, children }). The documented usage matches.
- Confirmed the caption renders as "Code N", which matches the prose reference to "Code 2".
- Confirmed the cross-reference syntax [](#id) is the correct on-page convention, consistent with 5-cross-reference.md.
- Confirmed the major fix #2 claim: docusaurus.config.js sets prism.theme = prismThemes.github and prism.darkTheme = prismThemes.dracula. The "light and dark theme support" sentence is now grounded.
- Confirmed the major fix #1 claim: the # highlight-next-line directive plus highlight-start/highlight-end and {2,4-6} range syntax are standard Docusaurus code-block features, so the added sentence is accurate and makes Code 2 reproducible.
- Confirmed 0 em-dash and 0 en-dash characters. No paper citekeys appear in this file, so there are no citekeys to validate.

## Findings
- [major, RESOLVED] The two original major findings (highlight directive undocumented; light/dark theme promise undelivered) are both fixed in the revised file. Line 8 now explains the prism.theme / prism.darkTheme config and color-mode behavior, and line 57 documents the highlight directives. Both claims were verified against the real config and are accurate.
- [minor, OPEN] Supported Languages table overpromises for three tags. The site has no additionalLanguages setting in docusaurus.config.js, so only the languages bundled by prism-react-renderer are active. Verified against the bundled set: python, js, ts, c, cpp, rust, sql, yaml, json all work, but bash, java, and latex are NOT bundled and fall back to plaintext. (Note: the original minor finding cited latex, rust, and sql as needing additionalLanguages, but rust and sql are in fact bundled by default; the real gaps are bash, java, and latex.) Recommended fix: add additionalLanguages: ['bash', 'java', 'latex'] to the prism config, or add one sentence under Table 1 noting that bash, java, and latex require enabling additionalLanguages. This is a small caveat and does not block acceptance.

## Changes made
None in this pass. The two major findings were already repaired and verified in the prior revision; the file is now accurate and reproducible for every claim except the three language tags noted above.

## Left for human
- Decide how to deliver bash, java, and latex syntax highlighting: either add additionalLanguages: ['bash', 'java', 'latex'] to docusaurus.config.js, or add a one-sentence caveat under Table 1. Either choice closes the only open correctness gap.
- The remaining "--" sequences in the file are structural markdown (YAML frontmatter delimiters and horizontal-rule separators between sections, plus the table header separator row). None are em-dashes or prose dashes, so they were left unchanged.

## Remaining issues after repair
- Table 1 lists bash, java, and latex, which are not in the default Prism build and have no additionalLanguages config, so they silently render as plaintext. Add the config entry or a caveat.
