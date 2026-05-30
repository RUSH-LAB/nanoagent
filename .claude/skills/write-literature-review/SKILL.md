---
name: write-literature-review
description: 'Write or extend a survey/literature-review chapter in the Docusaurus book format used by this site (content/books/survey, e.g. ch1-continual-learning, ch4-agentic-search). Use when the user wants to start a new survey chapter, add a section to an existing one, or restructure a chapter around a taxonomy. Trigger on: "write a survey chapter", "add a literature review section", "survey the work on X", "write the taxonomy/problem formulation/benchmarks section".'
---

# Write Literature Review

Write survey chapters that synthesize a research area, not annotated bibliographies that list papers one by one. Chapters live in `mochi-lab/content/books/survey/chN-<slug>/`. Each is a Docusaurus directory: one file per section, ordered by frontmatter.

This skill shapes the chapter's scope, taxonomy, and synthesis. Hand the final line-editing pass to [[polish-prose]].

## Read the neighbors first

Before writing, read two or three existing chapters to match the format exactly (`ch1-continual-learning` and `ch4-agentic-search` are the canonical examples). Reuse their section archetypes, citation style, and tone. Match reality, not this document's summary of it.

## Directory and file layout

A chapter is a folder with one markdown file per section:

```
chN-<slug>/
  index.md              # the chapter landing page and dense abstract
  introduction.md       # sidebar_position: 1, motivation
  problem-formulation.md
  taxonomy.md
  <method-family-1>.md  # one file per taxonomy axis
  <method-family-2>.md
  ...
  benchmarks.md
  open-problems.md
  connections.md        # cross-references to other chapters
```

Every file opens with frontmatter (match it exactly):

```yaml
---
sidebar_position: 2
title: "Problem Formulation"
---
```

- `sidebar_position` orders the sidebar. In the existing chapters, `introduction.md` is position 1 and the remaining sections count up from 2. `index.md` carries the chapter title and its position matches the chapter number (ch4's `index.md` is position 4); follow whatever the neighboring chapters do. Leave gaps if you may insert sections later.
- `title` is quoted, in Title Case.
- `index.md` uses an H1 (`#`) matching the chapter title, then a single dense abstract paragraph that names the concrete methods and systems the chapter covers. Section files repeat the title as a heading (existing files use either H1 or H2; pick one and stay consistent within the chapter) then go straight into content.

## Section archetypes

Surveys reuse a stable set of section types. Pick the ones the area needs.

- **index.md (abstract).** One paragraph. State what the chapter reviews, name the taxonomy's families, and list the flagship methods or systems by name. Concrete over abstract.
- **Introduction and motivation.** Why the area matters and the questions the chapter answers.
- **Problem formulation.** Define the problem settings, give a formal framework (objective, constraints), state evaluation metrics with their formulas, and name the core tension the whole field navigates (for example the stability-plasticity spectrum, or quality versus search cost). End with how the metrics trade off against each other.
- **Taxonomy.** The backbone of the chapter. A numbered list of mutually-distinguishable families, each with: a one-line organizing principle, the flagship methods with citations, and the tradeoff that family accepts. Follow with a comparative analysis subsection (how the families compare across settings) rather than stopping at the list.
- **Method-family deep dives.** One file per taxonomy axis. Within each, group methods by mechanism, compare them, and surface what each line of work navigates.
- **Benchmarks and evaluation.** Group benchmarks by what they test. For each, give what it measures, its scale or key numbers, and what it reveals. Close with the evaluation challenges specific to the area.
- **Open problems.** The honest gaps and unresolved tensions.
- **Connections.** Tie the chapter to sibling chapters by name and section (for example "the POMDP framing in Chapter 2", "Section 4.6").

## Citation format

Citations are pandoc-style, resolved at build time against the chapter bibliography:

- Single: `[@kirkpatrick2017overcoming]`
- Multiple: `[@buzzega2020dark, @boschini2022class]` (comma-separated inside one bracket).
- Author-year woven into prose for foundational or framing work: `following the taxonomy of van de Ven and Tolias (2019) [@vandeven2019three]`. Use this when the people or year carry meaning; use the bare bracket otherwise.

Conventions to match:
- **Bold method and system names** on introduction: `**Class-Incremental Learning (Class-IL):**`, `**Regularization-based methods**`.
- Math is written as plain inline text, not rendered LaTeX: `min_theta sum_{t=1}^{T} E[...]`, `O(B * (C_search + K * C_read))`. Greek as words (`theta`, `lambda`, `gamma`).
- Define each acronym once at first use, then reuse it.

## Synthesis over summary (the core rule)

A survey's value is comparison, not coverage. The difference between this skill and a reading list:

- **Compare and contrast, do not enumerate.** "RETRO with 7B parameters matches a 175B model without retrieval" tells the reader what retrieval buys. A paragraph that just describes RETRO does not.
- **Name the tension each line of work navigates.** Every method buys something at a cost. Regularization is memory-free but saturates capacity. Replay dominates but needs stored data. Make that tradeoff explicit.
- **End each subsection with a comparative takeaway**, not a per-paper recap. State which approach wins under which conditions and why.
- **Qualify claims by setting.** A method that "solves" the problem in one regime may fail in another. Say so.

## Workflow

1. **Scope (PRISMA-style).** Before gathering, write down the inclusion and exclusion criteria: which subtopics, which time window, which venues, what counts as in-scope versus a neighboring field. A tight scope beats exhaustive coverage. Confirm the boundary with the user for a new chapter.
2. **Gather sources.** Pull the actual papers; do not work from memory of abstracts. Fetch and read primary sources with [[read-arxiv-paper]] (LaTeX source lands under `raw/arxiv/`). For broad source-gathering across an unfamiliar area, use [[deep-research]] to fan out searches and collect candidates. This stage parallelizes: gathering and clustering sources can be fanned out across agents (see the saved `literature-review` workflow).
3. **Build the taxonomy.** Cluster the gathered work into families along one consistent organizing principle. Aim for axes that are as mutually-exclusive as possible and that together cover the scope. The taxonomy is the chapter's spine; get it right before drafting. Note where families overlap (hybrid methods) instead of forcing a clean partition.
4. **Draft sections by archetype.** Write problem formulation, then taxonomy, then one file per family, then benchmarks, open problems, connections. Open each section with its conclusion and support it. Keep paragraphs short, two to four sentences.
5. **Synthesize the tradeoffs.** Go back through each subsection and add the comparative takeaway if it is missing. This is the step most drafts skip.
6. **Verify citations.** Confirm every `[@citekey]` resolves to a real entry in the chapter bibliography. Confirm each claim traces to a source that actually makes it. Avoid the secondary-citation telephone game: cite the paper that originated a result, not a later survey that repeated it. When a fact is load-bearing, read the primary source to confirm it.
7. **Hand off to [[polish-prose]]** for the line-editing pass.

## House style (hard rules)

- **Never use the double-hyphen or em-dash character.** Restructure, or use a colon, comma, or parentheses. Note that some existing chapter files violate this; do not copy that habit, and do a final search for the double-hyphen before finishing.
- **Thesis first, concrete first.** Lead with the specific number, system, or claim, then generalize.
- **No filler.** Cut "it is important to note", "in recent years". Length is never a goal.
- **Earned confidence.** Make direct claims where the literature supports them. Flag genuine disagreement in the field plainly.

## Gotchas

- **A list of papers is not a survey.** The most common failure is one paragraph per paper with no comparison. If a subsection has no takeaway sentence, it is not done.
- **Taxonomy axes that overlap heavily are a smell.** If two families cannot be told apart, merge them or pick a different organizing principle. State hybrid methods explicitly rather than pretending the partition is clean.
- **Citekeys must exist.** A `[@citekey]` with no bibliography entry breaks the build silently or renders as raw text. Verify against the actual bibliography before finishing.
- **Telephone-game citations.** Attributing a result to a survey that merely cited the original is a real-world failure mode, the same one [[polish-prose]] flags in its Pass 5. Cite the origin.
- **Setting-blind claims.** "Method X is best" without naming the regime is usually wrong. Qualify it.
- **Do not invent numbers or results.** Every quantitative claim needs a real source. If you cannot find one, say the magnitude is unestablished rather than guessing.
- **Match `sidebar_position` to the intended order.** Reusing or skipping a number reorders the sidebar in ways that are easy to miss.
- **Plain-text math, not rendered LaTeX.** Follow the existing chapters' convention so the page renders consistently.
