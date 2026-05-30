---
name: write-blog
description: 'Draft, structure, and refine a blog or research post in the Docusaurus format used by this site (content/posts/blog and content/posts/research). Use when the user wants to write a new post, turn notes or a paper into a post, or restructure an existing draft. Trigger on: "write a blog post", "draft a post", "turn this into a blog", "write up X".'
---

# Write Blog

Draft and structure posts for this site so they match the existing voice, format, and frontmatter. Posts live in `mochi-lab/content/posts/blog/` (opinion and explainer pieces) and `mochi-lab/content/posts/research/` (technical proposals and findings).

This skill shapes structure and prose. To do a final editing pass on a finished draft, hand off to [[polish-prose]].

## Voice (house style)

Study the existing posts before writing. The established voice is:

- **Thesis first.** The opening paragraph states the single most interesting claim, in bold, and says why it matters. No throat-clearing, no "In this post I will".
- **Earned confidence.** Make direct claims. Replace "this might suggest" with the claim itself when the evidence supports it. Flag genuine uncertainty plainly instead of hedging everything.
- **Concrete over abstract.** Lead with the specific number, system, or example, then generalize. "Handles 200 million queries daily" beats "operates at large scale".
- **Short paragraphs.** Two to four sentences. One idea each.
- **No filler.** Cut "it is important to note", "in today's world", "as we all know". If a sentence survives deletion without loss, delete it.
- **Never use `--` or em-dashes.** Restructure the sentence, or use a colon, comma, or parentheses. This is a hard rule for this repo.

## Frontmatter

Every post opens with this block. Match it exactly:

```yaml
---
slug: short-kebab-case-slug
title: "Full Title in Title Case, in Quotes"
authors: [zeyu]
tags: [tag1, tag2, tag3]
---
```

- `slug` becomes the URL. Keep it short and stable. Do not change it after publishing.
- `title` goes in quotes. Make it specific and curiosity-driving, not generic.
- `tags` reuse existing tags where possible (llm, search, agents, infrastructure, synthetic-data, knowledge-graph). Check sibling posts for the active tag vocabulary before inventing new ones.

## Structure

```
---frontmatter---

<lead paragraph: the thesis in bold + why it matters>

<!-- truncate -->

## First section

...
```

- The `<!-- truncate -->` marker is required. Everything above it is the preview shown in post lists. Put the full hook above it, the body below.
- Use `##` for sections and `###` for subsections. Do not skip levels.
- Give sections informative titles that state their point ("Architecture: Five Layers Redesigned"), not labels ("Architecture").

## Drafting workflow

1. **Find the thesis.** Before writing a word, state in one sentence the single claim the post defends. If you cannot, ask the user what the post is really about. Everything else serves this claim.
2. **Outline the spine.** List the sections as a logical argument: claim, evidence, implications. Confirm the outline with the user for anything longer than a short post.
3. **Draft section by section.** Open each section with its conclusion, then support it. End sections with the consequence, not a summary.
4. **Add structure where it earns its place.** Use a table to compare or enumerate parallel items (see the existing posts). Use fenced code or YAML blocks for data structures, schemas, and examples. Use a numbered list only for genuine sequences.
5. **Close with a payoff.** End on the implication, the open question, or the "so what". Never end with "In conclusion".
6. **Hand off to [[polish-prose]]** for the line-editing pass.

## Reuse existing material

When turning a paper or notes into a post:

- If the source is an arxiv paper, the LaTeX source and any code sit under `raw/arxiv/` and `raw/github/` (see [[read-arxiv-paper]]). Read the actual source, do not work from memory of the abstract.
- Translate jargon into the post's own framing. Quote the source for specific numbers and claims, link to it, but make the argument in your own structure.
- Attribute every external number and claim with an inline link to its source.

## Gotchas

- **Do not invent the frontmatter slug from the title at publish time.** Set it deliberately and keep it fixed; it is the permanent URL.
- **The `<!-- truncate -->` marker is easy to forget.** Without it the entire post renders in the list view. Always include it after the lead.
- **Em-dashes creep in during drafting.** Do a final search for `--` and any em-dash character and remove every one.
- **Do not pad to length.** A tight 600-word post beats a padded 1500-word one. Length is never a goal.
- **Match the existing tag vocabulary.** Read a few sibling posts and reuse their tags rather than minting near-duplicates.
