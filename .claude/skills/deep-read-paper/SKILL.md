---
name: deep-read-paper
description: 'Close-read a single paper end to end (every section, every formula) and produce a comprehension-first reading note as a blog post, closing with a critical analysis section. Use when the user wants to deeply understand one paper, not skim or survey many. Trigger on: "精读", "close read this paper", "read this paper carefully word by word", "understand every formula", "deep read", "逐字逐公式".'
---

# Deep Read Paper

Close-read **one** paper from the first word to the last, from the first formula to the last, until every claim and every equation is understood. The output is a reading note published as a blog post: a comprehension-first walkthrough of the paper, followed by a critical analysis section at the end.

This skill is for **depth on a single paper**. For breadth across many papers, use [[write-literature-review]] or [[deep-research]]. For turning an understood paper into an opinion post, use [[write-blog]].

## What "deep read" means here

Two distinct phases, in order:

1. **Comprehension** (the bulk of the note): faithfully reconstruct what the paper says and why each step follows. Read the actual source, not the abstract or memory. Every section gets covered. Every formula gets explained: what each symbol is, how the equation follows from the previous step, and what it means intuitively.
2. **Critical analysis** (the closing section): only after full comprehension, step back and challenge the paper. Assumptions, experimental gaps, claims that outrun the evidence, what is missing.

Never blend the two. The reader should be able to trust the comprehension section as a neutral reconstruction, then see the critique clearly separated at the end.

## Input

The user provides one of:
- An **arxiv ID / URL** → acquire the source first (see step 1).
- A **PDF or local file** already on disk.
- A **paper already downloaded** under `raw/arxiv/` from a prior session.

## Workflow

### 1. Acquire the source

If the paper is on arxiv and not already local, hand off to [[read-arxiv-paper]] to download the LaTeX source, any GitHub code, and the compiled PDF into `raw/arxiv/<folder>/` and `raw/github/<folder>/`.

Always read the **LaTeX source**, not a remembered summary. The source has the exact equations, the full notation, the appendices, and the footnotes. If only a PDF exists, read the PDF in full.

Confirm with the user: title, authors, year, and the folder you will read from.

### 2. First pass: build the map

Read the whole paper once for structure before close-reading. Produce a short internal map (do not publish this yet):

- **The one-sentence claim.** What does the paper assert that was not known or possible before?
- **The spine.** List the sections in order and what each one does (problem, method, theory, experiments, ablations).
- **The notation table.** Collect every symbol the paper introduces with its meaning. You will need this to explain formulas later. Flag any symbol that is reused with two meanings.
- **The contributions** as the authors state them, and which section backs each one.

If anything in the map is unclear, that is expected. Note it; the close read resolves it.

### 3. Close read, section by section (comprehension)

Walk the paper in order. For each section:

- State the section's **point** in one line (its conclusion, not its label).
- Reconstruct the argument in your own words, faithfully. Quote the paper only for exact definitions, precise numbers, and load-bearing claims, with an inline link to the source.
- Do not skip the parts that are hard. The hard parts are the reason to deep-read.

**Every formula gets the full treatment.** For each equation that carries meaning (skip pure notation restatements), explain:

- **Symbols**: what each term is, with units or shape where relevant (scalar, vector in $\mathbb{R}^d$, matrix, distribution).
- **Derivation**: how this equation follows from the previous step or from a stated assumption. If the paper skips an algebra step, fill it in. If it cites an external result, name it.
- **Intuition**: what the equation is doing in plain language, and why this form and not another.
- **Honesty flag**: if you cannot fully derive or justify a step, say so explicitly with a `> ⚠️ Unresolved:` callout rather than papering over it. A flagged gap is more useful than a confident hand-wave.

Render math in the site's syntax: inline `$...$` and display `$$...$$` (KaTeX is enabled site-wide). Keep symbols identical to the paper's so the reader can cross-check against the PDF.

If the paper has code under `raw/github/<folder>/`, read it to resolve ambiguities in the method. The implementation often disambiguates what the prose leaves vague; note where code and paper disagree.

### 4. Critical analysis (the closing section)

Only now, after full comprehension, turn adversarial. This is the required critical-depth section at the end. Probe, with specifics tied to sections and equations:

- **Assumptions**: which assumptions are load-bearing, and what breaks if each fails? Are any unstated?
- **Evidence vs claims**: does every headline claim have an experiment that actually isolates it? Where does a conclusion outrun its evidence?
- **Experimental design**: baselines fair? ablations complete? metrics measure what the claim needs? confounds controlled? seeds / variance reported?
- **Generality**: where would this method stop working? what regime, scale, or data distribution is silently assumed?
- **Reproducibility**: is there enough to reproduce it? what is missing (hyperparameters, data, compute)?
- **What is missing**: the experiment the authors did not run that would have been most informative.

Be fair, not contrarian. Give credit for what genuinely holds up. End with a calibrated verdict: what to believe, what to doubt, and what to watch for next.

### 5. Assemble the blog post

Write the note into the blog collection. Use a **directory-based post** so paper figures can be included:

```
mochi-lab/content/posts/blog/<slug>/index.mdx
```

Put any figures copied from `raw/arxiv/<folder>/` alongside `index.mdx`. If the note has no figures, a flat `mochi-lab/content/posts/blog/<slug>.md` is fine.

Frontmatter (match the house style from [[write-blog]] exactly):

```yaml
---
slug: <short-kebab-case-slug>
title: "Close Read: <Paper's Short Name>"
authors: [zeyu]
tags: [paper-reading, <topic-tags>]
---
```

Post structure:

```
---frontmatter---

<lead: the paper's one-sentence claim in bold, plus your one-line verdict on whether it holds. State the single most useful takeaway. No throat-clearing.>

<!-- truncate -->

## TL;DR

<the claim, the method in two sentences, the result, and the verdict, as a tight bullet list>

## Notation

<the symbol table from step 2, as a markdown table — the reader's reference for the rest>

## <Section-by-section close read>

<one `##` per major part of the paper, in the paper's order; formulas explained inline per step 3>

## Critical Analysis

<the step-4 critique; this is the closing critical-depth section>

## Verdict

<calibrated close: what to believe, what to doubt, what to watch next>
```

### 6. Polish and verify

- Hand off to [[polish-prose]] for the line-editing pass.
- **Hard rule for this repo**: never use `--` or em-dashes. Restructure, or use a colon, comma, or parentheses. Search the final draft for `--` and any em-dash and remove every one.
- Verify every math block renders: balanced `$`/`$$`, no stray backslashes that KaTeX rejects (`strict: false` is set, but check display equations).
- Attribute every external number and claim with an inline link to the paper or to the cited work.
- Confirm the `<!-- truncate -->` marker is present right after the lead.

## House style (inherited from [[write-blog]])

- **Thesis first.** Open with the paper's claim and your verdict, in bold. No "In this post".
- **Earned confidence.** Make direct claims where the paper's evidence supports them; flag genuine uncertainty plainly.
- **Concrete over abstract.** Lead with the specific number, equation, or result.
- **Short paragraphs**, one idea each. No filler.
- **Faithful in comprehension, sharp in critique** — and never mix the two.

## Gotchas

- **Do not work from the abstract or memory.** Read the source. A deep read that paraphrases the abstract is the failure mode this skill exists to prevent.
- **Do not skip formulas because they are hard.** A flagged `⚠️ Unresolved` is acceptable; a silent skip is not.
- **Keep notation identical to the paper.** Renaming symbols breaks the reader's ability to cross-check against the PDF.
- **Critique only after comprehension.** A critical analysis written before understanding the method is noise.
- **Set the slug deliberately and keep it fixed.** It is the permanent URL; do not regenerate it from the title at publish time.
- **Length is never the goal.** Cover everything, but cut every sentence that survives deletion without loss.
