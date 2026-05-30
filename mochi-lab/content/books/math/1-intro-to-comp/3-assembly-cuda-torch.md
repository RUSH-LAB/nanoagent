---
sidebar_position: 3
---

# From Silicon to PyTorch

Every call to `torch.matmul(A, B)` triggers a chain of events spanning multiple layers of abstraction, from Python down to transistors. Understanding this stack explains *why* certain operations are fast, why operator fusion matters, and how to reason about performance.

## The Abstraction Stack

<Table id="tab-abstraction-stack" caption="The software-hardware abstraction stack from Python to silicon.">

| Layer | Example | What Happens |
|-------|---------|------|
| **Python API** | `torch.matmul(A, B)` | User-facing call; type-checks, dispatches |
| **ATen Dispatcher** | Operator dispatch by dtype, device, autograd | Routes to correct backend implementation |
| **Kernel Library** | cuBLAS `cublasGemmEx` | Optimized BLAS kernel selected by matrix size and dtype |
| **CUDA Runtime** | Grid/block/thread scheduling | Maps logical threads to physical SMs |
| **PTX / SASS** | GPU assembly instructions | Register allocation, instruction scheduling |
| **Hardware** | Tensor Cores, CUDA Cores, memory controllers | Actual silicon execution |

</Table>

<Remark id="rmk-abstraction-tradeoff">
Each layer trades generality for performance. The user writes generic Python; the system compiles it down to hardware-specific instructions that exploit the exact memory layout, data type, and compute units available. Performance bugs usually live at one specific layer, and understanding the stack tells you where to look.
</Remark>

<Example id="ex-dispatch-path">
**Tracing a matmul call.** When you call `torch.matmul(A, B)` where both tensors are `float16` on `cuda:0`:

1. **Python:** `torch.matmul` is a Python function that calls into C++ via `torch._C`
2. **Dispatcher:** The ATen dispatcher checks: dtype is `float16`, device is `cuda`, `requires_grad=True` on one input, routes to the autograd-wrapped CUDA kernel
3. **cuBLAS:** For matrices of shape $(m, k) \times (k, n)$, cuBLAS selects a tile size and algorithm (e.g., `CUBLAS_GEMM_DEFAULT_TENSOR_OP`) that maps to Tensor Cores
4. **Tensor Cores:** Execute $4 \times 4 \times 4$ matrix multiply-accumulate operations in a single clock cycle (warp-level $16 \times 16 \times 16$ WMMA instructions aggregate multiple Tensor Core operations across several cycles)
5. **Result:** Written back through the memory hierarchy to HBM, wrapped in a new PyTorch tensor with a backward function registered for autograd
</Example>

## BLAS: The Computational Backbone

<Definition id="def-blas" name="BLAS (Basic Linear Algebra Subprograms)">
**BLAS** is a standardized interface for basic linear algebra operations, organized into three levels by computational intensity. Originally specified in Fortran in the 1970s, it remains the foundation of all numerical computing libraries.
</Definition>

<Table id="tab-blas-levels" caption="BLAS operation levels, computational complexity, and arithmetic intensity.">

| Level | Operation Type | Complexity | FLOPs/Word | Example | Library Call |
|-------|-----------|------------|------------|---------|-------------|
| 1 | Vector-vector | $O(n)$ | $O(1)$ | $y \leftarrow \alpha x + y$ | `axpy` |
| 2 | Matrix-vector | $O(n^2)$ | $O(1)$ | $y \leftarrow Ax + y$ | `gemv` |
| 3 | Matrix-matrix | $O(n^3)$ | $O(n)$ | $C \leftarrow \alpha AB + \beta C$ | `gemm` |

</Table>

Level 3 operations have arithmetic intensity that grows with matrix size, making them compute-bound on modern hardware. Level 1 and 2 operations are always memory-bound because each element is touched only $O(1)$ times.

<Definition id="def-gemm" name="GEMM (General Matrix Multiply)">
The **GEMM** operation is the workhorse of deep learning:

<Equation id="eq-gemm">

$$C \leftarrow \alpha \, \text{op}(A) \, \text{op}(B) + \beta \, C$$

</Equation>

where $A \in \mathbb{R}^{m \times k}$, $B \in \mathbb{R}^{k \times n}$, $C \in \mathbb{R}^{m \times n}$, and $\text{op}(\cdot)$ is identity or transpose. The total FLOP count is $2mkn$ (each output element requires $k$ multiply-adds).
</Definition>

**LAPACK** (Linear Algebra PACKage) builds on BLAS to provide higher-level operations: eigenvalue decomposition, SVD, Cholesky factorization, QR decomposition, and linear system solvers. On GPUs, NVIDIA provides cuSOLVER as the LAPACK equivalent.

<Table id="tab-blas-libraries" caption="Common BLAS/LAPACK implementations.">

| Library | Platform | Notes |
|---------|----------|-------|
| OpenBLAS | CPU (multi-platform) | Open-source, hand-tuned assembly kernels |
| MKL | CPU (Intel) | Intel-optimized, often fastest on Intel hardware |
| cuBLAS | GPU (NVIDIA) | Exploits Tensor Cores for mixed-precision GEMM |
| cuSOLVER | GPU (NVIDIA) | GPU LAPACK equivalent |
| CUTLASS | GPU (NVIDIA) | Template-based, customizable GEMM kernels |
| Triton | GPU (NVIDIA) | Python DSL for writing fused GPU kernels |

</Table>

## Neural Network Operations as Linear Algebra

Almost every neural network computation reduces to BLAS calls, which is why optimizing GEMM directly translates to faster training and inference.

<Table id="tab-nn-to-blas" caption="Mapping neural network operations to BLAS calls.">

| NN Operation | Mathematical Form | BLAS Call | Notes |
|--------------|-------------------|-----------|-------|
| Linear layer (single input) | $y = Wx + b$ | GEMV | Memory-bound for small $x$ |
| Linear layer (batch) | $Y = XW^\top + \mathbf{1}b^\top$ | GEMM | Compute-bound for large batches |
| Attention scores | $S = QK^\top / \sqrt{d_k}$ | GEMM + element-wise | FlashAttention fuses softmax |
| Attention output | $O = \text{softmax}(S) \cdot V$ | GEMM | |
| 2D convolution | $\text{im2col}(X) \cdot W_{\text{reshape}}$ | GEMM | im2col unrolls patches into columns |
| Depthwise convolution | Per-channel ops | Specialized kernel | Does not map well to GEMM |
| Multi-head attention | Batched $Q_i K_i^\top$, $\text{softmax} \cdot V_i$ | Batched GEMM | `torch.baddbmm` |

</Table>

<Remark id="rmk-gemm-dominance">
In a standard transformer training step, GEMM operations (linear projections, attention scores, attention output, FFN) account for roughly 60-70% of total FLOPs. The remaining 30-40% (layer norm, softmax, dropout, activation functions) are element-wise and memory-bound. This is why Tensor Cores, which can accelerate GEMM by approximately 8-16x, typically produce only around 2-3x end-to-end speedup, because the memory-bound operations become the bottleneck. (These figures are illustrative and vary by model architecture and hardware generation.)
</Remark>

## Operator Fusion

<Definition id="def-operator-fusion" name="Operator Fusion">
**Operator fusion** combines multiple sequential operations into a single GPU kernel, eliminating intermediate reads from and writes to global memory (HBM). Instead of writing intermediate results to HBM between each operation, the fused kernel keeps data in registers or shared memory (SRAM).
</Definition>

Consider the compound operation $\text{ReLU}(\text{BatchNorm}(Wx + b))$:

**Without fusion** (3 separate kernels):
1. GEMM kernel: compute $z = Wx + b$, write $z$ to HBM
2. BatchNorm kernel: read $z$ from HBM, compute $\hat{z} = \gamma \frac{z - \mu}{\sqrt{\sigma^2 + \epsilon}} + \beta$, write $\hat{z}$ to HBM
3. ReLU kernel: read $\hat{z}$ from HBM, compute $\max(0, \hat{z})$, write to HBM

Total memory traffic: $6 \times n$ reads/writes to HBM (where $n$ is the output size).

**With fusion** (1 kernel):

<Equation id="eq-fused-op">

$$y = \max\!\left(0, \;\gamma \frac{Wx + b - \mu}{\sqrt{\sigma^2 + \epsilon}} + \beta\right) \quad \text{(one round-trip to HBM)}$$

</Equation>

Total memory traffic: $2 \times n$ (read inputs, write outputs). This is a $3\times$ reduction in memory traffic.

<Example id="ex-flash-attention">
**FlashAttention as operator fusion** [@dao2022flashattention]. Standard attention computes and materializes the $T \times T$ attention matrix $S = QK^\top/\sqrt{d}$, which requires $O(T^2)$ HBM. FlashAttention fuses the entire $\text{softmax}(QK^\top/\sqrt{d}) \cdot V$ computation into tiled SRAM operations:

1. Load tiles of $Q$, $K$, $V$ into SRAM (shared memory)
2. Compute partial attention scores and outputs in SRAM
3. Use online softmax (tracking running max and sum) to combine tiles
4. Write only the final output $O$ to HBM

Result: memory usage drops from $O(T^2)$ to $O(T)$, and wall-clock time improves 2-4x for long sequences despite performing *more* FLOPs (due to recomputation in the backward pass). This is a striking example of trading compute for memory bandwidth.
</Example>

<Table id="tab-fusion-examples" caption="Common operator fusions in ML frameworks (speedups are approximate and vary by workload and hardware).">

| Fused Operation | Separate Ops | Speedup | Framework Support |
|----------------|-------------|---------|-------------------|
| GEMM + bias + ReLU | 3 kernels | ~2x | cuBLAS, cuDNN |
| LayerNorm + residual | 3 kernels | ~2-3x | Apex, Triton |
| Softmax + mask + dropout | 3 kernels | ~2x | FlashAttention, xFormers |
| GEMM + GELU | 2 kernels | ~1.5x | Megatron-LM |
| Full attention block | ~10 kernels | ~2-4x | FlashAttention |

</Table>

## Torch Compilation

<Remark id="rmk-torch-compile">
Modern PyTorch provides `torch.compile()` [@ansel2024pytorch2], which automatically traces the computation graph and applies operator fusion, kernel selection, and memory planning. Under the hood, it uses TorchInductor to generate Triton kernels that fuse element-wise operations. This often achieves 1.5-2x speedup with a single line of code, though it does not yet match hand-written fusions like FlashAttention for complex patterns.
</Remark>

## Notation Summary

<Table id="tab-notation-silicon" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| BLAS | Basic Linear Algebra Subprograms |
| GEMM | General Matrix Multiply: $C \leftarrow \alpha AB + \beta C$ |
| GEMV | General Matrix-Vector Multiply |
| LAPACK | Linear Algebra Package |
| cuBLAS | NVIDIA GPU BLAS library |
| cuSOLVER | NVIDIA GPU LAPACK library |
| CUTLASS | NVIDIA template GEMM library |
| PTX | Parallel Thread Execution (GPU intermediate representation) |
| SASS | GPU machine code (hardware-specific) |
| HBM | High Bandwidth Memory |
| SRAM | Static RAM (shared memory, L1 cache) |
| $\alpha, \beta$ | Scalar coefficients in GEMM |

</Table>
