# Review: books/build-with-ai/components-of-textbooks/index.md

- Content type: docs
- Original verdict: ACCEPT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness: 5, Clarity & structure: 5, Completeness: 4, House style: 5

## Findings
- [minor] Completeness: "<PageRef path="./figure-and-table" />: auto-numbered, captioned figures and tables" -> Optional only. PageRef is invoked without a label prop, so the link text renders as the bare auto-number (e.g. "Section 1.1") rather than the page title; the page name appears only in the trailing prose, not in the clickable link. The component's own docstring (Math.js line 428) shows label="..." being passed. This is intentional and matches the sibling how-to/index.md convention, so it is not a defect, but if you want the page title inside the link, add label={true} or label="Figure and Table". No change required.
- [minor] Correctness: "cite papers with `[@key]` syntax" -> No fix needed. Confirming this `[@key]` is illustrative inline code documenting citation syntax, not a real pandoc citation, so it is correctly excluded from brokenCitekeys. references.yaml exists and the file contains zero real [@citekey] references.

## Changes made
None.

## Left for human
- None

## Remaining issues after repair
None
