---
name: review-draft
description: 'Review a finished draft for SUBSTANCE (correct, grounded, novel, complete) using a content-specific rubric, then score each dimension and return an explicit ACCEPT / REVISE / REJECT verdict. Modeled on the automated reviewer in end-to-end research frameworks. Use before publishing a research post, textbook section, or survey chapter. Trigger on: "review this", "is this ready to publish", "rubric review", "score this draft", "peer review this".'
---

# Review Draft

Act as a rigorous peer reviewer for a finished draft. This skill judges whether the content is correct, grounded, novel, and complete. It does not edit wording: the sibling skill [[polish-prose]] owns prose, rhythm, and grammar. Run `review-draft` first to decide if the substance holds, then hand surviving prose issues to [[polish-prose]].

The method mirrors the automated reviewer used in auto-research frameworks (Sakana's The AI Scientist): score every dimension, tag each finding by severity, quote the offending line, and close with one explicit verdict.

## How to use

1. **Pick the rubric** by content type:
   - Research blog or research post (`content/posts/`) → **Rubric A**.
   - Textbook section (`content/books/math`, `programming`) → **Rubric B**.
   - Survey / literature-review chapter (`content/books/survey`) → **Rubric C**.
2. **Read the draft and its sources.** Do not review from the summary alone. Open the cited papers for any load-bearing claim, recompute numbers, and confirm components and citekeys resolve. If you cannot verify a source, lower your confidence and say so.
3. **Score each dimension, tag every finding, then issue the verdict.**

## Output format (all rubrics)

```
VERDICT: ACCEPT | REVISE | REJECT
<one sentence naming the deciding finding>

Scores:
  <dimension>: <n>/<max>  (one-line reason)
  ...
Reviewer confidence: <1-5>  (lower it when sources were not checked)

Findings (ordered Critical/Blocker, then Major, then Minor):
  [SEVERITY] <dimension> — "<quoted line or id>" — <what is wrong and the fix>
  ...
```

Every finding must quote the exact offending sentence, number, or component `id`. Vague findings ("tighten this") belong to [[polish-prose]], not here.

---

## Rubric A: Research post

Scale **1-4** per dimension (mirrors the NeurIPS / ICLR soundness scale). 4 excellent, 3 good (minor gaps), 2 fair (a Major finding here), 1 poor (a Critical finding here). Severity tags: **Critical** (wrong, fabricated, or unsupported core claim; misleads as written), **Major** (a gap that changes the takeaway), **Minor** (improves rigor, does not change the conclusion).

- **Novelty of Insight** — does it say something a reader could not get from the source abstract? Check the thesis is a real claim, not a topic; check it adds connective tissue (comparison, taxonomy, contrarian read) over paraphrase; check related work is acknowledged so "new" is legible. Red flags: the post equals the paper's abstract; thesis is a question never answered; reads as paper PR with no independent judgment.
- **Correctness and Soundness** (gate) — is every load-bearing claim true and adequately supported? Verify method descriptions against the source; check each logical step for hidden assumptions or correlation-as-causation; recompute numbers; confirm comparisons are apples-to-apples. Red flags: misdescribed method; a number that cannot be reconciled; "A beats B" across mismatched benchmarks; causal language on correlational evidence; confident tone where the source hedges.
- **Evidence and Grounding** — is every non-obvious claim traceable to a source that actually says it? Every stat, benchmark, and "recent work shows" links a primary source; spot-check that load-bearing citations support their sentence; check links resolve to the primary paper, not a secondary blog; check "SOTA"/"latest" is still true as of the post date. Red flags: "studies show" with no cite; citation drift; stale SOTA contradicted by the post's own date.
- **Clarity and Structure** — can a knowledgeable reader follow it in one read? Thesis-first; each section advances the argument; terms defined before use; no missing reasoning step; tables and figures labeled and referenced. Red flags: the point arrives only in the last paragraph; ordering forces re-reading; a figure dropped in with no explanation; a logical gap the reader must bridge.
- **Significance (So-What)** — does it matter, and is it clear to whom? Check the post answers "so what"; audience is identifiable and the framing meets them; scope of the claim is proportional (no scope inflation); connects to a larger thread. Red flags: reader finishes and asks "and?"; importance asserted but not argued; one benchmark gain framed as redefining the field.
- **Honesty and Limitations** — does it deal fairly with what it does not know and with counter-evidence? Limitations of cited work surfaced; established fact vs hypothesis vs open question kept distinct; obvious counter-arguments acknowledged; no cherry-picking; author's own stake disclosed. Red flags: zero caveats on strong empirical claims; cherry-picked best-case numbers; opinion and fact blurred; known counter-evidence unmentioned.

**Verdict.** REJECT if any Critical finding, or any dimension scored 1, or Correctness below 3. REVISE if no Critical but a Major remains, or any dimension at 2, or two or more dimensions below 3. ACCEPT if no Critical or Major, every dimension at least 3, and Correctness at least 3. Tie-break: a correct post that is weak on Significance is a REVISE (sharpen the so-what), not an ACCEPT. If confidence is 2 or below on any load-bearing dimension, recommend a domain-expert pass.

---

## Rubric B: Textbook section

Scale **1-5** per dimension (5 exemplary, 4 solid, 3 adequate with one Major issue, 2 weak, 1 failing). Severity tags: **Blocker** (wrong math or code, broken KaTeX, duplicate or missing `id`, missing caption, citekey absent from `references.yaml`: makes the page wrong or unrenderable), **Major** (a real reader misunderstands or gets stuck), **Minor**.

- **Correctness and Grounding** (gate) — is every definition, derivation, and code block true and cited? Each Definition/Theorem stated with all hypotheses; every derivation step follows, with consistent shapes and units (matrix-calculus layout matches every gradient shown); code and pseudocode compute what the prose says; worked-example arithmetic recomputed; every external claim has a `[@key]` that resolves in `references.yaml` and actually supports the claim. Red flags: a theorem missing a hypothesis; a Jacobian shape contradicting the section's own layout Remark; a worked example whose final number does not match its steps; "it can be shown that" hiding a false step.
- **Motivation and Conceptual Framing** — does the reader learn why before the formalism? Opens with 1-2 paragraphs of motivation, not a cold Definition; each formal statement is followed by one plain sentence of meaning; ends on a consequence, not a restatement. Red flags: section begins with `<Definition>` as the first block; formalism with no plain-language gloss; reference dump with no narrative of purpose.
- **Worked Examples and Illustration** — does it teach by fully worked example with faded guidance? At least one `<Example>` walks a computation step by step; a second harder example for transferable ideas; detail fades as the section advances (expertise reversal); parallel cases enumerated in a `<Table>`. Red flags: a symbol-heavy section with no `<Example>`; every step over-explained even in late examples; an example that jumps setup to answer.
- **Cognitive Load and Scaffolding** — is intrinsic load managed and extraneous load kept out? Subsections form a simplest-first progression; prerequisites linked with `[](#id)` or `<Ref>`, not silently assumed; no unsignposted difficulty cliff; tight paragraphs; reusable sub-results pulled into a `<Lemma>`. Red flags: routine setup then a dense result with no bridge; an eight-paragraph proof that should be a Lemma; a dangling "recall that" never established.
- **Notation Consistency and Component Discipline** — one symbol per concept, and correct components with valid unique ids? Conventions match sibling sections; a notation-summary `<Table>` closes symbol-heavy sections; KaTeX renders with the mandatory blank lines inside wrapper components; every numbered component has a unique `id`, and `<Figure>/<Table>/<Code>/<Algorithm>` have captions; cross-refs resolve; `sidebar_position` unique and matching the filename prefix; no `--` or em-dash. Red flags: one letter reused for two quantities; a duplicate `id`; a `$$` block jammed against a wrapper tag; `sidebar_position` duplicated.
- **Completeness and Self-Containment** — does it deliver on its title and link into the chapter? Everything the title promises is covered; important cases and failure modes addressed; the reader finishes able to apply the idea; the chapter `index.md` lists the section with a working link; no orphaned figure or defined-but-unused symbol. Red flags: title promises more than the body delivers; a forward reference with no target; section missing from `index.md`.

**Verdict.** ACCEPT: no Blockers, no Major findings, every dimension 4 or 5. REVISE: no Blockers, but a Major finding or any dimension at 3. REJECT: any Blocker, any dimension at 1-2, or Correctness below 3. Correctness is a gate that cannot be averaged away: one uncorrected Blocker forces REJECT.

---

## Rubric C: Survey / literature-review chapter

Scale **1-5** per dimension. Severity tags: **blocker** (factually wrong, fabricated, or breaks the build / a load-bearing claim; caps the dimension at 2 regardless of other strengths), **major** (a real, fixable gap), **minor**.

- **Scope and Coverage Completeness** — is the boundary stated and actually covered? Scope and out-of-scope drawn (PRISMA-style); the 8-12 must-cite works for the topic are present and named; coverage even across families; sources primary, not blog posts where a paper exists. Red flags: no stated scope; a recognized sub-area missing unacknowledged; lopsided coverage; many claims sourced to one secondary survey (coverage laundering).
- **Taxonomy Quality (the spine)** (gate) — do the axes carve the field along one consistent principle, MECE as far as the field allows? One organizing principle at the top level; axes distinguishable, with genuine overlaps stated as hybrids rather than forced apart; every in-scope method has a home; each family has a principle, flagship methods, and its tradeoff; the taxonomy ends with comparative analysis, not just a list; deep-dive files match the axes named. Red flags: two indistinguishable families; mixed organizing principles at one level; a method that fits no bucket; a flat paper list relabeled as categories.
- **Synthesis over Summary** — does it compare and explain tradeoffs? Organized theme-by-theme, not one paragraph per paper; concrete comparative claims with numbers ("RETRO at 7B matches a 175B model without retrieval"); each subsection ends with a comparative takeaway; the tension each line navigates is named; claims qualified by regime. Red flags: annotated-bibliography pattern; a subsection with no takeaway sentence; setting-blind superlatives; tradeoffs asserted but never grounded.
- **Citation Integrity (anti-telephone-game)** — does every citation resolve and trace to a source that makes the claim? Every `[@citekey]` resolves; load-bearing numbers trace to the originating paper, not a later survey; spot-check the highest-stakes numbers against the primary source; no fabricated citations; priority attribution correct. Red flags (blocker): a number the cited source does not contain; a nonexistent citekey; a flagship result credited to a survey not its origin.
- **Balance and Currency** — even-handed and up to date? Each family gets both advantages and limitations; genuine disagreements flagged; no promotional tone toward one lab; recent and foundational work both present (check newest citation years against the chapter date); terminology variants reconciled, not double-counted. Red flags: one-sided cheerleading; stale newest work in an active area; suppressed controversy stated as consensus.
- **Problem Formulation and Evaluation Rigor** — are setting, metrics, and benchmarks defined precisely? `problem-formulation.md` gives the formal framework and names the core tension; metric formulas correct with stated tradeoffs; `benchmarks.md` groups benchmarks by what they test with scale and key numbers; evaluation pitfalls (contamination, leakage, non-comparable protocols) named; plain-text math per house convention. Red flags: metrics named but never defined; a benchmark table with no indication of what each tests; numbers with no source.

**Verdict.** REJECT if any dimension scores 1, any unresolved blocker, or Taxonomy Quality at 2 or below (a broken spine needs a rewrite). REVISE if any dimension at 2 or below, two or more at 3, or any major finding open. ACCEPT only if every dimension is 4 or 5 with no blocker or major findings (minor polish goes to [[polish-prose]]).

---

## Gotchas

- **Substance only.** Do not rewrite sentences here. Wording, rhythm, and grammar are [[polish-prose]]'s job. If a finding is purely stylistic, drop it or pass it on.
- **Verify, do not assume.** The highest-value findings come from opening the cited source and recomputing the number. A review that never checked a source must say so and lower its confidence.
- **Quote the line.** Every finding names the exact sentence, number, or component `id`. Unquoted findings are not actionable.
- **The gate dimension is not averageable.** Correctness (A and B) and Taxonomy Quality (C) can sink a draft alone; a strong score elsewhere does not rescue them.
- **One explicit verdict.** Always end with ACCEPT, REVISE, or REJECT and the single deciding finding. "Looks good overall" is not a verdict.
- **Never use `--` or em-dashes** in the review you write, per repo house style.
