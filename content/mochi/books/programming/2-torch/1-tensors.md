---
sidebar_position: 1
---

# Tensors

Tensors are the fundamental data structure of PyTorch and deep learning. A tensor is a multi-dimensional array, a generalization of scalars (0D), vectors (1D), matrices (2D), and higher-dimensional arrays (3D+). Every operation in a neural network, from storing weights to computing gradients, operates on tensors. Understanding tensor creation, memory layout, dtypes, and broadcasting is essential for writing correct and efficient PyTorch code.

## Creating Tensors

<Code id="code-create-tensors" caption="Creating tensors from data and factory functions.">

```python
import torch

# From Python data
x = torch.tensor([1.0, 2.0, 3.0])                    # 1D tensor from list
X = torch.tensor([[1, 2], [3, 4]], dtype=torch.float32) # 2D tensor with explicit dtype

# Factory functions (create tensors with specific patterns)
zeros = torch.zeros(3, 4)                # All zeros, shape (3, 4)
ones = torch.ones(3, 4)                  # All ones, shape (3, 4)
rand = torch.randn(3, 4)                 # Standard normal N(0,1)
rand_uniform = torch.rand(3, 4)          # Uniform [0, 1)
arange = torch.arange(0, 10, 2)          # [0, 2, 4, 6, 8]
linspace = torch.linspace(0, 1, 5)       # [0.0, 0.25, 0.5, 0.75, 1.0]
eye = torch.eye(3)                        # 3x3 identity matrix
empty = torch.empty(3, 4)                # Uninitialized (fast, but contains garbage)

# "Like" functions: match dtype, device, and layout of an existing tensor
x_like = torch.zeros_like(X)             # Same shape, dtype, device as X
x_new = X.new_zeros(5, 5)                # Same dtype and device, different shape
x_rand = torch.randn_like(X)             # Same shape, random values

# From NumPy (shares memory, zero-copy)
import numpy as np
np_array = np.array([1.0, 2.0, 3.0])
t = torch.from_numpy(np_array)           # Shares memory with np_array
np_back = t.numpy()                       # Back to NumPy (only works on CPU tensors)
```

</Code>

<Remark id="rmk-tensor-initialization">
**Initialization matters for training.** The factory function you choose for weight initialization directly affects training dynamics:

| Function | Distribution | When to Use |
|----------|-------------|-------------|
| `torch.randn(...)` | $\mathcal{N}(0, 1)$ | Starting point; scale by desired std |
| `torch.empty(...).uniform_(-a, a)` | $\text{Uniform}(-a, a)$ | Kaiming uniform (default for `nn.Linear`) |
| `nn.init.kaiming_normal_(w)` | $\mathcal{N}(0, \sqrt{2/\text{fan\_in}})$ | ReLU layers |
| `nn.init.xavier_normal_(w)` | $\mathcal{N}(0, \sqrt{2/(\text{fan\_in} + \text{fan\_out})})$ | Sigmoid/Tanh layers |
| `torch.zeros(...)` | Constant 0 | Biases, residual branch output |

Using `torch.empty()` is fastest (no initialization), but the tensor contains whatever was previously in that memory, so always initialize before use.
</Remark>

## Data Types (dtypes)

<Table id="tab-torch-dtypes" caption="PyTorch data types: precision, memory, and usage.">

| Dtype | Bits | Significand | Exponent | Range | Use Case |
|-------|------|-------------|----------|-------|----------|
| `torch.float32` (float) | 32 | 23 bits (~7 digits) | 8 bits | $\pm 3.4 \times 10^{38}$ | Default for training; master weights |
| `torch.float16` (half) | 16 | 10 bits (~3.3 digits) | 5 bits | $\pm 6.5 \times 10^{4}$ | Mixed precision (requires loss scaling) |
| `torch.bfloat16` | 16 | 7 bits (~2.4 digits) | 8 bits | $\pm 3.4 \times 10^{38}$ | Preferred for LLM training (no scaling needed) |
| `torch.float64` (double) | 64 | 52 bits (~15 digits) | 11 bits | $\pm 1.8 \times 10^{308}$ | Numerical testing, scientific computing |
| `torch.float8_e4m3fn` | 8 | 3 bits | 4 bits | $\pm 448$ | H100 inference/training (FP8) |
| `torch.float8_e5m2` | 8 | 2 bits | 5 bits | $\pm 57344$ | FP8 gradients (wider range) |
| `torch.int64` (long) | 64 | n/a | n/a | $\pm 9.2 \times 10^{18}$ | Indices, token IDs, labels |
| `torch.int32` (int) | 32 | n/a | n/a | $\pm 2.1 \times 10^{9}$ | Indices (when int64 is wasteful) |
| `torch.int8` | 8 | n/a | n/a | $-128$ to $127$ | Quantized inference |
| `torch.bool` | 8 | n/a | n/a | True/False | Attention masks, conditions |

</Table>

<Code id="code-dtype-conversion" caption="Converting between data types and understanding the tradeoffs.">

```python
x = torch.randn(3, 3)               # Default: float32

# Convert dtype (creates a copy with the new type)
x_half = x.half()                    # float32 -> float16
x_bf16 = x.bfloat16()               # float32 -> bfloat16
x_back = x_half.float()             # float16 -> float32 (does NOT recover lost precision)

# In-place dtype specification at creation
x = torch.randn(3, 3, dtype=torch.bfloat16)  # Created directly in bfloat16

# Mixed precision: autocast handles conversions automatically
with torch.autocast(device_type='cuda', dtype=torch.bfloat16):
    # GEMMs run in bfloat16 (Tensor Cores), reductions in float32
    output = model(input)
```

</Code>

<Remark id="rmk-bf16-vs-fp16">
**BF16 vs FP16: why BF16 is almost always better for training.**

| Property | FP16 | BF16 |
|----------|------|------|
| Precision | ~3.3 decimal digits | ~2.4 decimal digits |
| Dynamic range | $\pm 65504$ | $\pm 3.4 \times 10^{38}$ (same as FP32) |
| Overflow risk | High (gradients > 65504 overflow to Inf) | Essentially none |
| Requires loss scaling | Yes (GradScaler) | No |
| Tensor Core support | All Tensor Core GPUs | Ampere (A100) and newer |

BF16 trades precision for range. Since training gradients can span many orders of magnitude, the wider range of BF16 avoids the gradient overflow problem that makes FP16 training fragile. The slight precision loss (~1 decimal digit) rarely affects convergence.

**Rule of thumb:** Use BF16 on Ampere+ GPUs. Use FP16 with GradScaler only on V100 (which lacks BF16 Tensor Cores).
</Remark>

## Device Placement

<Code id="code-device-placement" caption="Moving tensors between CPU and GPU devices.">

```python
# Create directly on GPU (preferred: avoids CPU -> GPU copy)
x = torch.randn(3, 3, device='cuda')          # Default GPU (cuda:0)
x = torch.randn(3, 3, device='cuda:1')        # Specific GPU

# Move existing tensor to GPU (copies data)
x_cpu = torch.randn(3, 3)
x_gpu = x_cpu.cuda()                          # .cuda() method
x_gpu = x_cpu.to('cuda:0')                    # .to() method (more flexible)

# Move back to CPU
x_cpu = x_gpu.cpu()

# Check device
print(x_gpu.device)   # cuda:0
print(x_gpu.is_cuda)  # True

# Device-agnostic code pattern
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
x = torch.randn(3, 3, device=device)
model = model.to(device)
```

</Code>

<Remark id="rmk-device-mismatch">
**Device mismatches are the second most common PyTorch error** (after shape mismatches). All tensors in an operation must be on the same device:

```python
# This raises RuntimeError: Expected all tensors to be on the same device
cpu_tensor = torch.randn(3)
gpu_tensor = torch.randn(3, device='cuda')
result = cpu_tensor + gpu_tensor  # ERROR

# Fix: move to the same device
result = cpu_tensor.to(gpu_tensor.device) + gpu_tensor
```

When debugging device errors, check `.device` on all tensors involved in the operation.
</Remark>

<Remark id="rmk-pinned-memory">
**Pinned (page-locked) memory for faster CPU-to-GPU transfers.** Normal CPU memory can be paged out to disk by the OS. GPU DMA engines cannot access paged-out memory, so CUDA must first copy data to a pinned (non-pageable) staging buffer, then DMA to the GPU, a double copy.

```python
# Allocate pinned memory (stays in physical RAM, faster GPU transfers)
x = torch.randn(1024, 1024, pin_memory=True)
x_gpu = x.cuda(non_blocking=True)  # Async copy, overlaps with compute

# DataLoader with pinned memory (the most common use)
loader = DataLoader(dataset, batch_size=32, pin_memory=True, num_workers=4)
for batch in loader:
    batch = batch.cuda(non_blocking=True)  # Overlaps with next batch loading
```

`pin_memory=True` in DataLoader + `.cuda(non_blocking=True)` is the standard pattern for overlapping data loading with GPU computation. The speedup is typically 10-30%.
</Remark>

## Memory Layout: Strides and Contiguity

Under the hood, every tensor is a view into a contiguous block of memory (the **storage**). The tensor's shape, strides, and offset determine which elements of the storage it accesses:

<Code id="code-strides" caption="How strides define memory layout and enable zero-copy views.">

```python
x = torch.tensor([[1, 2, 3],
                   [4, 5, 6]])

print(x.shape)           # torch.Size([2, 3])
print(x.stride())        # (3, 1): row 0 to row 1 jumps 3 elements; col to col jumps 1
print(x.storage_offset()) # 0
print(x.is_contiguous())  # True

# Memory layout (row-major / C-order):
# Storage: [1, 2, 3, 4, 5, 6]
#           ^        ^
#           row 0    row 1

# Transpose changes strides, NOT data
y = x.T
print(y.shape)           # torch.Size([3, 2])
print(y.stride())        # (1, 3): strides are swapped
print(y.is_contiguous())  # False (stride[0] < stride[1])
# y still points to the SAME storage: [1, 2, 3, 4, 5, 6]
# But y[0] = [1, 4] (stride 3), y[1] = [2, 5] (stride 3)

# Slicing creates a view with offset and modified strides
z = x[:, 1:]             # Columns 1 and 2
print(z.stride())        # (3, 1): inherited from x, not the (2, 1) a fresh (2, 2) tensor would have
print(z.storage_offset()) # 1: starts at element 1 in storage
print(z.is_contiguous())  # False (contiguous (2, 2) needs stride (2, 1); stride[i] must equal the product of sizes after dim i)
```

</Code>

## Views vs Copies

A **view** shares memory with the original tensor: modifying one modifies the other. A **copy** allocates new memory.

<Code id="code-views-copies" caption="View operations (shared memory) vs copy operations (new memory).">

```python
x = torch.randn(4, 4)

# VIEW operations (no data copy, shared memory)
y = x.view(2, 8)          # Reshape (requires contiguous input)
y = x.reshape(2, 8)       # Reshape (returns view if possible, copies if not)
y = x[0:2]                # Slice
y = x.T                   # Transpose
y = x.unsqueeze(0)        # Add dimension: (4,4) -> (1,4,4)
y = x.squeeze()           # Remove size-1 dimensions
y = x.expand(3, 4, 4)     # Broadcast to larger size (no copy)
y = x.permute(1, 0)       # Reorder dimensions

# COPY operations (allocate new memory)
y = x.clone()             # Explicit copy (preserves grad_fn)
y = x.detach().clone()    # Copy without autograd history
y = x.to(torch.float16)   # Dtype conversion always copies
y = x.to('cuda')          # Device transfer always copies

# MAY-COPY operation (copies only when needed)
y = x.contiguous()        # Copies if non-contiguous; no-op (returns self) if already contiguous
```

</Code>

<Example id="ex-view-shared-memory">

```python
# Demonstrate that views share memory
x = torch.randn(4, 4)
y = x.view(2, 8)
y[0, 0] = 999.0
print(x[0, 0])  # 999.0: y is a view, so modifying y modifies x

# This is a feature, not a bug: views are essential for memory efficiency.
# But it can cause subtle bugs if you modify a view unexpectedly.

# Safe pattern: clone if you need independence
y = x.view(2, 8).clone()
y[0, 0] = 999.0
print(x[0, 0])  # Not 999: y is an independent copy
```

</Example>

<Example id="ex-stride-index-walkthrough">

This example traces how shape, stride, and offset map a logical index to a physical storage location. The address formula is `offset + sum(index[i] * stride[i])`. The first lookup is fully worked; fill in the reasoning for the rest.

```python
x = torch.arange(6).reshape(2, 3)
# Storage: [0, 1, 2, 3, 4, 5], shape (2, 3), stride (3, 1), offset 0

# Worked: x[1, 2] lives at offset + 1*stride[0] + 2*stride[1]
#       = 0 + 1*3 + 2*1 = 5  -> storage[5] = 5
print(x[1, 2])            # 5

y = x.T
# y has shape (3, 2), stride (1, 3), offset 0 (same storage)
# Your turn: y[2, 0] lives at 0 + 2*stride[0] + 0*stride[1]
#          = 0 + 2*1 + 0*3 = 2  -> storage[2] = 2
print(y[2, 0])            # 2

z = x[:, 1:]
# z has shape (2, 2), stride (3, 1), offset 1
# Your turn: z[1, 1] lives at 1 + 1*stride[0] + 1*stride[1]
#          = 1 + 1*3 + 1*1 = 5  -> storage[5] = 5
print(z[1, 1])            # 5

# Why z is non-contiguous: a fresh contiguous (2, 2) needs stride (2, 1),
# but z inherited stride (3, 1) from x, so its rows skip a storage slot.
print(z.is_contiguous())  # False
```

</Example>

<Remark id="rmk-view-vs-reshape">
**`view()` vs `reshape()` vs `contiguous().view()`.** Use this decision tree:
- **`view()`**: when you know the tensor is contiguous. Fails with a RuntimeError if not.
- **`reshape()`**: when you are not sure about contiguity. Returns a view if possible, a copy otherwise. Safer but hides potential copies.
- **`contiguous().view()`**: when you want to be explicit, that is, "make it contiguous first (copy if needed), then view." Clearest intent.

In practice, `reshape()` is the safest default. Use `view()` when you want the error if the tensor is unexpectedly non-contiguous (a sign of a bug).
</Remark>

## Broadcasting

Broadcasting automatically expands tensor dimensions to make shapes compatible for elementwise operations. It is the mechanism behind seemingly impossible operations like adding a vector to a matrix:

<Code id="code-broadcasting" caption="Broadcasting rules and common patterns.">

```python
# Broadcasting rules (applied right-to-left):
# 1. Align shapes from the right
# 2. For each dimension: sizes must be equal, OR one of them must be 1
# 3. Size-1 dimensions are "stretched" to match the other tensor

# Example: adding a bias vector to a batch of features
features = torch.randn(32, 10)   # Shape: (32, 10), 32 samples, 10 features
bias = torch.randn(10)           # Shape: (10,) -> broadcasted to (1, 10) -> (32, 10)
result = features + bias          # Shape: (32, 10), bias added to each sample

# Example: batch outer product
a = torch.randn(32, 5, 1)       # (32, 5, 1)
b = torch.randn(32, 1, 7)       # (32, 1, 7)
outer = a * b                    # (32, 5, 7): outer product per batch element

# Example: attention mask broadcasting
# Q*K^T:   (B, H, T, T)         B=batch, H=heads, T=sequence length
# Mask:    (B, 1, 1, T)         broadcasts across H and query positions
scores = torch.randn(4, 8, 64, 64)   # (B, H, T, T)
mask = torch.ones(4, 1, 1, 64)       # (B, 1, 1, T): broadcasts
masked_scores = scores + mask          # (4, 8, 64, 64)

# Common broadcasting shapes in ML:
# (B, T, D) + (D,)        -> per-feature bias
# (B, T, D) * (B, T, 1)   -> per-position scaling (gating)
# (B, H, T, T) + (1, 1, T, T) -> position-independent attention bias
```

</Code>

<Remark id="rmk-broadcasting-safety">
**Broadcasting can silently produce wrong results.** This is one of the most insidious bugs in ML code:

```python
# Intended: subtract a per-sample target from a per-sample prediction, element-wise
pred = torch.randn(32, 1)     # (32, 1): one prediction per sample, kept as a column
target = torch.randn(32)      # (32,): one target per sample

# This does NOT error! Right-aligned, (32, 1) and (32,) align as (32, 1) vs (1, 32),
# so broadcasting silently expands both to (32, 32) instead of (32, 1).
loss = (pred - target.unsqueeze(1)) ** 2  # Correct: target -> (32, 1), result is (32, 1)
loss = (pred - target) ** 2               # WRONG: silently broadcasts to (32, 32)!
```

**Defense:** Always assert shapes at module boundaries:
```python
assert logits.shape == (batch_size, num_classes), f"Got {logits.shape}"
```
</Remark>

## Essential Tensor Operations

<Table id="tab-tensor-ops" caption="Essential tensor operations organized by category.">

| Category | Operations | Notes |
|----------|-----------|-------|
| Arithmetic | `+`, `-`, `*`, `/`, `**`, `@` (matmul) | Elementwise except `@` |
| Reduction | `sum`, `mean`, `max`, `min`, `prod`, `norm` | Specify `dim` to reduce along an axis |
| Comparison | `==`, `!=`, `>`, `<`, `ge`, `le` | Returns bool tensor |
| Indexing | `[]`, `index_select`, `gather`, `scatter_` | `gather`/`scatter_` for advanced indexing |
| Shape | `view`, `reshape`, `permute`, `transpose`, `squeeze`, `unsqueeze`, `expand` | Views when possible |
| Concatenation | `cat` (along existing dim), `stack` (new dim) | `cat` does not add a dimension |
| Linear algebra | `matmul`, `mm`, `bmm`, `svd`, `eig`, `solve` | `bmm` for batched matmul |
| In-place | `add_`, `mul_`, `zero_`, `fill_`, `copy_` | Trailing `_` = in-place; avoid with autograd |

</Table>

<Remark id="rmk-inplace-ops">
**In-place operations and autograd.** Operations with a trailing underscore (`add_`, `mul_`, etc.) modify the tensor in-place. While they save memory, they can break autograd:

```python
x = torch.randn(3, requires_grad=True)
y = x * 2
y.add_(1)        # In-place modification of y
y.backward()     # May raise error: "one of the variables needed for gradient
                 #   computation has been modified by an inplace operation"
```

**Rule:** Avoid in-place operations on tensors that require gradients or are inputs to other operations in the computation graph. In-place ops are safe on tensors you create for temporary computation (e.g., modifying a buffer).
</Remark>
