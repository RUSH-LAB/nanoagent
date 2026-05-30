---
name: polish-prose
description: 'Line-edit a finished draft (blog post, documentation, paper, README) for clarity and concision using a five-pass audit based on Kristin Sainani''s "Writing in the Sciences". Improves delivery, never the underlying content or claims. Use when the user wants to polish, tighten, proofread, or improve the writing of an existing draft. Trigger on: "polish this", "tighten this up", "edit this", "make this clearer", "proofread".'
---

# Polish Prose

Edit a draft for clarity, concision, and flow. This skill improves how the writing reads. It never changes the substance, the claims, or the technical content. The method is adapted from Kristin Sainani's "Writing in the Sciences" and applies equally to blog posts, documentation, and papers.

## Modes

- **full-review** (default): run all five passes over the whole document, then produce a prioritized report.
- **section-review**: same passes, scoped to a section the user names.
- **targeted**: run only the passes the user asks for (for example "just cut the clutter").
- **interactive**: go paragraph by paragraph, proposing edits and waiting for the user before moving on.

When the mode is ambiguous, default to full-review.

## The five passes

Run them in order. Each pass has a single focus, so do not mix them.

### Pass 1: Cut the clutter

Remove dead weight. Every word should earn its place.

- Replace bloated phrases with one word: "due to the fact that" becomes "because", "in order to" becomes "to", "a majority of" becomes "most", "at this point in time" becomes "now".
- Delete redundant modifiers: "absolutely essential", "completely eliminate", "end result", "past history", "future plans".
- Cut hedges that add nothing: "it is important to note that", "it should be mentioned", "basically", "actually", "really".
- Remove meta-commentary: "in this section we will discuss" then just discuss it.

### Pass 2: Active voice and live verbs

- Convert obscuring passive voice to active. "The data were analyzed by the team" becomes "the team analyzed the data". Keep passive only when the actor is unknown or irrelevant.
- Revive smothered verbs (nominalizations). "We performed an analysis of" becomes "we analyzed". "Make a decision" becomes "decide". "Provide an explanation" becomes "explain".
- Prefer strong verbs over verb-plus-adverb. "Increased sharply" can become "spiked"; "said quietly" can become "murmured" where tone allows.

### Pass 3: Sentence architecture

- Flag buried predicates: when more than roughly twelve words sit between the subject and its verb, restructure so the reader reaches the verb sooner.
- Break run-on sentences carrying two or more ideas. Use a colon to introduce a payoff, a semicolon to join twinned clauses, parentheses for a genuine aside.
- Vary sentence length deliberately. A short sentence after two long ones lands. A wall of uniform-length sentences reads flat.
- Never use `--` or em-dashes. Restructure, or use a colon, comma, or parentheses. This is a hard rule for this repo.

### Pass 4: Keyword consistency

- The Banana Rule: name one concept one way throughout. Do not call it a "function" here and a "method" there if it is the same thing. Elegant variation confuses technical readers.
- Acronym discipline: define each acronym once at first use, then use it consistently. Do not define acronyms you use only once; spell them out instead.
- Keep terminology aligned with the rest of the codebase or post series.

### Pass 5: Numerical and citation integrity

- Check that numbers agree across the document: the figure in the abstract or lead matches the figure in the body, the table, and the conclusion.
- Flag secondary citations (the "telephone game"): a claim attributed to source B that actually traces to source A. Recommend citing the original.
- Verify every external claim and statistic carries a link or reference. Flag any that do not.

## Output

For full-review and section-review, produce a structured report:

1. **Top 5 priority revisions** first: the highest-impact fixes, each with the specific before and after text.
2. **Findings by severity**, each tagged:
   - `CRITICAL`: changes meaning, breaks a claim, or a factual or numerical inconsistency.
   - `MAJOR`: significantly hurts clarity (buried predicate, heavy passive, dense clutter).
   - `MINOR`: small polish (a tighter word, a smoother transition).
3. Every finding shows the **exact before and the exact after**. Never give vague advice like "tighten this paragraph"; show the rewrite.

In interactive mode, propose the edits inline per paragraph and apply them on approval.

## Constraints

- **Never change the substance.** Do not alter claims, data, conclusions, or technical meaning. If a fix would touch meaning, flag it as a question instead of editing.
- **Preserve the author's voice.** Polish toward the existing style (see [[write-blog]] for the house voice), do not flatten it into generic prose.
- **Respect domain conventions.** Some passive voice and field-specific terms are correct in technical writing. Do not "fix" them.
- **Show, do not lecture.** The value is in concrete before and after pairs, not general writing advice.

## Gotchas

- **Do not run all five concerns at once.** Mixing passes causes missed issues. One lens per pass.
- **Over-editing kills voice.** If a sentence is clear and the author's, leave it. Not every sentence needs a change.
- **Watch for meaning drift in Pass 2.** Converting passive to active can subtly change who did what. Verify the actor is correct.
- **The em-dash check is mechanical and easy to skip.** Before finishing, search the text for `--` and em-dash characters and remove every one.
