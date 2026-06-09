# Review: books/programming/99-supplement/2-linux-and-shell.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 5

## Findings
- [resolved] Notation Consistency and Component Discipline: The prose "--" in the editable-installs Remark bullet (line 159) is fixed. It now reads "...for editable installs during development: changes to your code take effect immediately without reinstalling." No prose "--", em-dash, or en-dash remains anywhere in the file. The 44 surviving "--" tokens are all legitimate CLI flags inside code blocks, YAML SBATCH directives, or table separator rows. The box-drawing dividers in code comments are U+2500 characters, not dashes.
- [resolved] Worked Examples and Illustration: Two end-to-end <Example> blocks were added to the Essential Commands section. "ex-recover-stuck-gpu" (lines 63-85) chains nvidia-smi -> fuser -> ps -> kill -SIGTERM/-SIGKILL -> nvidia-smi with --gpu-reset as a fallback. "ex-find-disk-hog" (lines 87-106) chains df -h -> du | sort | head -> find *.pt -> cleanup with explicit faded guidance ("Each step below builds on the one before it, with less guidance as you go"). Both reuse only already-documented commands and fabricate no numbers or sources.
- [resolved] Completeness and Self-Containment: index.md at line 6 lists this section with a working relative link "[Linux and Shell](./2-linux-and-shell.md)" that resolves to the file on disk. The index entry exists and is correct.
- [minor] Cognitive Load and Scaffolding: The trap on line 291 references "$PID", but "PID=$!" is not assigned until line 302 (after the srun launch). If SIGUSR1 arrives before assignment, "kill -SIGUSR1" runs against an unset PID. Acceptable as a teaching skeleton; a one-line guard ([ -n "$PID" ]) or reordering would harden it. Not blocking.
- [minor] Correctness and Grounding: Line 84 now reads "the reset kills every process on that GPU, so confirm no one else is running on it first." This is slightly inaccurate: nvidia-smi --gpu-reset actually FAILS if any process is using the GPU and requires root; it does not kill running processes. The practical guidance (confirm the GPU is idle first) is sound, so the residual error is cosmetic. Reword to "requires root and fails unless the GPU is idle" for precision. Not blocking.

## Changes made
None during this re-review pass. Both actionable findings from the original review (the prose "--" blocker and the missing worked Example major) were already repaired in the file before this pass, and the repairs are verified correct.

## Left for human
- None

## Remaining issues after repair
- [minor] Line 291/302 trap references $PID before assignment; harden with a guard or reorder for real-world robustness.
- [minor] Line 84 description of nvidia-smi --gpu-reset behavior ("kills every process") is imprecise; the reset fails on a busy GPU and requires root. Cosmetic.
