---
sidebar_position: 1
---

# Tensors

## Creating Tensors

```python
import torch

# From data
x = torch.tensor([1.0, 2.0, 3.0])
X = torch.tensor([[1, 2], [3, 4]], dtype=torch.float32)

# Factory functions
zeros = torch.zeros(3, 4)
ones = torch.ones(3, 4)
rand = torch.randn(3, 4)          # Normal distribution
arange = torch.arange(0, 10, 2)   # [0, 2, 4, 6, 8]
eye = torch.eye(3)                 # 3x3 identity

# Like existing tensor (same dtype/device)
x_like = torch.zeros_like(X)
x_new = X.new_zeros(5, 5)
```

## Dtypes

| Dtype | Bits | Range | Use case |
|-------|------|-------|----------|
| `torch.float32` | 32 | ~7 digits | Default for training |
| `torch.float16` | 16 | ~3 digits | Mixed precision |
| `torch.bfloat16` | 16 | ~2 digits | Preferred for LLM training |
| `torch.float64` | 64 | ~15 digits | Numerical testing |
| `torch.int64` | 64 | $\pm 9.2 \times 10^{18}$ | Indices, labels |
| `torch.bool` | 8 | True/False | Masks |

```python
# Convert dtype
x = torch.randn(3, 3)
x_half = x.half()        # float32 -> float16
x_bf16 = x.bfloat16()    # float32 -> bfloat16
x_back = x_half.float()  # float16 -> float32
```

**Tip:** Always use `.bfloat16()` over `.half()` for training. BF16 has the same exponent range as FP32, so it rarely overflows.

## Device Placement

```python
# Move to GPU
x = torch.randn(3, 3, device='cuda')       # Create on GPU
x = torch.randn(3, 3).cuda()               # Create on CPU, move to GPU
x = torch.randn(3, 3).to('cuda:0')         # Explicit GPU index

# Check device
print(x.device)  # cuda:0

# Move back to CPU
x_cpu = x.cpu()

# Device-agnostic code
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
x = torch.randn(3, 3, device=device)
```

**Warning:** All tensors in an operation must be on the same device. `cpu_tensor + cuda_tensor` raises a RuntimeError.

## Views vs Copies

A **view** shares memory with the original tensor. A **copy** allocates new memory:

```python
x = torch.randn(4, 4)

# Views (no copy, shared memory)
y = x.view(2, 8)        # Reshape (contiguous only)
y = x.reshape(2, 8)     # Reshape (may copy if non-contiguous)
y = x[0:2]              # Slice
y = x.T                  # Transpose
y = x.unsqueeze(0)      # Add dimension

# Copies (new memory)
y = x.clone()           # Explicit copy
y = x.contiguous()      # Copy only if non-contiguous
```

```python
# Check if tensors share memory
x = torch.randn(4, 4)
y = x.view(2, 8)
y[0, 0] = 999
print(x[0, 0])  # 999 -- y is a view!
```

**Tip:** Use `.view()` when you know the tensor is contiguous. Use `.reshape()` when you are not sure -- it returns a view when possible and a copy otherwise.

## Broadcasting

PyTorch automatically expands dimensions to make shapes compatible:

```python
# Rules: align from the right, dimensions must be equal or one of them is 1
x = torch.randn(3, 4)    # Shape: (3, 4)
y = torch.randn(1, 4)    # Shape: (1, 4) -> broadcasts to (3, 4)
z = x + y                # Shape: (3, 4)

# Adding a bias vector
W = torch.randn(10, 5)   # Weight matrix
b = torch.randn(5)       # Bias vector, shape (5,) -> (1, 5) -> (10, 5)
out = W + b              # Shape: (10, 5)
```

Common broadcasting patterns:

```python
# Batch matrix operations
batch = torch.randn(32, 10, 5)    # (B, M, N)
vector = torch.randn(5)           # (N,) -> (1, 1, N)
result = batch * vector            # (32, 10, 5)

# Outer product via broadcasting
a = torch.randn(3, 1)
b = torch.randn(1, 4)
outer = a * b                      # (3, 4)
```

**Warning:** Broadcasting can silently create incorrect results when shapes are accidentally compatible. Always verify shapes with assertions:

```python
assert x.shape == (batch_size, seq_len, d_model), f"Expected shape {(batch_size, seq_len, d_model)}, got {x.shape}"
```
