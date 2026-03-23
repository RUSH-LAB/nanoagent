---
sidebar_position: 2
---

# Autograd

## Computational Graphs

PyTorch builds a **dynamic computational graph** during the forward pass. Each tensor operation creates a node, and edges track dependencies. The graph is used to compute gradients via backpropagation.

<Code id="code-autograd-1" caption="PyTorch builds a dynamic computational graph during the forward pass.">

```python
import torch

x = torch.randn(3, requires_grad=True)  # Leaf tensor, tracked
y = x * 2                                # Non-leaf, has grad_fn
z = y.sum()                              # Scalar output

print(y.grad_fn)   # <MulBackward0>
print(z.grad_fn)   # <SumBackward0>
```

</Code>

## backward() and Gradient Computation

<Code id="code-autograd-2" caption="Code example.">

```python
x = torch.tensor([1.0, 2.0, 3.0], requires_grad=True)
y = (x ** 2).sum()   # y = x1^2 + x2^2 + x3^2

y.backward()          # Compute dy/dx
print(x.grad)         # tensor([2., 4., 6.])  (dy/dxi = 2*xi)
```

</Code>

<Remark id="rmk-autograd-1">
**Warning:** Gradients accumulate by default. Always zero them before each backward pass:
</Remark>

<Code id="code-autograd-3" caption="Warning: Gradients accumulate by default.">

```python
# Wrong: gradients accumulate across iterations
for data in dataloader:
    loss = model(data)
    loss.backward()       # Gradients ADD to existing .grad

# Correct: zero gradients first
for data in dataloader:
    optimizer.zero_grad()  # Reset all .grad to zero
    loss = model(data)
    loss.backward()
    optimizer.step()
```

</Code>

## torch.no_grad() and Inference

Disable gradient tracking to save memory and speed up inference:

<Code id="code-autograd-4" caption="Disable gradient tracking to save memory and speed up inference.">

```python
# Context manager (preferred)
with torch.no_grad():
    output = model(input)

# Decorator
@torch.no_grad()
def predict(model, input):
    return model(input)

# inference_mode is even faster (also disables view tracking)
with torch.inference_mode():
    output = model(input)
```

</Code>

<Remark id="rmk-autograd-2">
**Tip:** Use `torch.inference_mode()` over `torch.no_grad()` for inference. It is faster because it also disables autograd metadata tracking for views.
</Remark>

## Gradient Accumulation

Simulate larger batch sizes by accumulating gradients over multiple mini-batches:

<Code id="code-autograd-5" caption="Simulate larger batch sizes by accumulating gradients over multiple mini-batches.">

```python
accumulation_steps = 4

for i, (data, target) in enumerate(dataloader):
    loss = model(data, target)
    loss = loss / accumulation_steps  # Normalize loss
    loss.backward()                   # Accumulate gradients

    if (i + 1) % accumulation_steps == 0:
        optimizer.step()              # Update weights
        optimizer.zero_grad()         # Reset gradients
```

</Code>

This is equivalent to a batch size of `accumulation_steps * batch_size` but uses only `batch_size` memory.

## Detach and Retain Graph

<Code id="code-autograd-6" caption="Code example.">

```python
# detach(): creates a new tensor detached from the graph
x = torch.randn(3, requires_grad=True)
y = x * 2
z = y.detach()   # z has the same values but no grad_fn
z.requires_grad  # False

# retain_graph: keep the graph for multiple backward passes
y = (x ** 2).sum()
y.backward(retain_graph=True)  # Graph is kept
y.backward()                    # Second backward pass (gradients accumulate)
```

</Code>

## Custom Autograd Functions

Define custom forward and backward passes:

<Code id="code-autograd-7" caption="Define custom forward and backward passes.">

```python
class MySiLU(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        sigmoid_x = torch.sigmoid(x)
        ctx.save_for_backward(x, sigmoid_x)
        return x * sigmoid_x

    @staticmethod
    def backward(ctx, grad_output):
        x, sigmoid_x = ctx.saved_tensors
        # d/dx [x * sigmoid(x)] = sigmoid(x) + x * sigmoid(x) * (1 - sigmoid(x))
        grad_input = grad_output * (sigmoid_x + x * sigmoid_x * (1 - sigmoid_x))
        return grad_input

# Usage
x = torch.randn(5, requires_grad=True)
y = MySiLU.apply(x)
y.sum().backward()
```

</Code>

<Remark id="rmk-autograd-3">
**Tip:** Use `ctx.save_for_backward()` instead of storing tensors as attributes. PyTorch manages memory efficiently for saved tensors, including releasing them after backward.
</Remark>
