# Review: posts/blog/how-to-research.md

- Content type: research-post
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Novelty of Insight: 2, Correctness and Soundness: 3, Evidence and Grounding: 2, Clarity and Structure: 3, Significance (So-What): 3, Honesty and Limitations: 2

## Re-review scores
Novelty of Insight: 3, Correctness and Soundness: 3, Evidence and Grounding: 3, Clarity and Structure: 3, Significance (So-What): 3, Honesty and Limitations: 3

## Findings
- [resolved] Clarity and Structure: All 9 em-dashes are gone. A fresh scan finds zero em-dashes in the file. The only remaining dash-like tokens are the two YAML frontmatter delimiters (lines 1, 6) and the MDX comment on line 10, all of which are required syntax. Month ranges now read "Month 1 to 2" and "Month 3 to 5", avoiding even en-dashes. House style satisfied.
- [resolved] Honesty and Limitations: The "keep it simple" claim (line 19) now carries explicit caveats naming the regimes where it fails (large-scale infrastructure, distributed training, hardware-aware kernels, theory-heavy work where the system is the contribution). Opinion and fact are no longer blurred.
- [resolved] Evidence and Grounding: The previously universal claims are now marked as the author's view. "Nobody remembers average work" is prefaced with "In my experience" (line 21); the baseline point is framed as "My rule of thumb" and explains its mechanism, that a large margin over a weak baseline may reflect the baseline's flaws rather than the method (line 53). A concrete behavioral consequence (spending disproportionate time strengthening the baseline) was added. This satisfies the rubric's "mark non-obvious claims as the author's view" path.
- [partial] Novelty of Insight: The intro now explicitly frames the content as personal heuristics rather than universal laws, names the obvious precedent (Hamming's "You and Your Research"), and states the goal of showing how these changed real decisions. The baseline section adds one concrete behavioral consequence. However, the specific first-person episode the original review asked for (a named project, dataset, or outcome where taste changed a decision) is still absent. This was correctly left for the human author rather than fabricated. Novelty rises from 2 to 3 but is capped there until a real anecdote lands.
- [minor, open] Honesty and Limitations: The six-month cycle is still implicitly tuned to deadline-driven empirical ML ("Finish your paper a month before the deadline", line 45) without naming that assumed context. This is a low-severity framing gap and does not block acceptance.

## Disposition
The Correctness gate passes. All three major findings from the original review are resolved through conservative reframing, with no fabricated numbers, citations, or anecdotes. The only named source (Hamming's essay) is a real, well-known work referenced generically. The two remaining items are author-dependent (a real first-person episode) or low-severity framing (naming the ML-deadline context), neither of which warrants another revision round. Verdict: ACCEPT.

## Remaining issues after repair
- [author] Add at least one concrete first-person episode (named project, dataset, or outcome) where research taste changed a real decision, to fully realize the novelty the intro now promises. Correctly not auto-generated, as inventing it would breach honesty.
- [minor] Optionally state the assumed context for the six-month cycle (deadline-driven empirical ML) so readers in other fields are not misled that the timeline is universal.
