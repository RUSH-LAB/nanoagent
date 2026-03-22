---
sidebar_position: 3
---

# From Assembly to PyTorch

## The Abstraction Stack

When you write `torch.matmul(A, B)`, here is what actually happens:

```
Layer 7: Python          torch.matmul(A, B)
Layer 6: ATen Dispatch   at::matmul(A, B) -> selects CUDA backend
Layer 5: cuBLAS          cublasGemmEx(..., CUBLAS_COMPUTE_32F)
Layer 4: CUDA Runtime    cudaLaunchKernel(gemm_kernel, grid, block, ...)
Layer 3: PTX Assembly    mad.f32 %f3, %f1, %f2, %f3;
Layer 2: SASS            Hardware-specific GPU assembly
Layer 1: Silicon         Tensor Cores execute 4x4 matrix FMAs
```

Each layer adds abstraction at the cost of some control. The key insight is that **most ML code should stay at layers 6-7**, dropping to lower layers only for custom operations that existing libraries do not support.

## How PyTorch Dispatches Operations

```python
import torch

A = torch.randn(1024, 1024, device='cuda', dtype=torch.float16)
B = torch.randn(1024, 1024, device='cuda', dtype=torch.float16)
C = torch.matmul(A, B)  # What happens here?
```

The dispatch path:

1. **Python** -- `torch.matmul` is a Python function that calls into C++
2. **Dispatcher** -- checks device (CUDA), dtype (float16), layout (strided)
3. **Backend selection** -- routes to `at::cuda::matmul`
4. **cuBLAS call** -- for float16, calls `cublasHgemm` which uses Tensor Cores
5. **Kernel launch** -- cuBLAS launches a tiled GEMM kernel
6. **Tensor Cores** -- each core computes a 4x4 FP16 matrix multiply-accumulate

**Tip:** You can see the dispatched operations with `torch.autograd.profiler.profile()` or by setting `TORCH_SHOW_DISPATCH_TRACE=1`.

## JIT Compilation and torch.compile

PyTorch 2.0 introduced `torch.compile`, which captures the computation graph and optimizes it:

```python
@torch.compile
def fused_gelu(x):
    return 0.5 * x * (1 + torch.tanh(
        math.sqrt(2 / math.pi) * (x + 0.044715 * x ** 3)
    ))
```

Without compilation, this launches 7 separate CUDA kernels (one per operation). With `torch.compile`, TorchInductor fuses them into a single Triton kernel.

```
Before torch.compile:     After torch.compile:
  mul_kernel               fused_gelu_kernel
  pow_kernel                 (one kernel, one
  mul_kernel                  memory round-trip)
  add_kernel
  tanh_kernel
  add_kernel
  mul_kernel
```

## Operator Fusion in Practice

The biggest performance wins come from fusing memory-bound operations:

```python
# Unfused: 3 kernel launches, 3 global memory round-trips
y = torch.relu(torch.batch_norm(torch.linear(x, w, b)))

# Fused (via torch.compile or custom kernel): 1 kernel, 1 round-trip
# Intermediate results stay in registers/shared memory
```

Common fusion patterns:

| Pattern | Operations | Speedup |
|---------|-----------|---------|
| Linear + activation | matmul + ReLU/GELU | 1.2-1.5x |
| Attention | QK^T + mask + softmax + V | 2-4x (FlashAttention) |
| LayerNorm + dropout | mean + var + normalize + mask | 2-3x |

## BLAS: The Foundation

All matrix operations in deep learning ultimately call BLAS (Basic Linear Algebra Subprograms):

```
Level 1 (vector-vector):  saxpy    y = ax + y         O(n)
Level 2 (matrix-vector):  sgemv    y = Ax + y         O(n^2)
Level 3 (matrix-matrix):  sgemm    C = aAB + bC       O(n^3)
```

The naming convention: `{s|d|c|z}{ge|sy|tr}{mm|mv|sv}`
- Precision: s=float32, d=float64, c=complex64, z=complex128
- Matrix type: ge=general, sy=symmetric, tr=triangular
- Operation: mm=matrix-matrix, mv=matrix-vector, sv=solve

**Tip:** When profiling, if you see most time in `sgemm`/`cublasGemmEx`, your workload is healthy -- it means compute dominates over memory overhead.
