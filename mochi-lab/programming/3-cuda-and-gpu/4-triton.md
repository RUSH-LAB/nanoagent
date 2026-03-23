---
sidebar_position: 4
---

# Triton

Triton is a GPU programming language and compiler (developed at OpenAI, now part of the PyTorch ecosystem) that bridges the gap between high-level Python and low-level CUDA. Where CUDA requires you to think about individual threads, shared memory allocation, and synchronization, Triton lets you write kernels at the **block level** -- you operate on tiles of data, and the compiler handles thread mapping, shared memory management, and coalescing automatically.

## Why Triton?

CUDA gives maximum control but requires managing threads, shared memory, and synchronization manually. Triton provides a higher-level abstraction that generates kernels with 80-95% of the performance of hand-written CUDA, with 5-10x less code.

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

<Table id="tab-triton-2" caption="Triton vs CUDA: when to use each.">

| Scenario | Recommendation | Why |
|----------|---------------|-----|
| Fuse elementwise + reduction ops | Triton | Fast iteration, automatic optimization |
| Custom attention variants | Triton | Complex but regular structure; Triton handles tiling |
| Quantized GEMM (INT8, FP8) | Triton | Good Tensor Core support via `tl.dot` |
| Activation functions | Triton | Simple, memory-bound, perfect for fusion |
| Need warp-level primitives (`__shfl`) | CUDA | Triton does not expose warp-level control |
| Need inline PTX assembly | CUDA | Hardware-specific instructions |
| Rapid prototyping of custom kernels | Triton | 5-10x faster development |
| Maximum performance on well-studied problem | CUDA | Handcrafted can beat Triton's compiler |
| Integration with torch.compile | Triton | TorchInductor generates Triton directly |

</Table>

<Remark id="rmk-triton-performance">
**Triton performance compared to CUDA.**

| Kernel Type | Triton vs cuBLAS/CUTLASS | Triton vs Naive CUDA | Development Time |
|-------------|------------------------|---------------------|-----------------|
| Vector add | ~100% of peak | 1x (same) | 10 min vs 30 min |
| Fused softmax | 90-95% of custom CUDA | 2-3x faster | 30 min vs 2 hours |
| GEMM (FP16) | 80-90% of cuBLAS | 5-10x faster | 2 hours vs 2 days |
| FlashAttention-style | 70-85% of hand-tuned CUDA | N/A | 1 day vs 1 week |

For most ML researchers, Triton's development speed advantage outweighs the small performance gap. The gap is closing as the Triton compiler improves.
</Remark>

## Triton and torch.compile

`torch.compile` (TorchInductor) generates Triton kernels automatically for fused operations. Understanding Triton helps you:

1. **Read generated kernels** to understand what torch.compile produces
2. **Write custom kernels** when torch.compile's fusion is insufficient
3. **Debug performance** by inspecting the generated Triton code

<Code id="code-triton-inspect" caption="Inspecting Triton kernels generated by torch.compile.">

```python
# See the generated Triton code
import torch._dynamo
torch._dynamo.config.output_code = True

@torch.compile
def my_function(x):
    return x * torch.sigmoid(x)  # SiLU

# First call triggers compilation and prints generated Triton kernel
y = my_function(torch.randn(1024, device='cuda'))

# Or inspect with TORCH_COMPILE_DEBUG=1
# TORCH_COMPILE_DEBUG=1 python my_script.py
# Creates a debug directory with generated code, IR, and optimization passes
```

</Code>
