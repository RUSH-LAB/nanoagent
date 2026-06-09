---
sidebar_position: 4
title: "Paper Citation"
---

# Paper Citation

Cite references using `[@key]` syntax in any markdown file. A **References** section is auto-generated at the bottom of the page.

---

## Inline Citations

Single citation: the transformer architecture [@vaswani2017attention] changed NLP.

Multiple citations: recent work [@devlin2019bert; @brown2020gpt3] builds on this.

- **Single**: `[@vaswani2017attention]`
- **Multiple**: `[@devlin2019bert; @brown2020gpt3]`

Author formatting: 1 author shows `(Smith, 2024)`, 2 authors `(Smith & Jones, 2024)`, 3+ authors `(Smith et al., 2024)`. Clicking scrolls to the reference at the bottom.

---

## Adding References

Add entries to `references.yaml` at the project root:

```yaml
vaswani2017attention:
  type: article
  title: "Attention Is All You Need"
  author:
    - "Ashish Vaswani"
    - "Noam Shazeer"
  year: 2017
  venue: "NeurIPS"
  url: "https://arxiv.org/abs/1706.03762"
```

<Table id="tab-bib-schema" caption="Bibliography entry schema for references.yaml.">

| Field | Required | Type | Description | Example |
|-------|----------|------|-------------|---------|
| `type` | Yes | string | Entry type | `article`, `inproceedings`, `book`, `thesis` |
| `title` | Yes | string | Full paper title | `"Attention Is All You Need"` |
| `author` | Yes | list | Author full names | `["Ashish Vaswani", "Noam Shazeer"]` |
| `year` | Yes | integer | Publication year | `2017` |
| `venue` | No | string | Conference or journal | `"NeurIPS"`, `"JMLR"` |
| `url` | No | string | Link (makes clickable) | `"https://arxiv.org/abs/1706.03762"` |
| `doi` | No | string | Digital Object Identifier | `"10.5555/3295222.3295349"` |
| `volume` | No | string | Journal volume | `"32"` |
| `pages` | No | string | Page range | `"5998-6008"` |

</Table>

The dev server picks up changes to `references.yaml` without a restart. Unknown keys render as a red warning without breaking the build. All references are also browsable on the [Bibliography](/bibliography) page.
