---
sidebar_position: 4
---

# Backpropagation

Backpropagation is the algorithm that makes training neural networks tractable. It computes the gradient of the loss with respect to every parameter in $O(L \cdot C_{\text{fwd}})$ time and $O(L \cdot A)$ memory, where $L$ is the number of layers, $C_{\text{fwd}}$ is the forward-pass cost, and $A$ is the per-layer activation size. Without it, computing gradients would require $O(P)$ forward passes (one per parameter), making training of billion-parameter models impossible.

## The Chain Rule

<Theorem id="thm-backprop-chain-rule" name="Backpropagation via the Chain Rule">
For a composition of differentiable functions $f = f_L \circ f_{L-1} \circ \cdots \circ f_1$, the chain rule gives the gradient of a scalar loss $\mathcal{L}$ with respect to the parameters $\theta_l$ of layer $l$:

<Equation id="eq-chain-rule">

$$\frac{\partial \mathcal{L}}{\partial \theta_l} = \frac{\partial \mathcal{L}}{\partial h_L} \cdot \frac{\partial h_L}{\partial h_{L-1}} \cdots \frac{\partial h_{l+1}}{\partial h_l} \cdot \frac{\partial h_l}{\partial \theta_l}$$

</Equation>

where $h_l = f_l(h_{l-1}; \theta_l)$ is the output of layer $l$, with $h_0 = x$ (input) and $\mathcal{L} = \ell(h_L, y)$ (loss).
</Theorem>

<Remark id="rmk-backprop-efficiency">
**Why compute right-to-left?** The key insight is that $\partial \mathcal{L} / \partial h_l$ appears in the gradient for *every* layer $l' \leq l$. By computing the chain from right to left (from loss to input), we reuse the intermediate quantity $\partial \mathcal{L} / \partial h_l$ (called the "upstream gradient" or "delta") for all parameters in layers $l' \leq l$. Computing left-to-right (forward mode) would require a separate pass for each parameter.
</Remark>

## Computational Graphs

<Definition id="def-computational-graph" name="Computational Graph">
A neural network defines a **directed acyclic graph** (DAG) where:

- **Nodes** represent operations (matmul, add, ReLU, softmax) or variables (inputs, parameters)
- **Edges** represent data flow (tensors flowing between operations)
- **Forward pass:** evaluates nodes in topological order from inputs to loss, caching all intermediate activations
- **Backward pass:** traverses the graph in reverse topological order, computing gradients using the cached activations

Each node stores its **local Jacobian** -- how its output changes with respect to its inputs. The backward pass chains these local Jacobians via vector-Jacobian products (VJPs).
</Definition>

<Remark id="rmk-dag-branching">
When a node has multiple consumers (e.g., a residual connection where $h_l$ feeds both $f_{l+1}$ and the skip connection), the gradients from all consumers are **summed**. This is the multivariate chain rule: if $z = f(x)$ and $w = g(x)$ both depend on $x$, then $\partial \mathcal{L}/\partial x = \partial \mathcal{L}/\partial z \cdot \partial z/\partial x + \partial \mathcal{L}/\partial w \cdot \partial w/\partial x$.
</Remark>

## A Concrete Example

<Example id="ex-2layer-backprop">
**Two-layer network with MSE loss.** Let $\hat{y} = \sigma(W_2 \, \sigma(W_1 x + b_1) + b_2)$ with MSE loss $\mathcal{L} = \frac{1}{2}\|y - \hat{y}\|^2$.

**Forward pass** (compute and cache all intermediates):

$$z_1 = W_1 x + b_1, \quad h_1 = \sigma(z_1), \quad z_2 = W_2 h_1 + b_2, \quad \hat{y} = \sigma(z_2)$$

**Backward pass** (apply chain rule in reverse, reusing cached values):

| Step | Gradient | Depends On |
|------|----------|------------|
| Loss output | $\delta_{\hat{y}} = \frac{\partial \mathcal{L}}{\partial \hat{y}} = \hat{y} - y$ | $\hat{y}, y$ |
| Pre-activation 2 | $\delta_{z_2} = \delta_{\hat{y}} \odot \sigma'(z_2)$ | $\delta_{\hat{y}}, z_2$ (cached) |
| Weight 2 | $\frac{\partial \mathcal{L}}{\partial W_2} = \delta_{z_2} \, h_1^\top$ | $\delta_{z_2}, h_1$ (cached) |
| Bias 2 | $\frac{\partial \mathcal{L}}{\partial b_2} = \delta_{z_2}$ | $\delta_{z_2}$ |
| Hidden activation | $\delta_{h_1} = W_2^\top \delta_{z_2}$ | $\delta_{z_2}, W_2$ |
| Pre-activation 1 | $\delta_{z_1} = \delta_{h_1} \odot \sigma'(z_1)$ | $\delta_{h_1}, z_1$ (cached) |
| Weight 1 | $\frac{\partial \mathcal{L}}{\partial W_1} = \delta_{z_1} \, x^\top$ | $\delta_{z_1}, x$ (cached) |
| Bias 1 | $\frac{\partial \mathcal{L}}{\partial b_1} = \delta_{z_1}$ | $\delta_{z_1}$ |

Notice the pattern: each layer's backward pass produces (1) gradients for its own parameters and (2) a gradient for its input that becomes the upstream gradient for the next layer backwards.
</Example>

<Remark id="rmk-linear-layer-grad">
**Generic backward pass for $z = Wx + b$.** Given upstream gradient $\delta_z = \partial \mathcal{L}/\partial z$:

$$\frac{\partial \mathcal{L}}{\partial W} = \delta_z \, x^\top \quad \text{(outer product)}, \qquad \frac{\partial \mathcal{L}}{\partial b} = \delta_z, \qquad \frac{\partial \mathcal{L}}{\partial x} = W^\top \delta_z \quad \text{(matmul with transpose)}$$

This is why the backward pass has approximately the same computational cost as the forward pass: both are dominated by matrix multiplications of the same shapes (but transposed).
</Remark>

## Jacobians and Automatic Differentiation

<Definition id="def-jacobian" name="Jacobian Matrix">
For a function $f: \mathbb{R}^n \to \mathbb{R}^m$, the **Jacobian** is the $m \times n$ matrix of all first partial derivatives:

<Equation id="eq-jacobian">

$$J = \frac{\partial f}{\partial x} \in \mathbb{R}^{m \times n}, \qquad J_{ij} = \frac{\partial f_i}{\partial x_j}$$

</Equation>
</Definition>

<Definition id="def-vjp-jvp" name="VJP and JVP">
Modern automatic differentiation avoids materializing full Jacobians. Instead, it computes products with vectors:

- **Vector-Jacobian product (VJP):** Given $v \in \mathbb{R}^m$ (upstream gradient), compute $v^\top J \in \mathbb{R}^n$ in $O(mn)$ time. This is **reverse-mode AD** (backpropagation).

- **Jacobian-vector product (JVP):** Given $u \in \mathbb{R}^n$ (perturbation direction), compute $Ju \in \mathbb{R}^m$ in $O(mn)$ time. This is **forward-mode AD**.
</Definition>

<Remark id="rmk-forward-vs-reverse">
**When to use each mode:**

| Scenario | Inputs ($n$) | Outputs ($m$) | Best Mode | Cost |
|----------|-------------|---------------|-----------|------|
| Neural net (loss is scalar) | Millions of params | 1 | Reverse (VJP) | 1 backward pass |
| Sensitivity analysis | Few | Many | Forward (JVP) | $n$ forward passes |
| Hessian-vector product | $n$ | $n$ | Forward-over-reverse | 1 forward + 1 backward |

Neural networks have $m = 1$ (scalar loss) and $n \gg 1$ (many parameters), making reverse mode overwhelmingly more efficient. This is why backpropagation (reverse-mode AD) is the standard.
</Remark>

<Example id="ex-hessian-vector">
**Hessian-vector products without forming the Hessian.** The Hessian $H = \nabla^2 \mathcal{L} \in \mathbb{R}^{P \times P}$ is far too large to materialize ($P^2$ elements). But the product $Hv$ can be computed exactly by composing forward and reverse mode:

$$Hv = \nabla_\theta ((\nabla_\theta \mathcal{L})^\top v)$$

This costs one forward pass + one backward pass, regardless of $P$. Hessian-vector products are used in second-order methods (conjugate gradient, L-BFGS), eigenvalue estimation of the Hessian (for understanding loss landscape curvature), and natural gradient methods.
</Example>

## Gradient Flow Problems

<Definition id="def-gradient-flow" name="Gradient Flow">
**Gradient flow** refers to how the gradient magnitude evolves as it propagates backward through layers. For a depth-$L$ network without skip connections, the gradient at layer $l$ involves a product of $L - l$ Jacobians:

<Equation id="eq-gradient-product">

$$\frac{\partial \mathcal{L}}{\partial h_l} = \prod_{k=l+1}^{L} \frac{\partial h_k}{\partial h_{k-1}} \cdot \frac{\partial \mathcal{L}}{\partial h_L}$$

</Equation>

If the spectral norm $\|\partial h_k / \partial h_{k-1}\| < 1$ for most layers, the product shrinks exponentially (vanishing). If $> 1$, it grows exponentially (exploding).
</Definition>

<Table id="tab-gradient-problems" caption="Gradient flow problems, their causes, and solutions.">

| Problem | Mechanism | Symptom | Solution |
|---------|-----------|---------|----------|
| **Vanishing gradients** | $\|\sigma'\| < 1$ (sigmoid, tanh saturate); deep products shrink | Early layers do not learn | ReLU, skip connections, normalization |
| **Exploding gradients** | $\|W_l\| > 1$; products of weight matrices grow | Loss spikes, NaN | Gradient clipping, careful initialization |
| **Dead neurons** | ReLU: $\sigma'(z) = 0$ for $z < 0$; once dead, gradient is permanently zero | Parameters stop updating | Leaky ReLU ($\alpha = 0.01$), lower learning rate |
| **Shattered gradients** | Gradient correlation between nearby points decays with depth | Gradients resemble white noise in deep nets | BatchNorm, residual connections |

</Table>

<Theorem id="thm-residual-gradient" name="Gradient Flow Through Residual Connections">
For a residual block $h_l = f_l(h_{l-1}) + h_{l-1}$, the Jacobian is:

<Equation id="eq-residual-jacobian">

$$\frac{\partial h_l}{\partial h_{l-1}} = \frac{\partial f_l}{\partial h_{l-1}} + I$$

</Equation>

The additive identity $I$ provides a "gradient highway" -- even if $\partial f_l / \partial h_{l-1}$ is small, the gradient passes through the skip connection unattenuated. For a network with $L$ residual blocks:

$$\frac{\partial \mathcal{L}}{\partial h_0} = \frac{\partial \mathcal{L}}{\partial h_L} \cdot \prod_{l=1}^{L}\left(\frac{\partial f_l}{\partial h_{l-1}} + I\right)$$

Expanding this product yields $2^L$ terms, one for each subset of layers. The "direct path" (all identity terms) contributes $\partial \mathcal{L}/\partial h_L$ directly, ensuring gradients reach early layers regardless of depth [@he2016resnet].
</Theorem>

## Weight Initialization

<Remark id="rmk-initialization">
**Proper initialization preserves gradient scale.** For a linear layer $h_l = W_l h_{l-1}$, the variance of the output is $\text{Var}(h_{l,j}) = n_{\text{in}} \cdot \text{Var}(W_{l,ij}) \cdot \text{Var}(h_{l-1,i})$. To prevent activations from exploding or vanishing across layers, we need $n_{\text{in}} \cdot \text{Var}(W) = 1$.
</Remark>

<Table id="tab-initialization" caption="Standard initialization schemes.">

| Scheme | Weight Variance | Activation | Reference |
|--------|----------------|------------|-----------|
| Xavier / Glorot | $\text{Var}(W) = \frac{2}{n_{\text{in}} + n_{\text{out}}}$ | Sigmoid, Tanh | [@glorot2010understanding] |
| He / Kaiming | $\text{Var}(W) = \frac{2}{n_{\text{in}}}$ | ReLU | [@he2015delving] |
| LeCun | $\text{Var}(W) = \frac{1}{n_{\text{in}}}$ | SELU | [@lecun2012efficient] |

</Table>

## Memory Cost of Backpropagation

<Remark id="rmk-memory-cost">
Backpropagation must cache all intermediate activations from the forward pass for use in the backward pass. For a transformer with $L$ layers, sequence length $T$, hidden dimension $d$, and batch size $B$:

$$\text{Activation memory} \approx L \cdot B \cdot T \cdot d \cdot (\text{bytes per element}) \cdot (\text{constant factor})$$

For LLaMA-7B ($L=32, d=4096$) with $B=1, T=2048$ in FP16: $\approx 32 \times 1 \times 2048 \times 4096 \times 2 \times 10 \approx 5$ GB. This often exceeds the model parameter memory, which is why **gradient checkpointing** (recomputing activations during the backward pass instead of caching them) is standard for training large models.
</Remark>

## Notation Summary

<Table id="tab-notation-backprop" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $h_l$ | Activation (output) of layer $l$ |
| $z_l$ | Pre-activation (before nonlinearity) of layer $l$ |
| $\delta_l = \partial \mathcal{L}/\partial z_l$ | Error signal (delta) at layer $l$ |
| $\sigma, \sigma'$ | Activation function and its derivative |
| $\odot$ | Elementwise (Hadamard) product |
| $J$ | Jacobian matrix |
| VJP | Vector-Jacobian product (reverse-mode AD) |
| JVP | Jacobian-vector product (forward-mode AD) |
| $n_{\text{in}}, n_{\text{out}}$ | Fan-in and fan-out of a layer |
| $I$ | Identity matrix |

</Table>
