---
sidebar_position: 3
title: "Code"
---

# Code

Syntax-highlighted code blocks via [Prism](https://prismjs.com/), with light and dark theme support. The light and dark themes are configured through the `prism.theme` and `prism.darkTheme` settings in `docusaurus.config.js`, and the active theme follows the site's color mode automatically.

---

## Inline Code

Use single backticks: `const x = 42`.

---

## Code Blocks

Specify the language after the opening triple backticks. Wrap in `<Code>` for a numbered, captioned, cross-referenceable block:

<Code id="code-transformer" caption="Transformer block implementation in PyTorch.">

```python
import torch.nn as nn

class TransformerBlock(nn.Module):
    def __init__(self, d_model, n_heads, d_ff):
        super().__init__()
        self.attn = nn.MultiheadAttention(d_model, n_heads)
        self.ff = nn.Sequential(nn.Linear(d_model, d_ff), nn.GELU(), nn.Linear(d_ff, d_model))
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)

    def forward(self, x):
        x = self.norm1(x + self.attn(x, x, x)[0])
        x = self.norm2(x + self.ff(x))
        return x
```

</Code>

<Code id="code-train-step" caption="A single training step with line highlighting.">

```python
def train_step(model, batch, optimizer):
    optimizer.zero_grad()
    # highlight-next-line
    loss = model(batch)
    loss.backward()
    optimizer.step()
    return loss.item()
```

</Code>

The `# highlight-next-line` comment in Code 2 is a Docusaurus directive rather than an ordinary code comment, and it highlights the line that follows it. To highlight a span of lines, wrap them with `# highlight-start` and `# highlight-end`, or use the range syntax such as `{2,4-6}` after the language tag on the opening fence.

Reference them inline: see [](#code-transformer) and [](#code-train-step).

---

## Supported Languages

<Table id="tab-languages" caption="Common language tags for syntax highlighting.">

| Language | Tag | Example | Description |
|----------|-----|---------|-------------|
| Python | `python` | `def foo(): pass` | ML, data science, scripting |
| JavaScript | `js` | `const x = 42;` | Frontend, Node.js, React |
| TypeScript | `ts` | `let x: number = 42;` | Typed JavaScript |
| Bash | `bash` | `echo "hello"` | Shell scripts, CLI commands |
| C / C++ | `c` / `cpp` | `int main() {}` | Systems, CUDA kernels |
| Java | `java` | `System.out.println()` | Enterprise, Android |
| Rust | `rust` | `fn main() {}` | Systems, performance-critical |
| YAML / JSON | `yaml` / `json` | `key: value` | Configuration files |
| LaTeX | `latex` | `\frac{a}{b}` | Math typesetting |
| SQL | `sql` | `SELECT * FROM t` | Database queries |

</Table>

:::note
Only the languages bundled by `prism-react-renderer` are highlighted by default. Python, JavaScript, TypeScript, C, C++, Rust, SQL, YAML, and JSON are bundled and work out of the box. Bash, Java, and LaTeX are not bundled, so they render as plaintext until you add them to the `additionalLanguages` array in the Prism configuration of `docusaurus.config.js`.
:::

Full list at [Prism supported languages](https://prismjs.com/#supported-languages).

---

## Algorithms

The `<Algorithm>` component renders a bordered pseudocode block with a numbered caption:

<Algorithm id="alg-sgd" caption="Stochastic Gradient Descent">

**Input:** learning rate $\eta$, initial parameters $\theta_0$, dataset $\mathcal{D}$

1. **for** $t = 1, 2, \ldots, T$ **do**
2. &nbsp;&nbsp;&nbsp;&nbsp;Sample mini-batch $\mathcal{B} \subset \mathcal{D}$
3. &nbsp;&nbsp;&nbsp;&nbsp;$g_t \leftarrow \frac{1}{|\mathcal{B}|} \sum_{(x,y) \in \mathcal{B}} \nabla_\theta \ell(f_\theta(x), y)$
4. &nbsp;&nbsp;&nbsp;&nbsp;$\theta_t \leftarrow \theta_{t-1} - \eta \cdot g_t$
5. **end for**

**Output:** trained parameters $\theta_T$

</Algorithm>

Reference: see [](#alg-sgd).
