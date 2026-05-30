# Review: books/programming/2-torch/2-autograd.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 8
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 5

## Findings
- [blocker] Correctness and Grounding: "y_hard = y_soft.detach() + (quantize(y_soft) - y_soft).detach()" -> Detach only the second term: y_hard = y_soft + (quantize(y_soft) - y_soft).detach(). As written, both terms are detached, so y_hard.requires_grad is False and no gradient reaches y_soft, which defeats the entire purpose of the straight-through estimator (the canonical form, e.g. VQ-VAE z + (z_q - z).detach(), leaves the first term attached so the identity gradient flows back to the continuous input). RESOLVED: line 259 now reads y_hard = y_soft + (quantize(y_soft) - y_soft).detach(), so the first term is attached and the identity gradient reaches y_soft.
- [blocker] Notation Consistency and Component Discipline: "When you need to define custom forward and backward behavior -- for non-standard operations, memory-efficient backward passes, or interfacing with non-PyTorch code:" -> Replace ' -- ' with a comma, parentheses, or a colon per repo house style (no '--' or em-dash). This and 7 other '--' dash usages (lines 65, 108, 132, 265, 304, 357, 358, 368) all violate the mandatory no-double-hyphen rule; 8 occurrences total. Note table rules (|----) and the YAML frontmatter --- are legitimate and excluded from this count. RESOLVED: all 8 prohibited occurrences removed. A scan now finds only the YAML frontmatter delimiters (lines 1, 3) and Markdown table separators (lines 43, 209, 256, 378), all of which are legitimate and excluded. No em-dash or en-dash characters present.
- [minor] Correctness and Grounding: "# EVEN BETTER: set_to_none=True (default in PyTorch 2.0+)" -> The set_to_none default did flip to True in modern PyTorch 2.x, so the substance is correct, but the precise release where the default changed is not cleanly 2.0 in all docs. Either keep the simpler 'default in modern PyTorch (2.x)' phrasing or cite the version to avoid a version-pinning claim a reader might disprove on an older 2.0 install. STILL OPEN (non-blocking): line 130 still reads "default in PyTorch 2.0+".

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Changes made
The author fixed the straight-through estimator blocker by attaching the first term: line 259 now reads y_hard = y_soft + (quantize(y_soft) - y_soft).detach(), so the identity gradient flows to y_soft (matching the canonical VQ-VAE form). All 8 prohibited "--" occurrences were removed by restructuring with parentheses, commas, or rephrasing while preserving meaning, math, and code semantics. No em-dash or "--" remains except the YAML frontmatter delimiter and table separators, which are excluded. No math, numbers, citations, frontmatter, or MDX components were altered.

## Left for human
- None

## Remaining issues after repair
- [minor, non-blocking] Line 130 still pins the set_to_none default to "PyTorch 2.0+". Substantively correct but a tighter phrasing such as "default in modern PyTorch (2.x)" would avoid a version-specific claim. Does not block acceptance.
