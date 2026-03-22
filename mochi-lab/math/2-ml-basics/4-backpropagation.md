---
sidebar_position: 4
---

# Backpropagation

## The Chain Rule

Backpropagation is the chain rule applied systematically to computational graphs. For a composition $f = f_L \circ f_{L-1} \circ \cdots \circ f_1$, the chain rule gives:

$$
\frac{\partial \mathcal{L}}{\partial \theta_l} = \frac{\partial \mathcal{L}}{\partial h_L} \cdot \frac{\partial h_L}{\partial h_{L-1}} \cdots \frac{\partial h_{l+1}}{\partial h_l} \cdot \frac{\partial h_l}{\partial \theta_l}
$$

where $h_l = f_l(h_{l-1}; \theta_l)$ is the output of layer $l$.

## Computational Graphs

A neural network defines a **directed acyclic graph** (DAG) where:

- **Nodes** represent operations (matmul, add, ReLU) or variables
- **Edges** represent data flow (tensors)
- **Forward pass** computes outputs by traversing the graph from inputs to loss
- **Backward pass** computes gradients by traversing in reverse (topological order)

Each node stores the **local Jacobian** -- how its output changes with respect to its inputs. The backward pass multiplies these local Jacobians along every path from the loss to each parameter.

## A Concrete Example

Consider a 2-layer network: $\hat{y} = \sigma(W_2 \, \sigma(W_1 x + b_1) + b_2)$ with MSE loss $\mathcal{L} = \frac{1}{2}\|y - \hat{y}\|^2$.

**Forward pass** (compute and cache intermediates):

$$
z_1 = W_1 x + b_1, \quad h_1 = \sigma(z_1), \quad z_2 = W_2 h_1 + b_2, \quad \hat{y} = \sigma(z_2)
$$

**Backward pass** (apply chain rule in reverse):

$$
\frac{\partial \mathcal{L}}{\partial \hat{y}} = \hat{y} - y
$$

$$
\frac{\partial \mathcal{L}}{\partial z_2} = \frac{\partial \mathcal{L}}{\partial \hat{y}} \odot \sigma'(z_2)
$$

$$
\frac{\partial \mathcal{L}}{\partial W_2} = \frac{\partial \mathcal{L}}{\partial z_2} \, h_1^\top, \quad \frac{\partial \mathcal{L}}{\partial b_2} = \frac{\partial \mathcal{L}}{\partial z_2}
$$

$$
\frac{\partial \mathcal{L}}{\partial h_1} = W_2^\top \frac{\partial \mathcal{L}}{\partial z_2}
$$

$$
\frac{\partial \mathcal{L}}{\partial z_1} = \frac{\partial \mathcal{L}}{\partial h_1} \odot \sigma'(z_1)
$$

$$
\frac{\partial \mathcal{L}}{\partial W_1} = \frac{\partial \mathcal{L}}{\partial z_1} \, x^\top, \quad \frac{\partial \mathcal{L}}{\partial b_1} = \frac{\partial \mathcal{L}}{\partial z_1}
$$

**Key insight:** The backward pass for a linear layer $z = Wx + b$ always has the form: gradient w.r.t. $W$ is an outer product of the incoming gradient and the cached input; gradient w.r.t. $x$ is a matrix-vector product with $W^\top$.

## Jacobians and Vector-Jacobian Products

For a function $f: \mathbb{R}^n \to \mathbb{R}^m$, the **Jacobian** is the $m \times n$ matrix:

$$
J_{ij} = \frac{\partial f_i}{\partial x_j}
$$

Backpropagation never materializes full Jacobians. Instead, it computes **vector-Jacobian products** (VJPs):

$$
v^\top J \quad \text{where } v = \frac{\partial \mathcal{L}}{\partial f} \in \mathbb{R}^m
$$

This costs $O(mn)$ -- the same as one forward pass -- regardless of the number of parameters. The dual operation, **Jacobian-vector product** (JVP) $Jv$, is used in forward-mode AD and is efficient when outputs outnumber inputs.

## Gradient Flow Problems

**Vanishing gradients:** When $|\sigma'(z)| < 1$ everywhere (sigmoid, tanh), the product $\prod_{l} \sigma'(z_l)$ shrinks exponentially with depth. The gradient signal decays before reaching early layers.

**Exploding gradients:** When $\|W_l\| > 1$, the product $\prod_l W_l^\top$ grows exponentially. Gradient clipping bounds the norm: $g \leftarrow g \cdot \min(1, \, c / \|g\|)$.

| Problem | Cause | Solution |
|---------|-------|----------|
| Vanishing gradients | $\|\sigma'\| < 1$, deep networks | ReLU, residual connections, LayerNorm |
| Exploding gradients | $\|W\| > 1$, recurrent networks | Gradient clipping, careful initialization |
| Dead neurons | ReLU: $\sigma'(z) = 0$ for $z < 0$ | Leaky ReLU, careful learning rate |

**Key insight:** Residual connections $h_l = f_l(h_{l-1}) + h_{l-1}$ provide a gradient highway. The gradient through the skip connection is exactly 1, ensuring that gradients flow to early layers regardless of depth.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $h_l$ | Activation (output) of layer $l$ |
| $z_l$ | Pre-activation (before nonlinearity) of layer $l$ |
| $\sigma$ | Activation function |
| $\sigma'$ | Derivative of activation function |
| $\odot$ | Elementwise (Hadamard) product |
| $J$ | Jacobian matrix |
| VJP | Vector-Jacobian product (reverse mode) |
| JVP | Jacobian-vector product (forward mode) |
