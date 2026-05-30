---
name: write-textbook
description: 'Author or revise a textbook chapter section for this site''s MDX book system (content/books/math, content/books/programming, and sibling books). Use when the user wants to write a new section, draft a chapter, add a definition or worked example, or restructure existing book content. Trigger on: "write a textbook section", "draft a chapter", "add a definition/theorem/example", "write up X for the book", "revise this section".'
---

# Write Textbook

Author and revise sections for this site's MDX book system. Books live under `mochi-lab/content/books/` (for example `math/`, `programming/`, `survey/`). Each book is a tree of numbered chapter directories, each holding numbered section files plus an `index.md`.

This skill shapes pedagogy, structure, and the correct use of custom MDX components. Hand the final line-editing pass to [[polish-prose]]. For blog or research posts (a different format and frontmatter), use [[write-blog]] instead.

The component reference lives in `mochi-lab/content/books/build-with-ai/components-of-textbooks/`. Read it when in doubt. A strong real model is `mochi-lab/content/books/math/3-linear-algebra/5-matrix-calculus.md`.

## File layout and frontmatter

- Chapters are numbered directories: `3-linear-algebra/`, `4-calculus-and-optimization/`. Sections are numbered files inside: `1-vectors-and-matrices.md`, `5-matrix-calculus.md`.
- Each chapter has an `index.md` that lists its sections with one-line descriptions and links. It may carry a `title:` and a `sidebar_position: 0` in frontmatter, or no frontmatter at all. Follow the sibling chapters' convention.
- Section frontmatter is minimal:

```yaml
---
sidebar_position: 5
---

# Section Title
```

- `sidebar_position` sets sidebar order and must be unique within its directory. Match the numeric prefix of the filename (`5-matrix-calculus.md` uses `sidebar_position: 5`).
- Section files usually carry the title as a single top-level `# Heading` rather than a frontmatter `title:`. Follow the convention of the sibling files in the same chapter.
- Use `##` for the section's subsections and `###` below that. Do not skip levels.

## Custom components (exact signatures)

These render globally with no import needed (registered in `src/theme/MDXComponents.js`). Every numbered component takes an `id` used for cross-referencing. IDs must be unique across the whole book.

**Math environments** (auto-numbered, cross-referenceable). `id` required, `name` optional label:

```mdx
<Definition id="def-convex" name="Convex Function"> ... </Definition>
<Theorem id="thm-jensen" name="Jensen's Inequality"> ... </Theorem>
<Lemma id="lem-bound"> ... </Lemma>
<Proposition id="prop-equiv"> ... </Proposition>
<Corollary id="cor-rate"> ... </Corollary>
<Remark id="rmk-note"> ... </Remark>
<Example id="ex-demo"> ... </Example>
<Proof> ... </Proof>
```

`<Proof>` takes no `id`. It renders a left border and a QED mark.

**Equation** (centered, numbered). Wrap a `$$...$$` block:

```mdx
<Equation id="eq-loss">

$$L(\theta) = -\sum_{i=1}^{N} y_i \log \hat{y}_i$$

</Equation>
```

**Figure and Table** (auto-numbered). `id` and `caption` both required:

```mdx
<Figure id="fig-loop" caption="The agent perception-action loop.">

![alt text](./assets/diagram.jpg)

</Figure>

<Table id="tab-results" caption="Benchmark results." columns="center">

| Method | Score |
|--------|-------|
| Base   | 74.2  |

</Table>
```

`<Table>` accepts an optional `columns="center" | "left" | "right"` to align all columns, or use markdown `:---:` syntax for per-column control. A figure can wrap any content: images, code, or React components.

**Code and Algorithm** (numbered, captioned). `id` and `caption` required:

````mdx
<Code id="code-block" caption="Transformer block in PyTorch.">

```python
...
```

</Code>

<Algorithm id="alg-sgd" caption="Stochastic Gradient Descent">

**Input:** ...
1. **for** $t = 1 \ldots T$ **do**
...

</Algorithm>
````

Inside a `<Code>` block, `# highlight-next-line` highlights the following line.

**Spacing rule:** leave a blank line after the opening tag and before the closing tag of any wrapper component (`Figure`, `Table`, `Equation`, `Code`, `Algorithm`). The inner markdown or `$$` block needs the surrounding blank lines to parse. The inline environments (`Definition`, `Theorem`, `Remark`, `Example`, and the rest) hold prose and math directly without the blank-line padding.

## Math conventions (KaTeX)

- Inline math: `$E = mc^2$`. Display math: `$$...$$`. The renderer is KaTeX; check the supported-function list before using exotic macros.
- State the layout convention once when it matters. This repo uses numerator layout for matrix calculus (gradient is a column vector, Jacobian is $m \times n$), consistent with PyTorch `.grad`. Put such conventions in a `<Remark>`.
- Keep one symbol for one concept across a section, and add a notation-summary `<Table>` at the end of any symbol-heavy section (see the matrix-calculus section for the pattern).
- Use `\top` for transpose, `\odot` for Hadamard, `\mathbb{R}` for reals. Match the notation already used in sibling sections.

## Citations

- Cite inline with `[@key]`: `the transformer [@vaswani2017attention] changed NLP`. Multiple: `[@devlin2019bert; @brown2020gpt3]`.
- A **References** section auto-generates at the bottom of the page. Do not write one by hand.
- Add the entry to `references.yaml` at the project root. Required fields: `type`, `title`, `author` (list of full names), `year`. Optional: `venue`, `url`, `doi`, `volume`, `pages`. The dev server hot-reloads it. An unknown key renders a red warning rather than breaking the build, so verify the key exists.

## Cross-referencing

- **Same page:** `[](#id)`. The link text auto-fills with the right label and number: `see [](#def-convex) and [](#eq-softmax)`. Leave the link text empty.
- **Across pages:** `<Ref id="..." />` resolves the page URL and label automatically: `<Ref id="thm-jensen" />`.
- **Chapter index navigation:** `<PageRef path="./section-slug" />` links to a sibling section by path (used in `index.md` files). Sibling chapters may instead use plain markdown links in their `index.md`; match the local convention.

## Pedagogical structure of a strong section

Sequence intuition before formalism. The reliable rhythm is **motivate, define, illustrate, connect**:

1. **Motivate (1-2 short paragraphs).** Open with why the concept exists: the problem it solves, the thing it generalizes, or a concrete picture. The matrix-calculus section opens by framing the whole topic as the language of backprop. Never open with a cold definition.
2. **Define.** State the formal `<Definition>` (or `<Theorem>`). Immediately follow it with one plain sentence of meaning: what it computes, what it points at, what shape it has. Rigor should sharpen intuition, not replace it.
3. **Illustrate with a worked example.** This is the highest-leverage element. Use `<Example>` to walk a concrete derivation or computation step by step. The worked-example effect is one of the strongest results in instructional design: a fully worked solution beats "now try it yourself" for a reader meeting the idea for the first time. For a transferable idea, give a second, slightly harder example. As a section builds toward harder material, fade the detail: spell out early examples fully, then leave routine steps to the reader (the expertise-reversal effect means experts gain little from over-explained steps).
4. **Connect.** Use `<Remark>` for the non-obvious payoff: a complexity caveat, why the naive approach fails, a link to a downstream technique. End the section on the consequence, not a restatement.

Supporting moves:

- Use a `<Table>` to enumerate parallel cases (identities, Jacobians, applications). Tables of worked rows carry a lot of a technical section's value.
- Pull a reusable sub-result into its own `<Lemma>` rather than burying it inside a long `<Proof>`. Short proofs read; eight-page proofs do not.
- Keep paragraphs to two to four sentences, one idea each. No filler, no "it is important to note".

## Workflow

1. **Locate the slot.** Find the chapter directory and read its `index.md` and one or two sibling sections to absorb the local notation and depth. Pick the next free numeric prefix and a matching unique `sidebar_position`.
2. **Outline the spine.** List subsections as a learning progression, simplest first. Confirm anything chapter-length with the user.
3. **Draft section by section** following motivate, define, illustrate, connect. Reach for the right component each time rather than plain markdown for definitions, equations, and examples.
4. **Wire up references.** Add any `[@key]` entries to `references.yaml`. Cross-link related results with `[](#id)` and `<Ref>`.
5. **Update the chapter `index.md`** to list the new section with a one-line description and a `<PageRef>` or markdown link, matching the existing entries.
6. **Hand off to [[polish-prose]]** for the line-editing pass.

## Gotchas

- **Never use `--` or em-dash characters.** Restructure, or use a colon, comma, or parentheses. Hard repo rule. Some existing files violate it (including the matrix-calculus sample); do not copy that. Search your draft for `--` before finishing.
- **Every numbered component needs a unique `id`.** A duplicate `id` breaks cross-references silently. `<Figure>`, `<Table>`, `<Code>`, `<Algorithm>` also require `caption`. `<Definition>` and `<Theorem>` take an optional `name`.
- **`sidebar_position` must be unique within its directory** and should match the filename's numeric prefix.
- **Blank lines inside wrapper components are mandatory.** A `$$` block or markdown table jammed against the opening or closing tag of `<Equation>`, `<Table>`, `<Code>`, or `<Figure>` fails to render.
- **Close every component tag.** An unclosed `<Example>` or `<Table>` swallows the rest of the page.
- **Same-page links use empty text:** `[](#id)`, not `[Definition 1](#id)`. The label auto-fills. Cross-page uses `<Ref id="..." />`, not a markdown link.
- **Do not hand-write a References section.** It is generated from `[@key]` usage plus `references.yaml`. Verify each citation key exists in the YAML.
- **Lead with motivation, not a definition.** A section that opens cold with `<Definition>` is the most common pedagogical miss here.
- **Length is never the goal.** A tight section that builds one idea well beats a padded survey.
