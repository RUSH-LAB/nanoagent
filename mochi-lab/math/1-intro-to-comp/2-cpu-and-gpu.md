---
sidebar_position: 2
---

# Numerical Computing Hardware

Every ML algorithm ultimately runs on physical hardware that represents real numbers with finite precision and moves data through a memory hierarchy. Understanding these constraints is not optional -- they determine which algorithms are fast, which are numerically stable, and why certain design choices (batch size, precision, operator fusion) matter.

## Von Neumann Architecture

<Definition id="def-von-neumann" name="Von Neumann Architecture">
Modern CPUs follow the **Von Neumann model**: a single shared memory stores both instructions and data, connected to a processing unit (ALU), a control unit, and I/O devices via buses. The processor fetches instructions from memory, decodes them, and executes them sequentially (with pipelining and out-of-order execution to hide latency).
</Definition>

The key performance bottleneck is the **memory wall** -- processor speed has improved roughly $1000\times$ faster than memory latency over the past four decades. As a result, modern computation is almost always limited by *data movement*, not arithmetic.

## Memory Hierarchy

To mitigate the memory wall, hardware uses a hierarchy of progressively larger but slower memories:

<Table id="tab-memory-hierarchy" caption="Memory hierarchy latencies and bandwidths for modern hardware (approximate, circa 2024).">

| Level | Latency | Typical Size | Bandwidth | Cost/GB |
|-------|---------|-------------|-----------|---------|
| Registers | ~0.3 ns | ~KB | ~TB/s | -- |
| L1 cache | ~1 ns | ~64 KB/core | ~1 TB/s | -- |
| L2 cache | ~4 ns | ~256 KB--1 MB/core | ~500 GB/s | -- |
| L3 cache | ~12 ns | ~30--50 MB (shared) | ~200 GB/s | -- |
| CPU DRAM | ~100 ns | ~64--512 GB | ~50--100 GB/s | ~$3/GB |
| GPU HBM3 | ~300 ns | ~80 GB (H100) | ~3.35 TB/s | ~$15/GB |
| NVMe SSD | ~10 $\mu$s | ~TB | ~7 GB/s | ~$0.1/GB |
| Network (NVLink) | ~1 $\mu$s | -- | ~900 GB/s | -- |
| Network (InfiniBand) | ~1 $\mu$s | -- | ~400 GB/s | -- |

</Table>

<Remark id="rmk-memory-hierarchy">
Algorithm design for ML must respect the memory hierarchy. The key metric is **arithmetic intensity** -- the ratio of FLOPs performed to bytes moved. Operations with high arithmetic intensity (like large matrix multiplications) are *compute-bound* and use the GPU efficiently. Operations with low arithmetic intensity (like element-wise operations, reductions, or small matrix multiplies) are *memory-bound* and limited by bandwidth.
</Remark>

<Definition id="def-arithmetic-intensity" name="Arithmetic Intensity">
The **arithmetic intensity** $I$ of an operation is:

<Equation id="eq-arithmetic-intensity">

$$I = \frac{\text{FLOPs}}{\text{Bytes accessed from memory}}$$

</Equation>

An operation is **compute-bound** if $I > I^*$ (the hardware's FLOP/byte ratio) and **memory-bound** if $I < I^*$. For an NVIDIA H100, $I^* \approx 80\text{ TFLOPS} / 3.35\text{ TB/s} \approx 24$ FLOPs/byte for FP32.
</Definition>

<Example id="ex-roofline">
**Roofline analysis of matrix multiplication.** For $C = AB$ where $A \in \mathbb{R}^{n \times n}$, $B \in \mathbb{R}^{n \times n}$:
- FLOPs: $2n^3$ (each of $n^2$ output entries requires $n$ multiply-adds)
- Bytes (if reading each matrix once): $3 \times 4n^2 = 12n^2$ bytes (FP32)
- Arithmetic intensity: $I = 2n^3 / 12n^2 = n/6$

For $n = 4096$: $I \approx 683$, which far exceeds $I^* \approx 24$, so the operation is compute-bound. For $n = 32$: $I \approx 5.3 < I^*$, so the operation is memory-bound. This is why batching small operations together improves GPU utilization.
</Example>

## Floating-Point Representation

<Definition id="def-ieee754" name="IEEE 754 Floating Point">
Real numbers are represented in **IEEE 754** format as:

<Equation id="eq-ieee754">

$$x = (-1)^s \times (1 + f) \times 2^{e - \text{bias}}$$

</Equation>

where $s \in \{0,1\}$ is the **sign bit**, $f = 0.b_1 b_2 \ldots b_p$ is the fractional part of the **significand** (with an implicit leading 1 for normalized numbers), $e$ is the **biased exponent**, and $\text{bias} = 2^{w-1} - 1$ for an exponent field of $w$ bits.

Special values: $e = 0$ with $f = 0$ represents $\pm 0$; $e = 2^w - 1$ with $f = 0$ represents $\pm \infty$; $e = 2^w - 1$ with $f \neq 0$ represents NaN (not a number).
</Definition>

<Table id="tab-float-formats" caption="Common floating-point formats used in ML training and inference.">

| Format | Total Bits | Exponent Bits | Mantissa Bits | Range | Precision | ML Use |
|--------|-----------|---------------|---------------|-------|-----------|--------|
| FP64 | 64 | 11 | 52 | $\sim 10^{\pm 308}$ | ~15 digits | Numerical verification |
| FP32 | 32 | 8 | 23 | $\sim 10^{\pm 38}$ | ~7 digits | Default training, master weights |
| TF32 | 19 | 8 | 10 | $\sim 10^{\pm 38}$ | ~3 digits | Tensor Core matmuls (A100+) |
| FP16 | 16 | 5 | 10 | $\sim 6.5 \times 10^{4}$ | ~3 digits | Mixed-precision training |
| BF16 | 16 | 8 | 7 | $\sim 10^{\pm 38}$ | ~2 digits | Preferred for LLM training |
| FP8 (E4M3) | 8 | 4 | 3 | $\pm 448$ | ~1 digit | Inference, forward pass |
| FP8 (E5M2) | 8 | 5 | 2 | $\sim 10^{\pm 4}$ | < 1 digit | Gradients in FP8 training |
| INT8 | 8 | -- | -- | $-128$ to $127$ | Exact | Post-training quantization |
| INT4 | 4 | -- | -- | $-8$ to $7$ | Exact | Aggressive quantization (GPTQ, AWQ) |

</Table>

<Remark id="rmk-bf16">
BF16 keeps the same 8-bit exponent as FP32, so it can represent the same range of magnitudes. This is critical for training, where gradient magnitudes can vary by many orders of magnitude. FP16's 5-bit exponent limits its range to $\sim 6.5 \times 10^4$, causing overflow in gradients that BF16 handles effortlessly. The tradeoff is precision: BF16 has only 7 mantissa bits (vs. 10 for FP16), so individual values are less accurate, but this rarely matters for stochastic gradient descent.
</Remark>

## Machine Epsilon and Numerical Stability

<Definition id="def-machine-epsilon" name="Machine Epsilon">
**Machine epsilon** $\epsilon_{\text{mach}}$ is the smallest positive floating-point number $\epsilon$ such that $\text{fl}(1 + \epsilon) \neq 1$, where $\text{fl}(\cdot)$ denotes rounding to the nearest representable float:

<Equation id="eq-machine-epsilon">

$$\epsilon_{\text{mach}} = 2^{-p}$$

</Equation>

where $p$ is the number of significand bits (including the implicit leading 1 bit). This means every floating-point operation introduces a relative error bounded by $\epsilon_{\text{mach}}/2$.
</Definition>

<Table id="tab-machine-epsilon" caption="Machine epsilon for common formats.">

| Format | $p$ (significand bits) | $\epsilon_{\text{mach}}$ |
|--------|----------------------|--------------------------|
| FP64 | 53 | $\approx 1.11 \times 10^{-16}$ |
| FP32 | 24 | $\approx 5.96 \times 10^{-8}$ |
| FP16 | 11 | $\approx 4.88 \times 10^{-4}$ |
| BF16 | 8 | $\approx 3.91 \times 10^{-3}$ |

</Table>

### Common Numerical Pitfalls in ML

<Definition id="def-numerical-stability" name="Numerical Stability">
An algorithm is **numerically stable** if small perturbations in its inputs (such as floating-point rounding) produce only small perturbations in its outputs. It is **backward stable** if the computed result is the exact result for a slightly perturbed input.
</Definition>

<Table id="tab-numerical-pitfalls" caption="Common numerical instabilities in ML and their standard fixes.">

| Pitfall | Example | Fix |
|---------|---------|-----|
| **Catastrophic cancellation** | $a - b$ when $a \approx b$ loses all significant digits | Reformulate: use $\log(1+x)$ via `log1p`, not `log(1+x)` |
| **Overflow in softmax** | $e^{1000}$ overflows in FP32 | Shift: $\text{softmax}(x)_i = \frac{e^{x_i - \max(x)}}{\sum_j e^{x_j - \max(x)}}$ |
| **Underflow in log-probs** | $\log(e^{-1000})$ underflows to $\log(0) = -\infty$ | Use log-space: $\text{logsumexp}(x) = \max(x) + \log \sum_j e^{x_j - \max(x)}$ |
| **Variance accumulation** | Naive variance formula $\frac{1}{n}\sum x_i^2 - \bar{x}^2$ is unstable | Use Welford's online algorithm |
| **Gradient explosion** | Gradients overflow in deep networks | Gradient clipping, careful initialization, normalization layers |
| **Loss of orthogonality** | Gram--Schmidt loses orthogonality in finite precision | Use modified Gram--Schmidt or Householder reflections |

</Table>

<Example id="ex-softmax-stability">
**Why the softmax shift works.** For logits $z = [1000, 1001, 1002]$:
- Naive: $e^{1000}, e^{1001}, e^{1002}$ all overflow to $+\infty$, giving NaN.
- Shifted: subtract $\max(z) = 1002$ to get $e^{-2}, e^{-1}, e^{0}$, which are all representable.
- The shift does not change the output because $\frac{e^{z_i - c}}{\sum_j e^{z_j - c}} = \frac{e^{z_i}/e^c}{\sum_j e^{z_j}/e^c} = \frac{e^{z_i}}{\sum_j e^{z_j}}$.
</Example>

## GPU Architecture for ML

<Definition id="def-gpu-architecture" name="GPU Architecture (NVIDIA)">
A modern NVIDIA GPU (e.g., H100) is organized as:

- **Streaming Multiprocessors (SMs)**: 132 SMs, each containing CUDA cores, Tensor Cores, shared memory, and an L1 cache
- **Tensor Cores**: Specialized units that compute small matrix multiplies (e.g., $4 \times 4$ FP16 matmul) in a single clock cycle
- **Global memory (HBM3)**: 80 GB at 3.35 TB/s bandwidth, shared across all SMs
- **Shared memory / L1**: ~228 KB per SM, programmer-managed scratchpad
- **Warp**: 32 threads that execute in lockstep (SIMT model)
</Definition>

<Table id="tab-cpu-vs-gpu" caption="CPU vs GPU characteristics for ML workloads (2024 high-end).">

| Property | CPU (AMD EPYC 9654) | GPU (NVIDIA H100 SXM) |
|----------|-----|-----|
| Cores | 96 | 16,896 CUDA + 528 Tensor Cores |
| Clock speed | ~3.7 GHz | ~1.8 GHz |
| Peak FP32 TFLOPS | ~5 | ~67 |
| Peak FP16/BF16 TFLOPS | ~10 | ~990 (Tensor Core) |
| Peak INT8 TOPS | ~20 | ~1,979 (Tensor Core) |
| Memory | 768 GB DDR5 | 80 GB HBM3 |
| Memory bandwidth | ~460 GB/s | ~3,350 GB/s |
| TDP | 360W | 700W |

</Table>

<Remark id="rmk-tensor-cores">
**Tensor Cores** are the key to GPU performance for ML. They compute $D = A \times B + C$ for small matrices (e.g., $16 \times 16 \times 16$) in a single operation, fusing multiply and add. This is why operations that can be expressed as matrix multiplications (linear layers, attention, convolutions via im2col) are fast, while operations that cannot (layer norm, dropout, activation functions) are memory-bound.
</Remark>

<Remark id="rmk-gpu-matmul">
Matrix multiplication $C = AB$ where $A \in \mathbb{R}^{m \times k}$, $B \in \mathbb{R}^{k \times n}$ requires $2mkn$ FLOPs but only reads/writes $mk + kn + mn$ elements. The arithmetic intensity $I = \frac{2mkn}{4(mk + kn + mn)}$ (for FP32) grows with matrix dimensions, making it ideal for GPU parallelism. This is one reason why larger batch sizes and wider layers train faster per element -- they produce larger, more compute-bound matrix multiplications.
</Remark>

## The Compute--Memory Tradeoff in ML

<Remark id="rmk-compute-memory-tradeoff">
Many ML design decisions are fundamentally about trading compute for memory or vice versa:

| Technique | Saves | Costs |
|-----------|-------|-------|
| **Gradient checkpointing** | Activation memory (by $\sqrt{L}$) | Recomputes forward pass (~33% overhead) |
| **Mixed precision** | Memory and compute | Slight accuracy risk (mitigated by loss scaling) |
| **Operator fusion** | Memory bandwidth (eliminates intermediate writes) | Kernel development effort |
| **FlashAttention** | Memory ($O(T^2) \to O(T)$) | Slightly more FLOPs (recomputation in backward) |
| **Quantization** | Memory and bandwidth | Accuracy degradation |

Understanding this tradeoff is central to ML systems engineering.
</Remark>

## Notation Summary

<Table id="tab-notation-hardware" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $s, f, e$ | Sign, fractional significand, exponent in IEEE 754 |
| $p$ | Number of significand bits |
| $\epsilon_{\text{mach}}$ | Machine epsilon |
| $I$ | Arithmetic intensity (FLOPs/byte) |
| $I^*$ | Hardware's compute-to-bandwidth ratio |
| FLOPS | Floating-point operations per second |
| TFLOPS | $10^{12}$ FLOPS |
| HBM | High Bandwidth Memory (GPU) |
| SM | Streaming Multiprocessor |
| SIMT | Single Instruction, Multiple Threads |

</Table>
