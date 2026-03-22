---
sidebar_position: 0
title: "Introduction"
---

# Build with AI

This section documents the components and tools available for writing textbook-style content with AI assistance.

## Table of Contents

### [Components of Textbooks](./components-of-textbooks/figure-and-table)

Every page has access to these components — no imports needed:

- **Theorem-like environments**: `<Theorem>`, `<Lemma>`, `<Proposition>`, `<Corollary>`, `<Definition>`, `<Remark>`, `<Example>`, `<Proof>` — auto-numbered per chapter with shared counter
- **Equations**: `<Equation>` — numbered per section (`chapter.section.N`)
- **Figures and Tables**: `<Figure>`, `<Table>` — numbered per chapter
- **Code and Algorithms**: `<Code>`, `<Algorithm>` — numbered per chapter
- **Cross-references**: `<Ref id="..." />` — links to any numbered component across pages
- **Citations**: `[@key]` syntax with auto-generated reference lists

## Roadmap

<Table id="tab-roadmap" caption="Planned features and integrations.">

| Feature | Description | Status |
|---------|-------------|--------|
| Lean 4 | Formal proofs alongside informal ones | Planned |
| Interactive Visualizations | Geometric and algebraic diagrams | Planned |

</Table>
