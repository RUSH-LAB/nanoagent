---
sidebar_position: 4
---

# Triton

Triton is a GPU programming language and compiler (developed at OpenAI, now part of the PyTorch ecosystem) that bridges the gap between high-level Python and low-level CUDA. Where CUDA requires you to think about individual threads, shared memory allocation, and synchronization, Triton lets you write kernels at the **block level** -- you operate on tiles of data, and the compiler handles thread mapping, shared memory management, and coalescing automatically.

## Why Triton?

CUDA gives maximum control but requires managing threads, shared memory, and synchronization manually. Triton provides a higher-level abstraction that generates kernels with 80-95% of the performance of hand-written CUDA, with 5-10x less code.

<Code id="code-triton-1" caption="Triton vector addition: block-level programming with automatic thread management.">

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

<Table id="tab-triton-1" caption="Triton vs CUDA abstraction mapping.">

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

<Code id="code-triton-2" caption="Fused softmax in Triton: max, subtract, exp, sum, and divide in a single pass.">

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

## Matrix Multiplication

Matrix multiplication is the most important GPU kernel -- it dominates the compute in every neural network. A complete Triton matmul kernel demonstrates tiling, accumulation, and how Triton maps to Tensor Cores via `tl.dot`:

<Code id="code-triton-matmul" caption="Complete Triton matrix multiplication kernel with tiling and Tensor Core support.">

```python
@triton.jit
def matmul_kernel(
    a_ptr, b_ptr, c_ptr,
    M, N, K,
    stride_am, stride_ak,   # A is (M, K): stride_am = K, stride_ak = 1
    stride_bk, stride_bn,   # B is (K, N): stride_bk = N, stride_bn = 1
    stride_cm, stride_cn,   # C is (M, N): stride_cm = N, stride_cn = 1
    BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr,
):
    """Compute C = A @ B with tiled accumulation.

    Each program instance computes one BLOCK_M x BLOCK_N tile of C
    by iterating over K in chunks of BLOCK_K.
    """
    # Which tile of C this program instance computes
    pid_m = tl.program_id(0)
    pid_n = tl.program_id(1)

    # Pointers to the first BLOCK_M x BLOCK_K tile of A and BLOCK_K x BLOCK_N tile of B
    offs_m = pid_m * BLOCK_M + tl.arange(0, BLOCK_M)  # Row indices for this tile
    offs_n = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)  # Col indices for this tile
    offs_k = tl.arange(0, BLOCK_K)                     # K-dimension indices

    # Pointer arithmetic: a_ptrs[i, k] = a_ptr + offs_m[i]*stride_am + offs_k[k]*stride_ak
    a_ptrs = a_ptr + offs_m[:, None] * stride_am + offs_k[None, :] * stride_ak
    b_ptrs = b_ptr + offs_k[:, None] * stride_bk + offs_n[None, :] * stride_bn

    # Accumulate in FP32 for numerical stability, even if inputs are FP16
    acc = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.float32)

    # Tiled loop over K dimension
    for k_start in range(0, K, BLOCK_K):
        # Load tiles with boundary masking
        a_tile = tl.load(a_ptrs, mask=offs_k[None, :] + k_start < K, other=0.0)
        b_tile = tl.load(b_ptrs, mask=offs_k[:, None] + k_start < K, other=0.0)

        # tl.dot compiles to Tensor Core instructions (HMMA) for FP16/BF16 inputs
        acc += tl.dot(a_tile, b_tile)

        # Advance pointers to next K-tile
        a_ptrs += BLOCK_K * stride_ak
        b_ptrs += BLOCK_K * stride_bk

    # Store the result tile
    c_ptrs = c_ptr + offs_m[:, None] * stride_cm + offs_n[None, :] * stride_cn
    mask = (offs_m[:, None] < M) & (offs_n[None, :] < N)
    tl.store(c_ptrs, acc.to(tl.float16), mask=mask)

def triton_matmul(a, b):
    M, K = a.shape
    K2, N = b.shape
    assert K == K2
    c = torch.empty((M, N), device=a.device, dtype=a.dtype)
    grid = lambda meta: (triton.cdiv(M, meta['BLOCK_M']), triton.cdiv(N, meta['BLOCK_N']))
    matmul_kernel[grid](
        a, b, c, M, N, K,
        a.stride(0), a.stride(1), b.stride(0), b.stride(1), c.stride(0), c.stride(1),
        BLOCK_M=128, BLOCK_N=128, BLOCK_K=32,
    )
    return c
```

</Code>

<Remark id="rmk-triton-matmul-design">
**Key design decisions in the matmul kernel:**

1. **Tile sizes.** `BLOCK_M` and `BLOCK_N` control the output tile size; `BLOCK_K` controls the inner loop step. Larger tiles increase data reuse (each element of A is used `BLOCK_N` times) but require more registers and shared memory. Typical values: 64-256 for `BLOCK_M/N`, 32-64 for `BLOCK_K`.
2. **FP32 accumulation.** Even with FP16 inputs, the accumulator `acc` is FP32. This matches how Tensor Cores work: they multiply in FP16 but accumulate in FP32, preventing precision loss over many additions.
3. **`tl.dot` maps to Tensor Cores.** When inputs are FP16/BF16 and tile sizes are multiples of 16, `tl.dot` compiles directly to HMMA (Tensor Core) instructions, achieving near-peak throughput.
4. **Strides as arguments.** Passing strides explicitly allows the same kernel to handle row-major, column-major, or non-contiguous tensors without code changes.
</Remark>

## Auto-tuning

Triton supports automatic tuning of kernel parameters. Adding `@triton.autotune` to the matmul kernel above lets Triton benchmark multiple configurations and select the best one:

<Code id="code-triton-3" caption="Auto-tuning finds the best tile sizes for each problem size.">

```python
@triton.autotune(
    configs=[
        triton.Config({'BLOCK_M': 128, 'BLOCK_N': 128, 'BLOCK_K': 32}, num_warps=8),
        triton.Config({'BLOCK_M': 128, 'BLOCK_N':  64, 'BLOCK_K': 32}, num_warps=4),
        triton.Config({'BLOCK_M':  64, 'BLOCK_N': 128, 'BLOCK_K': 32}, num_warps=4),
        triton.Config({'BLOCK_M':  64, 'BLOCK_N':  64, 'BLOCK_K': 64}, num_warps=4),
    ],
    key=['M', 'N', 'K'],  # Re-tune when problem dimensions change
)
@triton.jit
def matmul_kernel(a_ptr, b_ptr, c_ptr, M, N, K, ...):
    # Same kernel body as above -- only the tile sizes change
    ...
```

</Code>

<Remark id="rmk-triton-2">
**How auto-tuning works.** On the first call with a given `(M, N, K)`, Triton benchmarks every configuration in `configs`, selects the fastest, and caches the result. Subsequent calls with the same dimensions reuse the cached winner. The `num_warps` parameter controls how many warps execute each program instance (more warps = more parallelism within a tile, but fewer registers per warp). Start with a working kernel, then add `@triton.autotune` to find the best parameters.
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
