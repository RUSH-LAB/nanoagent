# Review: books/build-with-ai/components-of-textbooks/5-cross-reference.md

- Content type: docs
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Findings
- [resolved] Correctness and Grounding: The previously broken row now reads `<Ref id="eq-cross-entropy-example" />` (line 35), matching the `<Equation id="eq-cross-entropy-example">` defined on line 30 of the sibling page ./2-math.md. The demo now resolves correctly to the page the table lists as Source Page = Math.
- [resolved] Notation Consistency and Component Discipline: The em-dash on line 8 is gone; the sentence now reads "available globally, no import needed." No other em-dashes exist (the only `--` matches are valid markdown table delimiter rows).
- [verified] Correctness and Grounding: All 11 cross-reference ids in the three tables resolve to real components on their stated source pages. Math (./2-math.md): `def-convex`, `thm-jensen`, `eq-cross-entropy-example`, `eq-softmax`. Figure and Table (./1-figure-and-table.md): `fig-agent-loop`, `fig-retrieval`, `tab-agent-types`, `tab-benchmarks`. Code (./3-code.md): `code-transformer`, `code-train-step`, `alg-sgd`. The same-page syntax examples (`[](#def-convex)`, `[](#eq-cross-entropy)`) inside the code fence are illustrative, not live references, and were correctly left untouched.
- [minor, non-blocking] Notation Consistency and Component Discipline: The claim that all math components are "available globally, no import needed" is asserted but not pointed to a config source. This is a soft documentation nicety, not a correctness issue, and does not block acceptance. A one-line pointer to the MDX provider config could be added later for reader trust.

## Conclusion
The blocker and the em-dash issue from the prior review are both fixed. Every documented cross-reference now resolves to a real component on its named source page, which is the sole purpose of this page. The single remaining note is a non-blocking documentation polish suggestion.

## Remaining issues after repair
- [non-blocking] Optionally add a one-line pointer to the MDX provider config that makes math components globally available, to substantiate the "no import needed" claim.
