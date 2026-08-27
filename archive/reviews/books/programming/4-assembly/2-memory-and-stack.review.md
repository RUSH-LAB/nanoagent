# Review: books/programming/4-assembly/2-memory-and-stack.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Scores (re-review)
Correctness & Grounding: 4, Motivation: 4, Worked Examples: 4, Cognitive Load & Scaffolding: 4, Notation & Component Discipline: 4, Completeness: 4

## Verification of prior findings
- [resolved] Worked Examples: Two <Example> components now exist in the Stack Frames section. ex-prologue-rsp-rbp traces RSP and RBP instruction by instruction through push/mov/sub starting from a stated RSP. ex-epilogue-rsp-rbp is a harder companion with faded guidance (boxed unknown plus a collapsible solution) that walks mov/pop/ret and shows the frame is balanced. The arithmetic is internally consistent: 0x7FFFFFFFE000 - 8 = 0x7FFFFFFFDFF8, minus 32 (0x20) = 0x7FFFFFFFDFD8, and the epilogue restores RSP to 0x7FFFFFFFE008, matching the pre-CALL caller RSP. The rubric requirement for a step-by-step worked example plus a faded second example is satisfied.
- [resolved] Notation and Component Discipline: All five prose double-hyphen occurrences are removed. Line 7 now uses parentheses, the "stack frame, a region" clause on line 53 uses a comma, the PyTorch reserved/allocated sentence on line 207 uses a colon, and the CUDA Unified Memory sentence on line 228 uses a colon. The remaining matches in the file are ASCII box-art, Markdown table separators, and the box-drawing comment dividers in code blocks, all of which are diagram content and correctly left intact.

## Remaining issues after repair
- [minor] Correctness and Grounding: Line 48 still states PyTorch CPU tensors are "allocated on the heap via `malloc`/`jemalloc`", and the code comment on lines 187-188 still lists "posix_memalign (64-byte aligned) or jemalloc". jemalloc is not a built-in PyTorch CPU allocator path; the default c10::DefaultCPUAllocator uses posix_memalign drawing from the linked libc malloc, and jemalloc/tcmalloc are opt-in only via LD_PRELOAD. Non-blocking but worth a future correction.
- [minor] Correctness and Grounding: Line 239 still claims "float array[16]; // 16 * 4 = 64 bytes = exactly one cache line". The single-cache-line fetch only holds when the array is 64-byte aligned; a plain stack/global float[16] can straddle two lines. Adding "(when 64-byte aligned)" or an alignas(64) would make the claim strictly true. Non-blocking.
- [minor] Notation and Component Discipline: Registers (RSP, RBP, RIP, RBX, R12-R15) are still used without a back-link to the prior x86-basics section. A <Ref> or anchor link would avoid silently assuming the prerequisite. Non-blocking.

## Verdict rationale
The Correctness and Grounding gate passes. Both major findings from the original review are fully resolved, and only three minor, non-blocking items remain, none of which fabricate facts or break the exposition. Verdict raised from REVISE to ACCEPT.
