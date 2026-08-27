# Review: books/programming/3-cuda-and-gpu/1-first-kernel.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings
- [resolved] Notation Consistency and Component Discipline: All prose, caption, and code-comment "--" occurrences from the original review are gone. The SIMT line (11), ceiling-division remark, launch-failure remark, async remark, the four built-in-variable comments (57-60), the stride-loop comment (175), and the code-first-kernel-5 caption now use colons. Verified by scan: the only "--" tokens left are the frontmatter fences (lines 1, 3) and Markdown table separator rows (128, 150, 276), which are structural syntax, not prose. No em-dash characters present.
- [minor] Worked Examples and Illustration: The Vector Addition section still teaches purely through code listings with no <Example> tracing a concrete numeric computation (e.g., tid values for a small n and the resulting c[tid]). Not a gate issue; would lift Worked Examples toward 5.
- [minor] Notation Consistency and Component Discipline: The caption on the first code block (line 13) is truncated and garbled: "A kernel is a function that runs on the GPU, executed by thousands of thr." Tidy to a complete sentence such as "A minimal CUDA kernel: a __global__ function launched across multiple blocks and threads." Cosmetic, does not block.
- [minor] Notation Consistency and Component Discipline: rmk-kernel-launch-syntax uses HTML entities &lt;&lt;&lt;grid, block&gt;&gt;&gt; while raw triple chevrons appear inside code fences elsewhere. The entity form renders correctly in MDX prose; backtick-wrapped literal would be more consistent but is optional.

## Changes made
None in this pass. The revision under review already removed all prose, caption, and code-comment "--" occurrences and preserved all math, code, frontmatter, and MDX components. The blocker that drove the original REJECT (house-style "--" ban) is fully addressed.

## Left for human
- Optional: tidy the truncated first-block caption (line 13) and consider adding one small numeric worked trace to the Vector Addition section.

## Remaining issues after repair
- None blocking. Two minor cosmetic items remain open (truncated line-13 caption; optional worked numeric trace), neither affects correctness or the house-style gate.
