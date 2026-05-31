# Review: books/programming/4-assembly/1-x86-basics.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0 (in prose)
- Broken citekeys: []

## Original scores
Correctness and Grounding: 2, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Verification of prior fixes
- [resolved] Correctness and Grounding (AVX vectorization): Line 181 now reads `gcc -O3 -march=native -ffast-math` and lines 182-183 attribute the auto-vectorization to reassociation, with a note that -ffast-math licenses vfmadd. On a modern CPU, -march=native implies AVX2 and FMA, so the emitted `vmovups ymm`, `vfmadd231ps`, and 32-byte stride are all consistent with the stated flags. The earlier contradiction (default -O3 -mavx2 does not auto-vectorize a float reduction) is gone.
- [resolved] Correctness and Grounding (sign-extension mnemonic): Line 62 now reads `movsxd rax, dword [rsi]`, the correct Intel/MASM mnemonic (REX.W + 63 /r) for 32-to-64-bit sign extension, consistent with the file's canonical Intel/MASM style elsewhere.
- [resolved] Notation Consistency and Component Discipline (house-style em-dash ban): All six prose `--` substitutes (previously lines 7, 48, 252-255) are removed. Remaining `--` occurrences are only frontmatter delimiters and markdown table separators (lines 1, 3, 16, 101, 243, 266), which are required syntax, not prose.

## Residual minor items (non-blocking)
- [minor] Correctness and Grounding: The System V register table (line 19) lists RCX as the 4th integer arg while the Windows comparison table (line 244) uses RCX as the 1st. The table caption already states "(System V AMD64 ABI)", so this is borderline acceptable; an inline note would prevent confusion but is not required.
- [minor] Correctness and Grounding: In the `foo(1,2,3,4,5,6,7,8.0)` example (lines 228-233), the parenthetical "7th integer arg and beyond go on stack" is correct, and line 233 already clarifies 8.0 goes in XMM0. Reads cleanly; optional tightening only.

## Decision rationale
The two correctness blockers/majors and the notation major from the original review are all fixed correctly and conservatively, without introducing new errors. The gate (Correctness and Grounding) now passes. Motivation, scaffolding, worked examples, and completeness were already strong. Only two borderline minors remain, neither blocking. Verdict upgraded from REJECT to ACCEPT.

## Remaining issues after repair
None blocking. Two optional minor clarifications noted above.
