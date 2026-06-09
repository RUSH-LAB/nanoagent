# Review: books/programming/99-supplement/3-git-for-ml.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 72
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 5, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Findings (re-review)
- [resolved] Worked Examples and Illustration: An `<Example id="ex-experiment-lifecycle">` (lines 36-61) now narrates a single experiment end to end: branch off the baseline, change the learning rate, train, record val_loss=0.42, tag the run, then diff and log against the baseline. It uses numbered faded-guidance steps and reuses the file's own illustrative figures (val_loss=0.42, lr=3e-4) and the "->" metric convention defined in the commit-message Remark. This closes the major gap from the original review.
- [resolved] Notation Consistency and Component Discipline: All em-dash-style characters are gone (0 remaining). The prose "large binary files -- model checkpoints" is now a colon (line 91); "# dvc.yaml -- define..." is now "# dvc.yaml: define..." (line 166); "# Use normally -- LFS handles the rest" is now "(LFS handles the rest)" (line 108). Every surviving "--" is load-bearing and was correctly preserved: frontmatter delimiters (lines 1, 3), Markdown table rules (66, 124, 321), git CLI flags (--oneline, --grep, --all, --list, --merged, --input, --config, --model, --data), and git pathspec separators ("-- config.yaml" line 56, "-- train.py" line 309).
- [minor, open] Correctness and Grounding: "TensorBoard: Lightweight, built into PyTorch." (line 336) is still slightly imprecise. PyTorch ships the integration layer torch.utils.tensorboard (SummaryWriter), but TensorBoard itself is a separate package that must be installed (pip install tensorboard). Reword to "TensorBoard: lightweight; PyTorch ships built-in integration via torch.utils.tensorboard." Non-blocking.
- [minor, open] Completeness and Self-Containment: "removing a 10 GB model checkpoint from Git history requires `git filter-branch` or BFG Repo-Cleaner" (line 281) is correct but stale. git filter-branch is deprecated; the Git project recommends git filter-repo. Add git filter-repo as the modern preferred option. Non-blocking.
- [minor, open] Notation Consistency and Component Discipline: The Code id sequence is still non-contiguous: code-git-for-ml-1, -2, -3, then code-dvc-pipeline, then code-git-for-ml-5, code-git-for-ml-6 (skips 4 and mixes a non-numeric id into the series). Renumber to a consistent scheme so there is no implied missing component-4. Cosmetic, non-blocking.

## Decision rationale
The gate dimension (Correctness and Grounding) passes: no fabricated math, numbers, or citations, and the illustrative figures are internally consistent. The single major finding from the original review (missing narrated worked example) is fully resolved, and the house-style em-dash violations are eliminated without breaking any working code or document structure. The three open items are minor and cosmetic, so the page is publishable as is.

## Remaining issues after repair
- TensorBoard "built into PyTorch" wording could be tightened to reference torch.utils.tensorboard (minor, line 336).
- git filter-branch reference is stale; add git filter-repo as the preferred modern option (minor, line 281).
- Code id numbering is non-contiguous (skips 4, mixes code-dvc-pipeline into a numeric series); renumber for component discipline (cosmetic).
