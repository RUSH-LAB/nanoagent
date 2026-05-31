# Review: books/math/6-advanced-ml-math/1-attention-and-transformers.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 6
- Broken citekeys: ["shazeer2020glu","peng2023yarn","press2022train","liu2023ring"]

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores (after revision)
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings
- [resolved] Correctness and Grounding: All four previously broken citekeys now resolve in references.yaml. Verified shazeer2020glu (arXiv:2002.05202), peng2023yarn (arXiv:2309.00071), press2022train (arXiv:2108.12409), and liu2023ring (arXiv:2310.01889). The gate is now passed.
- [resolved] Notation Consistency and Component Discipline: All six prose em-dash occurrences (lines 7, 26, 171, 181, 187) are gone. The only remaining "--" strings in the file are the YAML frontmatter delimiters (lines 1, 3) and Markdown table separator rows (lines 95, 155, 200, 227, 242), none of which are prose. House style is satisfied.
- [minor, open] Correctness and Grounding (line 71): "With $h$ heads, the combined attention matrix has rank up to $h$." remains stated as fact. The preceding clause was softened to "approximately rank-1" and "higher effective rank", but the final sentence is still a hard claim. Recommend softening to "effective rank up to roughly $h$" or citing voita2019analyzing (already present in references.yaml). Non-blocking.
- [minor, open] Worked Examples and Illustration: The section still contains no `<Example>` component. Strong numeric walkthroughs exist (KV-cache memory in rmk-kv-cache-memory, std-dev reasoning in rmk-attention-scaling, parameter count in rmk-parameter-count), but they live inside `<Remark>` blocks rather than a faded-guidance `<Example>`. This caps the Worked Examples score at 3. Non-blocking but worth a future pass.
- [minor, open] Notation Consistency and Component Discipline (lines 58-60): The second display equation inside def-multihead ($\text{head}_i = \text{Attention}(\dots)$) still sits outside any `<Equation>` wrapper while eq-multihead above it is wrapped. For full component-discipline consistency, wrap both or neither. Minor inconsistency only.

## Verdict rationale
The original REJECT was driven by gate failures (four unresolved citekeys) plus a house-style violation (six prose em-dashes). Both classes of blocker are fully resolved and independently verified. The three items still open are all minor (one soft-claim softening, one missing `<Example>`, one equation-wrapper consistency nit) and do not block publication. Verdict moves to ACCEPT.

## Remaining issues after repair
- Soften the rank-up-to-$h$ claim on line 71 or cite voita2019analyzing.
- Add at least one `<Example>` with faded guidance (could promote the KV-cache or parameter-count walkthrough).
- Wrap the head_i display equation (lines 58-60) in `<Equation>` for consistency with eq-multihead, or unwrap eq-multihead.
- Human verification still owed on the newly added reference author lists and venue fields (YaRN/GLU/Ring marked arXiv, ALiBi marked ICLR); arXiv IDs are confirmed.
