---
sidebar_position: 3
---

# From Silicon to PyTorch

## The Abstraction Stack

Every `torch.matmul` call traverses a deep stack of abstractions:

| Layer | Example | Role |
|-------|---------|------|
| Python API | `torch.matmul(A, B)` | User-facing interface |
| Dispatcher | ATen operator dispatch | Routes to correct backend |
| Kernel library | cuBLAS `cublasGemmEx` | Optimized BLAS implementation |
| CUDA runtime | Thread/block scheduling | Maps work to GPU hardware |
| PTX / SASS | GPU assembly | Instruction-level execution |
| Hardware | Tensor Cores, CUDA Cores | Silicon |

**Key insight:** Each layer trades generality for performance. The user writes generic Python; the system compiles it down to hardware-specific instructions that exploit the exact memory layout and compute units available.

## BLAS and LAPACK

**BLAS** (Basic Linear Algebra Subprograms) defines three levels of operations:

| Level | Operation | Complexity | Example |
|-------|-----------|------------|---------|
| 1 | Vector-vector | $O(n)$ | $\alpha x + y$ (axpy) |
| 2 | Matrix-vector | $O(n^2)$ | $Ax + y$ (gemv) |
| 3 | Matrix-matrix | $O(n^3)$ | $\alpha AB + \beta C$ (gemm) |

Level 3 operations have the highest arithmetic intensity and benefit most from GPU acceleration. The **GEMM** (General Matrix Multiply) operation is the workhorse of deep learning:

$$
C \leftarrow \alpha A B + \beta C, \quad A \in \mathbb{R}^{m \times k}, \, B \in \mathbb{R}^{k \times n}, \, C \in \mathbb{R}^{m \times n}
$$

**LAPACK** builds on BLAS to provide eigenvalue decomposition, SVD, linear system solvers, and matrix factorizations.

## Tensor Operations as Linear Algebra

Neural network operations map directly to BLAS calls:

| NN operation | Mathematical form | BLAS call |
|--------------|-------------------|-----------|
| Linear layer | $y = Wx + b$ | GEMV or GEMM (batched) |
| Batch linear | $Y = XW^\top + b$ | GEMM |
| Attention scores | $S = QK^\top / \sqrt{d}$ | GEMM + scalar |
| Convolution | $\text{im2col} + \text{GEMM}$ | GEMM on unrolled patches |

**Key insight:** Almost all neural network computation reduces to matrix multiplication. This is why advances in GEMM performance (Tensor Cores, mixed precision) directly translate to faster training and inference.

## Operator Fusion

Separate operations like $\text{ReLU}(\text{BatchNorm}(Wx + b))$ normally require:

1. GEMM: compute $Wx + b$ and write result to GPU memory
2. Read result, apply BatchNorm, write back
3. Read result, apply ReLU, write back

Each read/write to global memory costs ~300 ns. **Operator fusion** combines these into a single kernel that keeps intermediate results in registers or shared memory:

$$
\text{Fused: } \quad y = \text{ReLU}\!\left(\frac{Wx + b - \mu}{\sqrt{\sigma^2 + \epsilon}} \cdot \gamma + \beta\right) \quad \text{(one memory round-trip)}
$$

Fusion reduces memory traffic by a factor proportional to the number of fused operations, often yielding 2-5x speedups for elementwise-heavy workloads.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| BLAS | Basic Linear Algebra Subprograms |
| GEMM | General Matrix Multiply |
| LAPACK | Linear Algebra Package |
| cuBLAS | NVIDIA's GPU BLAS library |
| PTX | Parallel Thread Execution (GPU assembly) |
| $\alpha, \beta$ | Scalar coefficients in GEMM |
