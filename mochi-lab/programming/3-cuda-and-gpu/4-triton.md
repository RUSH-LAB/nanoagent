---
sidebar_position: 4
---

# Triton

## Why Triton?

CUDA gives maximum control but requires managing threads, shared memory, and synchronization manually. **Triton** (by OpenAI) provides a higher-level abstraction: you write kernels at the **block level** instead of the thread level.

<Code id="code-triton-1" caption="CUDA gives maximum control but requires managing threads, shared memory, and.">

```python
import triton
import triton.language as tl
import torch

@triton.jit
def add_kernel(x_ptr, y_ptr, out_ptr, n,
               BLOCK_SIZE: tl.constexpr):
    # Each program instance processes one block of data
    pid = tl.program_id(0)
    offsets = pid * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE)
    mask = offsets < n

    x = tl.load(x_ptr + offsets, mask=mask)
    y = tl.load(y_ptr + offsets, mask=mask)
    tl.store(out_ptr + offsets, x + y, mask=mask)

# Launch
n = 1024
x = torch.randn(n, device='cuda')
y = torch.randn(n, device='cuda')
out = torch.empty(n, device='cuda')

grid = (triton.cdiv(n, 256),)  # Ceiling division
add_kernel[grid](x, y, out, n, BLOCK_SIZE=256)
```

</Code>

## Key Concepts

<Table id="tab-triton-1" caption="## Key Concepts.">

| CUDA | Triton | Description |
|------|--------|-------------|
| Thread | (implicit) | Individual execution unit |
| Block | Program instance | Unit of work with `program_id` |
| Grid | Grid | Total number of program instances |
| Shared memory | (automatic) | Triton manages shared memory for you |
| `__syncthreads()` | (automatic) | Synchronization is implicit |

</Table>

<Remark id="rmk-triton-1">
**Tip:** In Triton, you think in terms of blocks of data, not individual threads. Triton's compiler handles the mapping to threads, shared memory, and synchronization.
</Remark>

## Fused Softmax

A practical example that demonstrates the power of fusion:

<Code id="code-triton-2" caption="A practical example that demonstrates the power of fusion.">

```python
@triton.jit
def softmax_kernel(input_ptr, output_ptr, n_cols,
                   BLOCK_SIZE: tl.constexpr):
    row = tl.program_id(0)
    offsets = tl.arange(0, BLOCK_SIZE)
    mask = offsets < n_cols

    # Load row
    row_start = input_ptr + row * n_cols
    x = tl.load(row_start + offsets, mask=mask, other=-float('inf'))

    # Numerically stable softmax
    x_max = tl.max(x, axis=0)
    x = x - x_max
    exp_x = tl.exp(x)
    sum_exp = tl.sum(exp_x, axis=0)
    softmax = exp_x / sum_exp

    # Store
    out_start = output_ptr + row * n_cols
    tl.store(out_start + offsets, softmax, mask=mask)

def fused_softmax(x):
    n_rows, n_cols = x.shape
    BLOCK_SIZE = triton.next_power_of_2(n_cols)
    out = torch.empty_like(x)
    softmax_kernel[(n_rows,)](x, out, n_cols, BLOCK_SIZE=BLOCK_SIZE)
    return out
```

</Code>

This fused kernel performs max, subtract, exp, sum, and divide in a single pass over the data, compared to 5 separate PyTorch kernel launches.

## Auto-tuning

Triton supports automatic tuning of kernel parameters:

<Code id="code-triton-3" caption="Triton supports automatic tuning of kernel parameters.">

```python
@triton.autotune(
    configs=[
        triton.Config({'BLOCK_M': 64, 'BLOCK_N': 64, 'BLOCK_K': 32}),
        triton.Config({'BLOCK_M': 128, 'BLOCK_N': 64, 'BLOCK_K': 32}),
        triton.Config({'BLOCK_M': 64, 'BLOCK_N': 128, 'BLOCK_K': 32}),
    ],
    key=['M', 'N', 'K'],  # Re-tune when these change
)
@triton.jit
def matmul_kernel(a_ptr, b_ptr, c_ptr, M, N, K,
                  BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr,
                  BLOCK_K: tl.constexpr):
    ...
```

</Code>

<Remark id="rmk-triton-2">
**Tip:** Start with a working kernel, then add `@triton.autotune` to find the best block sizes. Triton will benchmark each configuration and cache the winner.
</Remark>

## When to Use Triton vs CUDA

<Table id="tab-triton-2" caption="## When to Use Triton vs CUDA.">

| Scenario | Recommendation |
|----------|---------------|
| Fuse elementwise + reduction ops | Triton |
| Custom attention kernels | Triton (or FlashAttention) |
| Need warp-level primitives | CUDA |
| Need inline PTX assembly | CUDA |
| Rapid prototyping | Triton |
| Maximum performance on known problem | CUDA |

</Table>
