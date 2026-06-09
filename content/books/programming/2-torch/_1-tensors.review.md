# Review: books/programming/2-torch/1-tensors.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness & Grounding: 2, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 2, Completeness: 4

## Re-review scores
Correctness & Grounding: 5, Motivation: 4, Worked Examples: 3, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 5, Completeness: 4

## Findings
- [resolved] Correctness & Grounding: The slicing/contiguity example (z = x[:, 1:] on a (2, 3) tensor) now reads "# False" with the parenthetical "contiguous (2, 2) needs stride (2, 1); stride[i] must equal the product of sizes after dim i". The earlier wrong claim that decreasing strides imply contiguity is gone. The transpose case above it also correctly reads "# False".
- [resolved] Correctness & Grounding: The broadcasting-safety example now uses pred of shape (32, 1) and target of shape (32,). Right-aligned these are (32, 1) vs (1, 32), which silently expand to (32, 32), matching the section thesis that broadcasting can produce a wrong result without erroring. The "# WRONG: silently broadcasts to (32, 32)!" comment is now accurate.
- [resolved] Correctness & Grounding: The explanatory sentence now correctly states the right-aligned alignment as "(32, 1) vs (1, 32)" rather than the previous incorrect "(32,) to (32, 1) then to (32, 10)". The leading-singleton prepend rule is now stated correctly.
- [resolved] Notation & Component Discipline: All prose and code-comment em-dash usages have been removed. The only remaining "--" are the YAML frontmatter delimiters (lines 1, 3) and Markdown table separator rows (lines 48, 63, 102, 333), which are structural and required.
- [minor, open] Correctness & Grounding: The dtype table still lists fp16 as "~3 digits" and bf16 as "~2 digits" while the BF16 remark table lists "~3.3" and "~2.4" for the same types. These are consistent as rounded vs precise figures, so it is not a contradiction, but harmonizing to one figure would remove any appearance of mismatch.
- [minor, open] Worked Examples: The section still has a single <Example> block (view-shared-memory). A second harder example with faded guidance (a strides/contiguity storage-index walk-through, or a broadcasting shape-resolution trace) would strengthen the worked-example coverage. Not a blocker.
- [minor, open] Correctness & Grounding: x.contiguous() remains grouped under "COPY operations (new memory allocated)" though its comment correctly notes it is a no-op when already contiguous. Moving it out or annotating the header as "may copy" would be cleaner. Not a blocker.

## Changes made
None in this re-review pass. The file was already revised before this review. All three correctness blockers and the systematic em-dash style violation from the original review are confirmed fixed.

## Left for human
- None

## Remaining issues after repair
- Three minor, non-blocking items remain open: harmonize the two precision figures for fp16/bf16, optionally add a second worked example with faded guidance, and reclassify or relabel contiguous() in the copy/view list. None gate acceptance.
