---
sidebar_position: 2
title: "Math"
---

# Math

This site supports LaTeX math via [KaTeX](https://katex.org/) and numbered math environment components for academic-style content.

---

## Inline and Display Math

Use single dollar signs for inline math: `$E = mc^2$` renders as $E = mc^2$.

Use double dollar signs for display math:

$$
\nabla_\theta J(\theta) = \mathbb{E}_{\pi_\theta} \left[ \sum_{t=0}^{T} \nabla_\theta \log \pi_\theta(a_t | s_t) \cdot G_t \right]
$$

See the full list of supported functions at [KaTeX docs](https://katex.org/docs/supported).

---

## Numbered Equations

The `<Equation>` component renders a centered, numbered equation:

<Equation id="eq-cross-entropy">

$$L(\theta) = -\sum_{i=1}^{N} y_i \log \hat{y}_i$$

</Equation>

<Equation id="eq-softmax">

$$\text{softmax}(z_i) = \frac{e^{z_i}}{\sum_{j} e^{z_j}}$$

</Equation>

Reference them inline: the cross-entropy loss [](#eq-cross-entropy) uses the softmax [](#eq-softmax).

---

## Definitions, Theorems, and Proofs

<Definition id="def-convex" name="Convex Function">
A function $f: \mathbb{R}^n \to \mathbb{R}$ is **convex** if for all $x, y \in \text{dom}(f)$ and $\lambda \in [0, 1]$:

$$f(\lambda x + (1-\lambda) y) \leq \lambda f(x) + (1-\lambda) f(y)$$
</Definition>

<Theorem id="thm-jensen" name="Jensen's Inequality">
If $f$ is a convex function (see [](#def-convex)) and $X$ is a random variable, then:

$$f(\mathbb{E}[X]) \leq \mathbb{E}[f(X)]$$
</Theorem>

<Proof>
By [](#def-convex), for any convex combination we have $f(\lambda x + (1-\lambda)y) \leq \lambda f(x) + (1-\lambda)f(y)$. Extending by induction to $n$ points with weights $\lambda_i \geq 0, \sum \lambda_i = 1$ gives $f\!\left(\sum_i \lambda_i x_i\right) \leq \sum_i \lambda_i f(x_i)$. Taking the limit to a continuous distribution yields the result.
</Proof>

---

## All Available Environments

All environments are auto-numbered and cross-referenceable via `id`. Use `name` for an optional label.

<Table id="tab-math-envs" caption="Available math environment components.">

| Component | Color | Use case | Syntax example |
|-----------|-------|----------|----------------|
| `<Theorem>` | Blue-gray | Main results | `<Theorem id="thm-main" name="Main Result">...</Theorem>` |
| `<Lemma>` | Blue-gray | Supporting results | `<Lemma id="lem-bound">...</Lemma>` |
| `<Proposition>` | Blue-gray | Intermediate claims | `<Proposition id="prop-equiv">...</Proposition>` |
| `<Corollary>` | Blue-gray | Direct consequences | `<Corollary id="cor-rate">...</Corollary>` |
| `<Definition>` | Green | Formal definitions | `<Definition id="def-foo" name="Foo">...</Definition>` |
| `<Remark>` | Yellow | Commentary and observations | `<Remark id="rmk-note">...</Remark>` |
| `<Example>` | Purple | Worked examples | `<Example id="ex-demo">...</Example>` |
| `<Proof>` | Left border | Proof with QED symbol | `<Proof>...</Proof>` |
| `<Equation>` | — | Centered numbered equation | `<Equation id="eq-loss">$$...$$</Equation>` |
| `<Code>` | — | Captioned code block | `<Code id="code-foo" caption="...">...</Code>` |
| `<Algorithm>` | Bordered | Pseudocode with caption | `<Algorithm id="alg-foo" caption="...">...</Algorithm>` |

</Table>
