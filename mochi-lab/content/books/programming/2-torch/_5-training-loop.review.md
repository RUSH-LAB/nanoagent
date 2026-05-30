# Review: books/programming/2-torch/5-training-loop.md

- Content type: textbook
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 4
- Broken citekeys: []

## Original scores
Correctness and Grounding: 4, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 3, Completeness and Self-Containment: 4

## Findings
- [major] Correctness and Grounding: "# Learning rate schedule: warmup + cosine decay
    total_steps = len(train_loader) * epochs
    warmup_steps = int(0.1 * total_steps)    # 10% warmup
    scheduler = torch.optim.lr_scheduler.OneCycleLR(" -> OneCycleLR does not produce the linear-warmup-from-near-zero shape this section otherwise teaches (option 3 in code-lr-schedules). OneCycleLR ignores the optimizer's lr, starts at max_lr/div_factor (default max_lr/25), warms UP with a cosine (not linear) ramp, and anneals down to max_lr/(div_factor*final_div_factor). Either relabel the comment to 'OneCycle (cosine warmup + cosine decay)' and note the start/end LRs are set by div_factor/final_div_factor, or switch the main loop to the LambdaLR linear-warmup+cosine schedule (option 3) to match the LLM-standard schedule the section calls standard.
- [major] Correctness and Grounding: "| Adafactor | Row + column factors (no full 2nd moment) | ~$4\sqrt{P}$ bytes |" -> Adafactor's factored second moment is O(n+m) per weight matrix, not ~4√P for the whole model. For a single n×m matrix it is roughly 4(n+m) bytes (≈8√P only when n≈m≈√P), summed over all matrices in the model. State it as 'O(n+m) per matrix (sublinear)' rather than a single ~4√P figure; the current expression understates real usage for a multi-layer model and uses an incorrect constant.
- [minor] Notation Consistency and Component Discipline: "checkpointing -- and explains *why* each component is there." -> Replace the prose double-hyphen with a comma, colon, or parenthetical per repo house style (no `--`). Same violation occurs at three other prose/comment locations: '# No GradScaler needed -- BF16 has same exponent range as FP32', 'Autocast handles this automatically -- you do not need to manually cast tensors.', and '# Returns the total norm BEFORE clipping -- log this!'.
- [minor] Worked Examples and Illustration: "This chapter presents a production-quality training loop with mixed precision, gradient clipping, learning rate scheduling, and checkpointing" -> The section is almost entirely reference code blocks and tables; it lacks any worked <Example> that walks a concrete numeric computation (e.g., compute optimizer-state memory for a stated P, or trace the LR value at a specific step of the warmup+cosine schedule). Add at least one step-by-step <Example> with faded guidance to teach by computation rather than only by code listing.
- [minor] Correctness and Grounding: "For a 7B parameter model in FP32: Adam requires 7B * 8 = 56 GB just for optimizer states." -> The arithmetic (7e9 * 8 bytes = 56 GB) is correct for the m+v state in FP32. Optionally clarify this counts only the two moment buffers (8 bytes/param) and excludes the FP32 master weights, which the row above lists separately as 12P; as written it is consistent with the table, so this is a clarity note only.

## Changes made
Removed all 4 prose "--" occurrences (lines 7, 183, 222, 380) by substituting a comma, parentheses, "so", and parentheses respectively; the remaining "--" instances are frontmatter delimiters and markdown table separator rows, which are required syntax and were left intact. Fixed the OneCycleLR correctness issue in the main training loop by relabeling the comment to "OneCycle (cosine warmup + cosine decay)" and documenting that OneCycleLR ignores the optimizer's lr, starts at max_lr/div_factor, ramps up with a cosine (not linear) curve, and anneals to max_lr/(div_factor*final_div_factor). Fixed the Adafactor memory claim in the optimizer-memory table, replacing the incorrect "~4√P bytes" with "O(n+m) per n×m matrix (sublinear), summed over all matrices". No math, numbers, or citations were fabricated; the LambdaLR linear-warmup+cosine option (option 3) was left as-is since the section already correctly labels it the LLM standard, and I chose the safer relabel-the-comment fix the finding explicitly offered.

## Left for human
- Optional alternative for the OneCycleLR finding: instead of relabeling the comment, the author could switch the main training loop to the LambdaLR linear-warmup+cosine schedule (option 3 in code-lr-schedules) so the loop matches the LLM-standard schedule the section calls standard. I applied the conservative relabel instead; the author may prefer the swap for pedagogical consistency.

## Re-review scores (after revision)
Correctness and Grounding: 5, Motivation and Conceptual Framing: 4, Worked Examples and Illustration: 3, Cognitive Load and Scaffolding: 4, Notation Consistency and Component Discipline: 5, Completeness and Self-Containment: 4

## Verification of applied fixes
- OneCycleLR comment (lines 31-35): now correctly states the scheduler ignores the optimizer's lr, starts at max_lr/div_factor (default max_lr/25), ramps up with a cosine curve, and anneals to max_lr/(div_factor*final_div_factor). Accurate against PyTorch behavior. Resolved.
- Adafactor row (line 267): now reads "O(n+m) per n×m matrix (sublinear), summed over all matrices". The incorrect ~4√P constant is gone. Resolved.
- Prose double-hyphens: grep confirms zero remaining prose "--"; only frontmatter delimiters (lines 1, 3) and table separator rows remain, both required syntax. Resolved.
- Spot-checked remaining numerics: 7e9 * 8 bytes = 56 GB (correct for m+v); mixed-precision memory table 4P master + 2P working = 6P and 4P->2P gradient halving (correct). Correctness gate passes.

## Remaining issues after repair
- [minor, non-blocking] No worked numeric <Example> with faded guidance (e.g., trace LR at a given warmup step, or compute optimizer-state memory for a stated P). This is a pedagogical enhancement, not a correctness defect, and was deferred to the author. It does not block acceptance.
