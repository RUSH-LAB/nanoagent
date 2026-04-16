---
sidebar_position: 2
---

# Autograd

Automatic differentiation (autograd) is the engine that makes training neural networks possible. When you call `loss.backward()`, PyTorch traces back through every operation that produced the loss, computing the gradient of the loss with respect to every parameter. This chapter explains how the computational graph works, how gradients are computed and accumulated, and the common patterns and pitfalls you will encounter.

## Computational Graphs

PyTorch builds a **dynamic computational graph** during the forward pass. Each tensor operation creates a node in the graph, and edges track dependencies. The graph is then traversed in reverse (backpropagation) to compute gradients.

<Code id="code-autograd-graph" caption="PyTorch builds a dynamic computational graph during the forward pass.">

```python
import torch

# Leaf tensors with requires_grad=True are the "roots" of the graph
x = torch.randn(3, requires_grad=True)   # Leaf tensor: tracked by autograd
w = torch.randn(3, requires_grad=True)   # Leaf tensor: model parameter

# Each operation creates a new node with a grad_fn
y = x * w                     # y.grad_fn = <MulBackward0>
z = y.sum()                   # z.grad_fn = <SumBackward0>

# The graph connects z -> y -> (x, w)
print(z.grad_fn)                          # <SumBackward0>
print(z.grad_fn.next_functions)           # Points to MulBackward0
print(z.grad_fn.next_functions[0][0].next_functions)  # Points to leaf accumulators

# Leaf tensors have no grad_fn (they are inputs, not computed)
print(x.grad_fn)   # None
print(x.is_leaf)   # True
print(y.is_leaf)   # False
```

</Code>

<Remark id="rmk-dynamic-graph">
**Dynamic vs static graphs.** PyTorch uses **define-by-run** (eager mode): the graph is built anew on every forward pass. This means:

| Property | Dynamic (PyTorch) | Static (TensorFlow 1.x, JAX) |
|----------|-------------------|-------------------------------|
| Graph construction | Every forward pass | Once, then reused |
| Python control flow | Fully supported (`if`, `for`, etc.) | Requires special primitives |
| Debugging | Standard Python debugger (pdb, breakpoints) | Difficult (graph is compiled) |
| Variable-length inputs | Natural (different graph each time) | Requires padding/bucketing |
| Compilation | `torch.compile` adds JIT compilation | Built-in |
| Overhead | Higher per-op (Python dispatch) | Lower per-op (precompiled) |

The dynamic graph is why PyTorch is easy to debug and prototype with. `torch.compile` bridges the gap by capturing the graph for JIT optimization while preserving the eager programming model.
</Remark>

## backward() and Gradient Computation

Calling `.backward()` on a scalar tensor computes gradients for all leaf tensors with `requires_grad=True`:

<Code id="code-autograd-backward" caption="Computing gradients with backward() and the chain rule.">

```python
x = torch.tensor([1.0, 2.0, 3.0], requires_grad=True)
y = (x ** 2).sum()   # y = x1^2 + x2^2 + x3^2

y.backward()          # Compute dy/dx using the chain rule
print(x.grad)         # tensor([2., 4., 6.])  -- dy/dxi = 2*xi

# For non-scalar outputs, you must provide a gradient argument
x = torch.tensor([1.0, 2.0, 3.0], requires_grad=True)
y = x ** 2            # y is a vector, not a scalar

# y.backward()        # ERROR: grad can be implicitly created only for scalar outputs
y.backward(torch.ones_like(y))   # Equivalent to (y * ones).sum().backward()
print(x.grad)                     # tensor([2., 4., 6.])
```

</Code>

<Remark id="rmk-chain-rule">
**How backward() applies the chain rule.** For a computation $z = f(g(x))$, the chain rule gives $\frac{dz}{dx} = \frac{dz}{dg} \cdot \frac{dg}{dx}$. PyTorch implements this by having each `grad_fn` node compute the *local* Jacobian-vector product (JVP) and pass the result upstream:

```
Forward:   x  →  y = x*w  →  z = y.sum()
              grad_fn:         grad_fn:
              MulBackward0     SumBackward0

Backward:  dz/dx ← dz/dy * dy/dx ← dz/dz = 1
           = 1 * w = w     (for dz/dx)
           = 1 * x = x     (for dz/dw)
```

Each node receives the gradient from downstream ($\frac{dz}{dy}$, called `grad_output`) and computes the gradient to pass upstream ($\frac{dz}{dx}$) by multiplying with the local derivative ($\frac{dy}{dx}$).
</Remark>

## Gradient Accumulation

<Remark id="rmk-grad-accumulation-warning">
**Gradients accumulate by default.** This is the most common autograd bug for beginners. Calling `.backward()` *adds* to the existing `.grad` attribute rather than replacing it:

```python
x = torch.tensor([1.0], requires_grad=True)

y = (x ** 2).sum()
y.backward()
print(x.grad)  # tensor([2.])

y = (x ** 2).sum()
y.backward()
print(x.grad)  # tensor([4.])  -- ACCUMULATED! Not [2.]
```

**Why this design?** Accumulation enables gradient accumulation across mini-batches (see below) and is needed for models where a parameter is used multiple times in the forward pass (e.g., weight tying).
</Remark>

<Code id="code-autograd-zero-grad" caption="Always zero gradients before each backward pass.">

```python
# WRONG: gradients accumulate across iterations
for data, target in dataloader:
    loss = criterion(model(data), target)
    loss.backward()       # Gradients ADD to existing .grad
    optimizer.step()      # Update with accumulated (wrong) gradients

# CORRECT: zero gradients first
for data, target in dataloader:
    optimizer.zero_grad()  # Reset all .grad to zero (or None)
    loss = criterion(model(data), target)
    loss.backward()
    optimizer.step()

# EVEN BETTER: set_to_none=True (default in PyTorch 2.0+)
optimizer.zero_grad(set_to_none=True)
# Sets .grad to None instead of zero tensor -- saves memory and is slightly faster
```

</Code>

## Gradient Accumulation for Large Effective Batch Sizes

Simulate larger batch sizes by accumulating gradients over multiple mini-batches without increasing memory usage:

<Code id="code-grad-accumulation" caption="Gradient accumulation: effective batch = accumulation_steps * batch_size.">

```python
accumulation_steps = 4  # Effective batch = 4 * batch_size

for i, (data, target) in enumerate(dataloader):
    # Forward pass
    with torch.autocast(device_type='cuda', dtype=torch.bfloat16):
        output = model(data)
        loss = criterion(output, target)
        loss = loss / accumulation_steps  # Normalize loss to get correct average

    # Backward pass (gradients accumulate)
    loss.backward()

    # Update only every accumulation_steps
    if (i + 1) % accumulation_steps == 0:
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        optimizer.zero_grad()

# Memory usage: same as batch_size (not accumulation_steps * batch_size)
# Gradient quality: equivalent to the larger batch size
```

</Code>

<Remark id="rmk-grad-accum-vs-large-batch">
**Gradient accumulation is not perfectly equivalent to a large batch** in all cases:
- **Batch normalization** computes statistics over the mini-batch, not the accumulated batch. Use `SyncBatchNorm` or `GroupNorm` if this matters.
- **Dropout** applies a different mask per mini-batch, providing slightly different regularization.
- **Learning rate scheduling** that steps per iteration (not per effective batch) will behave differently.

For most workloads (especially with LayerNorm), these differences are negligible.
</Remark>

## torch.no_grad() and Inference Mode

Disable gradient tracking to save memory and speed up inference:

<Code id="code-no-grad" caption="Disabling gradient tracking for inference and evaluation.">

```python
# torch.no_grad(): disables gradient computation
with torch.no_grad():
    output = model(input)    # No grad_fn attached, no graph built
    output.requires_grad     # False

# torch.inference_mode(): even faster (also disables view tracking)
with torch.inference_mode():
    output = model(input)    # Cannot create views that require grad tracking

# As a decorator
@torch.inference_mode()
def predict(model, input):
    return model(input)

# Memory savings: significant
# Without no_grad: forward pass stores activations for backward (2-3x model memory)
# With no_grad: only the output tensor is allocated
```

</Code>

<Remark id="rmk-inference-mode">
**`inference_mode()` vs `no_grad()`: when to use which.**

| Feature | `no_grad()` | `inference_mode()` |
|---------|------------|-------------------|
| Disables gradient computation | Yes | Yes |
| Disables view tracking | No | Yes |
| Speed improvement | Moderate | Better |
| Can create tensors that later need gradients | Yes | No |
| Use case | Evaluation during training | Pure inference |

Use `inference_mode()` for deployment and pure inference. Use `no_grad()` during training evaluation where you might need to create tensors that interact with the training graph later.
</Remark>

## Detach, Retain Graph, and Stop Gradient

<Code id="code-detach" caption="Detaching tensors from the computation graph and retaining graphs.">

```python
# detach(): creates a tensor that shares data but has no grad_fn
x = torch.randn(3, requires_grad=True)
y = x * 2
z = y.detach()        # z has the same values as y, but no connection to x
z.requires_grad       # False
# Modifying z does NOT affect x's gradients

# Common use: target networks in RL / self-supervised learning
target = model(x).detach()  # Stop gradients from flowing through target

# retain_graph: keep the graph for multiple backward passes
x = torch.randn(3, requires_grad=True)
y = (x ** 2).sum()
y.backward(retain_graph=True)   # Graph is kept (not freed)
print(x.grad)                    # tensor([...])
y.backward()                     # Second backward (gradients accumulate!)
print(x.grad)                    # Previous grad + new grad

# Use case: computing multiple losses that share computation
shared = encoder(input)
loss_1 = criterion_1(head_1(shared))
loss_2 = criterion_2(head_2(shared))
loss_1.backward(retain_graph=True)  # Keep graph for loss_2
loss_2.backward()                    # Now graph is freed
```

</Code>

<Remark id="rmk-detach-patterns">
**Common patterns using detach():**

| Pattern | Code | Purpose |
|---------|------|---------|
| Stop gradient | `target = model(x).detach()` | Prevent gradient flow (EMA targets, contrastive learning) |
| Logging scalars | `losses.append(loss.detach().item())` | Avoid keeping computation graph in memory |
| Straight-through estimator | `y_hard = y_soft.detach() + (quantize(y_soft) - y_soft).detach()` | Discrete forward, continuous backward |
| Gradient penalty | `x_interp = (a*real + (1-a)*fake).detach().requires_grad_(True)` | Compute gradients w.r.t. interpolated input |
</Remark>

## Custom Autograd Functions

When you need to define custom forward and backward behavior -- for non-standard operations, memory-efficient backward passes, or interfacing with non-PyTorch code:

<Code id="code-custom-autograd" caption="Defining a custom autograd function with forward and backward.">

```python
class MySiLU(torch.autograd.Function):
    """SiLU (Swish) activation: x * sigmoid(x)."""

    @staticmethod
    def forward(ctx, x):
        sigmoid_x = torch.sigmoid(x)
        ctx.save_for_backward(x, sigmoid_x)  # Save for backward
        return x * sigmoid_x

    @staticmethod
    def backward(ctx, grad_output):
        x, sigmoid_x = ctx.saved_tensors
        # d/dx [x * sigmoid(x)] = sigmoid(x) + x * sigmoid(x) * (1 - sigmoid(x))
        #                        = sigmoid(x) * (1 + x * (1 - sigmoid(x)))
        grad_input = grad_output * (sigmoid_x * (1 + x * (1 - sigmoid_x)))
        return grad_input  # One output for each input to forward

# Usage (always use .apply, never call forward directly)
x = torch.randn(5, requires_grad=True)
y = MySiLU.apply(x)
y.sum().backward()
print(x.grad)

# Verify correctness with gradcheck
from torch.autograd import gradcheck
x = torch.randn(5, dtype=torch.float64, requires_grad=True)
assert gradcheck(MySiLU.apply, (x,), eps=1e-6)
```

</Code>

<Remark id="rmk-custom-autograd-tips">
**Tips for custom autograd functions:**

1. **Use `ctx.save_for_backward()`** -- not `ctx.x = x`. PyTorch manages memory efficiently for saved tensors, including releasing them after backward and supporting gradient checkpointing.

2. **Match the number of returns to forward inputs.** `backward()` must return one gradient for each input to `forward()`. Use `return None` for inputs that do not need gradients (e.g., integer arguments).

3. **Use `gradcheck()` to verify correctness.** It computes numerical gradients and compares them to your analytical backward. Always test with `float64` for numerical precision:
   ```python
   from torch.autograd import gradcheck
   x = torch.randn(5, dtype=torch.float64, requires_grad=True)
   assert gradcheck(MyFunction.apply, (x,), eps=1e-6, atol=1e-4)
   ```

4. **Memory-efficient backward:** If the forward pass produces large intermediate tensors, you can recompute them in the backward pass instead of saving them. This trades compute for memory:
   ```python
   @staticmethod
   def forward(ctx, x):
       ctx.save_for_backward(x)  # Save only input, not intermediates
       return expensive_computation(x)

   @staticmethod
   def backward(ctx, grad_output):
       x, = ctx.saved_tensors
       # Recompute intermediates from x (costs compute, saves memory)
       intermediate = expensive_computation_part1(x)
       return grad_output * gradient_formula(intermediate)
   ```
</Remark>

## Gradient Checkpointing

Trade compute for memory by recomputing activations during the backward pass instead of storing them:

<Code id="code-checkpointing" caption="Gradient checkpointing reduces memory at the cost of ~30% more compute.">

```python
from torch.utils.checkpoint import checkpoint

class DeepModel(nn.Module):
    def __init__(self, num_layers):
        super().__init__()
        self.layers = nn.ModuleList([
            TransformerBlock(d_model=1024) for _ in range(num_layers)
        ])

    def forward(self, x):
        for layer in self.layers:
            # Without checkpointing: stores activations for all layers
            # x = layer(x)

            # With checkpointing: only stores input; recomputes activations in backward
            x = checkpoint(layer, x, use_reentrant=False)
        return x

# Memory savings:
# Without checkpointing: O(L * activation_size) -- linear in depth
# With checkpointing:    O(sqrt(L) * activation_size) -- if checkpointed every sqrt(L) layers
# Compute cost:          ~30% more (one extra forward pass per checkpointed segment)
```

</Code>

<Remark id="rmk-checkpointing-when">
**When to use gradient checkpointing:**
- Your model is too deep to fit in GPU memory (e.g., 100+ layer Transformers)
- You want to increase batch size but are memory-limited
- The extra 30% compute cost is acceptable (usually is -- memory is the bottleneck)

Most large model training (GPT, LLaMA, etc.) uses gradient checkpointing. It is essentially free in wall-clock time because the memory savings allow larger batches, which improve GPU utilization.
</Remark>

## Autograd Debugging Checklist

<Table id="tab-autograd-debugging" caption="Common autograd errors and their fixes.">

| Error | Cause | Fix |
|-------|-------|-----|
| `grad can be implicitly created only for scalar outputs` | Calling `.backward()` on a non-scalar tensor | Pass `gradient=` argument, or reduce to scalar first |
| `Trying to backward through the graph a second time` | Graph freed after first `.backward()` | Use `retain_graph=True` (or restructure code) |
| `one of the variables needed for gradient computation has been modified by an inplace operation` | In-place operation on a tensor in the graph | Replace `x.add_(1)` with `x = x + 1` |
| `element 0 of tensors does not require grad and does not have a grad_fn` | No path from output to any `requires_grad=True` tensor | Check that model parameters have `requires_grad=True` |
| Gradients are all zero | Using `.detach()` or `.data` incorrectly | Check that no detach breaks the gradient path |
| Gradients are unexpectedly large | Not zeroing gradients between steps | Add `optimizer.zero_grad()` before backward |

</Table>
