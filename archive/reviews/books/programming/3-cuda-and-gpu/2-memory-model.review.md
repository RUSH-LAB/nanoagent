# Review: books/programming/3-cuda-and-gpu/2-memory-model.md

- Content type: textbook
- Original verdict: ACCEPT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 5, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Findings
- [minor] Correctness and Grounding: "| Registers | Per thread | ~255 x 32-bit per thread | ~1 cycle | ~20 TB/s | R/W |" -> The aggregate register-file bandwidth on an H100 is far higher than shared memory (tens of TB/s, well above the ~12 TB/s shared figure), so listing registers at ~20 TB/s next to shared at ~12 TB/s understates and flattens the gap. The per-SM combined L1/shared SRAM is documented at ~31-33 TB/s by NVIDIA, so the ~12 TB/s shared and ~12 TB/s L2 figures are also low. These are approximate and hedged with ~, but consider citing NVIDIA's Hopper numbers or relabeling as illustrative orders of magnitude.
- [minor] Correctness and Grounding: "| Shared Memory | Per block | Up to 228 KB per SM | ~20-30 cycles | ~12 TB/s | R/W |" -> Scope says 'Per block' but the 228 KB size is a per-SM capacity (max per-block is 227 KB on H100). The mixed scope/size in one row is slightly confusing; clarify that 228 KB is the per-SM shared capacity and per-block usable is 227 KB.
- [minor] Worked Examples and Illustration: "## Shared Memory" -> The section has clear annotated code snippets but no full <Example> component walking a numeric computation end to end (e.g., a tiled load with shared-memory reuse showing the transaction/cycle savings). The rubric favors at least one fully worked <Example> with faded guidance; the current code blocks are illustrative fragments rather than a worked example. Optional enhancement, not a correctness issue.
- [minor] Completeness and Self-Containment: "This chapter covers the memory hierarchy, coalescing rules, shared memory, bank conflicts, and occupancy." -> The intro promises only these five topics and the body delivers them, but Constant Memory and Texture Memory appear in the hierarchy table yet are never discussed in prose. Either add a one-line note on when each is useful or drop them from the table to keep the title's promise self-contained.

## Changes made
None.

## Left for human
- None

## Remaining issues after repair
None
