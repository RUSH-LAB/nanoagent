# Review: books/math/2-ml-basics/4-backpropagation.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 5, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 5

## Verification of prior fixes
- [resolved] Citekey lecun2012efficient now exists in references.yaml (line 5372) as a well-formed incollection entry for LeCun, Bottou, Orr and Mueller, "Efficient BackProp" (Neural Networks: Tricks of the Trade, 2nd ed., Springer, 2012). All four citekeys used in the file (he2016resnet, glorot2010understanding, he2015delving, lecun2012efficient) resolve. Gate passes.
- [resolved] No forbidden "--" in prose. The former occurrences on line 37 ("local Jacobian: how its output changes...") and line 151 ("gradient highway: even if...") now use colons. Remaining "--" grep hits are only frontmatter delimiters and Markdown table separators, which are required syntax. No em-dash characters present.
- [resolved] Overloaded-delta inconsistency fixed. The Remark on line 24 now labels the upstream quantity "the upstream gradient at node h_l", states the subscripted convention (delta_{h_l}, delta_{z_l}), and notes that the bare delta_l in the Notation Summary specifically means the pre-activation gradient. This aligns the Remark, the worked-example usage of delta_{h_1}/delta_{z_1} (lines 57-64), and the Notation Summary (line 192). No math was altered.

## Remaining issues after repair
- [minor] Correctness and Grounding: Line 7 still states backprop runs in O(L * C_fwd) time with C_fwd defined as "the forward-pass cost" (whole network). This double-counts the layer factor and conflicts with rmk-linear-layer-grad (line 74), which correctly says the backward pass is approximately the same cost as one forward pass. Either define C_fwd as per-layer forward cost or drop the L factor. Does not gate.
- [minor] Cognitive Load and Scaffolding: The opening paragraph (line 7) does not forward-map the Weight Initialization and Memory Cost sections, so they still read as appended. A one-line section roadmap would help. Does not gate.

## Decision
Final verdict ACCEPT. All blockers and the one major finding from the original review are verifiably resolved; the gate (Correctness and Grounding) passes. Two minor, non-gating issues remain and can be addressed at the author's discretion.

## Left for human
- Confirm the lecun2012efficient bibliography entry renders correctly in the BibliographyItem component, since it uses type: incollection with a Springer chapter URL and a combined venue string, which differs slightly from the article entries it sits beside.
