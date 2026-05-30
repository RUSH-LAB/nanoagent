# Review: books/build-with-ai/components-of-textbooks/1-figure-and-table.md

- Content type: docs
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness: 5, Clarity & structure: 5, Completeness: 4, House style: 3

## Final scores
Correctness: 5, Clarity & structure: 5, Completeness: 4, House style: 5

## Findings
- [resolved] House style: The prior em-dash on the line "Figures can contain any content ... images, diagrams, code blocks, or even React components." has been restructured to "any content, including images, diagrams, code blocks, or even React components." No em-dashes or prose double-dashes remain. The standalone "---" lines (10, 32, 62) are markdown horizontal rules and the "|---|" rows are table separators, both legitimate markdown syntax, not style violations.
- [minor, open] Completeness: The examples rely on blank lines inside the `<Figure>` and `<Table>` wrappers (the blank line before the image and before the closing tag) so MDX parses the inner markdown, but the prose never states this. A reader copying a tighter layout will get unrendered output. One sentence noting that wrapper components need blank lines around their markdown content would close this gap. Not blocking.

## Correctness verification
- Component signatures match the source. `Figure({ id, caption, children })` and `Table({ id, caption, columns, children })` are defined in src/components/Math.js (Figure at line 266, Table at line 304) and registered in src/theme/MDXComponents.js.
- The documented `columns` values "center", "left", "right" match the component comment and the CSS classes numbered-table--cols-center/left/right in src/css/custom.css (lines 206 to 217).
- The cross-reference syntax `[](#id)` matches the convention documented in 5-cross-reference.md.

## Changes made
None this pass. The single em-dash flagged in the original REVISE was already repaired before this re-review.

## Left for human
- Optional: add one sentence documenting the blank-line requirement inside wrapper components.

## Remaining issues after repair
None blocking. One minor completeness suggestion remains open (blank-line-inside-wrapper note), but it does not block acceptance.
