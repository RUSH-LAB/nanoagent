# Review: books/build-with-ai/components-of-textbooks/4-paper-citation.md

- Content type: docs
- Original verdict: ACCEPT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness: 5, Clarity & structure: 5, Completeness: 4, House style: 5

## Findings
- [minor] Correctness: "Unknown keys render as a red warning without breaking the build." -> Slightly imprecise: the rendered output is an inline red token [?key] (CSS class citation-unknown, color #e53e3e), and a separate non-fatal warning is logged to the build console via file.message. Both are accurate, but 'a red warning' conflates the visible inline token with the log warning. Consider: 'Unknown keys render inline as a red [?key] marker and log a build warning, without breaking the build.'
- [minor] Completeness: "Author formatting: 1 author shows `(Smith, 2024)`, 2 authors `(Smith & Jones, 2024)`, 3+ authors `(Smith et al., 2024)`. Clicking scrolls to the reference at the bottom." -> The page documents inline rendering well but omits how the auto-generated reference list itself renders: full author list joined by commas, sorted by first-author last name then year, with a per-entry detail link (the arrow pointing to /bibliography/{key}). Optionally note these so readers know what the bottom-of-page References list looks like.
- [minor] Completeness: "| `type` | Yes | string | Entry type | `article`, `inproceedings`, `book`, `thesis` |" -> The bibliography plugin (inferBibtexType) also recognizes `phdthesis` and `techreport` as distinct types; references.yaml in practice only uses article/book/inproceedings. The documented set is valid (thesis is handled), so this is optional, but listing techreport (or noting any unrecognized type falls back to misc) would make the reference exhaustive.

## Changes made
None.

## Left for human
- None

## Remaining issues after repair
None
