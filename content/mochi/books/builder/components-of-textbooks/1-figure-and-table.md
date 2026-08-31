---
sidebar_position: 1
title: "Figure and Table"
---

# Figure and Table

The `<Figure>` and `<Table>` components provide auto-numbered, captioned, and cross-referenceable figures and tables.

---

## Figures

Wrap any content in a `<Figure>` with an `id` and `caption`:

<Figure id="fig-agent-loop" caption="The agent perception-action loop.">

![Agent loop](./assets/demo-architecture.jpg)

</Figure>

<Figure id="fig-retrieval" caption="Retrieval-augmented generation pipeline.">

![Retrieval pipeline](./assets/demo-pipeline.jpg)

</Figure>

Reference them inline: see [](#fig-agent-loop) and [](#fig-retrieval).

Figures can contain any content, including images, diagrams, code blocks, or even React components.

Leave a blank line after the opening `<Figure>` tag and before the closing `</Figure>` tag. MDX needs that surrounding whitespace to parse the inner markdown; a tighter layout without the blank lines renders the content unprocessed.

---

## Tables

Wrap a markdown table in a `<Table>` with an `id` and `caption`:

<Table id="tab-agent-types" caption="Comparison of agent architectures.">

| Architecture | Reasoning | Memory | Planning | Tool Use | Key Idea |
|-------------|-----------|--------|----------|----------|----------|
| ReAct | Chain-of-thought | Short-term | No | Yes | Interleave reasoning and acting steps |
| Plan-and-Execute | Hierarchical | Long-term | Yes | Yes | Generate full plan, then execute sequentially |
| Reflexion | Self-critique | Episodic | Yes | Yes | Reflect on failures and retry with memory |
| LATS | Tree search | Short-term | Yes | Yes | Monte Carlo tree search over action space |

</Table>

<Table id="tab-benchmarks" caption="Performance on standard benchmarks.">

| Method | HumanEval | MATH | MMLU | GSM8K | ARC-C | Avg |
|--------|-----------|------|------|-------|-------|-----|
| Base LLM | 67.0 | 50.4 | 86.4 | 78.2 | 89.1 | 74.2 |
| + Tool Use | 85.4 | 68.2 | 88.1 | 83.5 | 90.3 | 83.1 |
| + RAG | 72.1 | 55.8 | 91.3 | 80.1 | 93.7 | 78.6 |
| + Tool + RAG | 88.2 | 71.4 | 92.0 | 86.3 | 94.1 | 86.4 |

</Table>

As with figures, keep a blank line after the opening `<Table>` tag and before the closing `</Table>` tag so MDX parses the markdown table inside.

Reference them inline: architectures in [](#tab-agent-types), results in [](#tab-benchmarks).

---

## Column Alignment

Use `columns` to set all columns to `"center"`, `"left"`, or `"right"`:

<Table id="tab-cols-center" caption="Center-aligned columns." columns="center">

| Model | Params | Top-1 Accuracy | Top-5 Accuracy | Training Data | Epochs |
|-------|--------|-----------|-----------|---------------|--------|
| Small | 125M | 82.1 | 95.3 | ImageNet-1K | 90 |
| Base | 350M | 88.4 | 97.1 | ImageNet-1K | 90 |
| Large | 1.3B | 93.2 | 99.0 | ImageNet-21K | 30 |

</Table>

<Table id="tab-cols-right" caption="Right-aligned columns." columns="right">

| Model | Params | Top-1 Accuracy | Top-5 Accuracy | Training Data | Epochs |
|-------|--------|-----------|-----------|---------------|--------|
| Small | 125M | 82.1 | 95.3 | ImageNet-1K | 90 |
| Base | 350M | 88.4 | 97.1 | ImageNet-1K | 90 |
| Large | 1.3B | 93.2 | 99.0 | ImageNet-21K | 30 |

</Table>

You can also use standard markdown column alignment syntax (`:---`, `:---:`, `---:`) for per-column control without the `columns` prop.
