# Review: books/programming/2-torch/3-nn-module.md

- Content type: textbook
- Original verdict: REJECT
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness and Grounding: 3, Motivation and Conceptual Framing: 3, Worked Examples and Illustration: 2, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 2, Completeness and Self-Containment: 4

## Re-review scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 4, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 4, Completeness and Self-Containment: 4

## Verification of prior repairs
- Notation: All prose and code-comment "--" instances are gone. The only remaining "--" grep hits are frontmatter fences (lines 1, 3) and Markdown table column separators (lines 123, 135), which are required syntax. No em-dash characters present. Line 7 now reads as a parenthetical. Confirmed fixed.
- Correctness (blocker): `from collections import OrderedDict` is now present at the top of the nn.Sequential code block (line 203), so the named-Sequential example no longer NameErrors. Confirmed fixed.
- Correctness (major): The full-checkpoint load now uses `weights_only=False` (line 317) with an inline note (lines 311-316) explaining the PyTorch 2.6+ default flip and the add_safe_globals / safe_globals allowlisting alternative. The example no longer silently misleads. Confirmed fixed.
- Worked Examples (major): A worked `<Example id="ex-mlp-shapes-and-params">` (lines 50-76) traces tensor shapes through MLP(784, 256, 10) and walks the parameter count. Arithmetic verified independently: fc1 = 256*784 + 256 = 200960, fc2 = 10*256 + 10 = 2570, total = 203530, and it cross-links to the parameter-counting idiom. Confirmed fixed and correct.
- Motivation (major): The four cold-opening subsections (Parameter Registration line 80, ModuleList/ModuleDict line 147, nn.Sequential line 196, Saving and Loading line 285) now each open with a why-before-how paragraph stating the problem the feature solves. Confirmed fixed.

## Remaining issues after repair
- [minor] Correctness and Grounding: lines 376-377 still register `register_full_backward_hook` on every module returned by `named_modules()`, including the top-level module (name='') and parameterless containers. This can produce noisy or empty grad_output tuples. Not gating; a one-line caveat or a leaf-module filter would polish it.
- [minor] Correctness and Grounding: line 102 comment `# This will cause bugs!` remains slightly overstated relative to the table directly below it, which correctly states a plain tensor is merely not tracked/saved/moved. The harm is conditional (only on `.to()` / save / load). Not gating.
- [minor] Motivation: the "Building Blocks: Residual Connections" section (lines 230-232) still opens cold with a one-line lead. It was not flagged originally and is not gating, but it is now the only major code section without a why-before-how lead-in.

## Decision rationale
Both blockers and both majors from the original review are resolved and independently verified, including the parameter-count arithmetic in the new worked Example. Notation discipline is clean. Only three minor, non-gating items remain, all suitable for optional polish rather than another revision cycle. Verdict: ACCEPT.
