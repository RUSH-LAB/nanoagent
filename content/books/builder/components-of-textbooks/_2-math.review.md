# Review: books/build-with-ai/components-of-textbooks/2-math.md

- Content type: docs
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 5

## Re-review scores
Correctness: 5, Clarity and structure: 4, Completeness: 5, House style: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: The two em-dash characters previously in the "Color" column (the `<Equation>` and `<Code>` rows of the "All Available Environments" table) have been replaced with "None". A fresh scan finds zero em-dash (U+2014) and zero en-dash (U+2013) characters in the file. The remaining `---` matches are valid Markdown frontmatter delimiters, horizontal-rule section dividers, and the table header separator, not prose em-dashes.
- [verified] Correctness: All documented component signatures match src/components/Math.js. `<Equation id>` maps to `Equation({ id, children })`; `<Definition id name>` and `<Theorem id name>` map to the `createNumberedBlock` factory which accepts `{ id, name, children }`; `<Proof>` maps to `Proof({ children })` (unnumbered, no id); `<Table id caption>`, `<Code id caption>`, and `<Algorithm id caption>` all match their respective signatures.
- [verified] Correctness: Every "Color" claim in the environments table matches the actual CSS in Math.js. Theorem/Lemma/Proposition/Corollary use the shared blue-gray style (#f0f4f8), Definition is green (#f0f8f0), Remark is yellow (#fdf8e8), Example is purple (#f5f0fa), Proof has a left border, Equation and Code have no background or border ("None"), and Algorithm is bordered.
- [verified] Grounding: No paper citekeys are used in this doc, so there is nothing to check against references.yaml. Cross-references use the same-page `[](#id)` anchor form, which is valid.
- [minor] Clarity and Structure: "Reference them inline: the cross-entropy loss [](#eq-cross-entropy-example) uses the softmax [](#eq-softmax)." The link-rewriting code in Math.js (lines 119-122) sets the empty link text to "Equation N", so this renders as "the cross-entropy loss Equation 1 uses the softmax Equation 2", which reads slightly awkwardly. Optional reword to "the cross-entropy loss in [](#eq-cross-entropy-example) uses the softmax in [](#eq-softmax)". The syntax is correct; this does not block.
- [minor] Notation Consistency and Component Discipline: Inside `<Definition>` and `<Theorem>` the display `$$` block abuts the closing tag with no blank line (lines 51-52 and 57-58), unlike the `<Equation>` examples (lines 30-34) which leave blank lines on both sides. It renders correctly, but adding a blank line before the closing tag would match the page's own demonstrated safe pattern.

## Changes made
None in this pass. The em-dash fix from the prior REVISE pass was already applied to the file (the two "Color" cells now read "None", which accurately conveys that those components have no color styling and matches the table's tone).

## Left for human
- None

## Remaining issues after repair
- Two cosmetic, non-blocking items remain: the inline `[](#id)` references on line 42 read slightly awkwardly once auto-numbered to "Equation N", and the `$$` blocks inside `<Definition>`/`<Theorem>` lack a blank line before the closing tag. Both render correctly and neither affects correctness, completeness, or house-style compliance.
