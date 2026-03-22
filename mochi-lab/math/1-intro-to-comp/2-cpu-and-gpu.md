---
sidebar_position: 2
---

# Numerical Computing Hardware

## Von Neumann Architecture

Modern CPUs follow the **Von Neumann model**: a processing unit, control unit, memory, and I/O connected by buses. The key bottleneck is the **memory wall** -- processor speed has outpaced memory bandwidth, so computation is often limited by data movement, not arithmetic.

The memory hierarchy trades capacity for speed:

| Level | Latency | Size | Bandwidth |
|-------|---------|------|-----------|
| Registers | ~0.3 ns | ~KB | ~TB/s |
| L1 cache | ~1 ns | ~64 KB | ~1 TB/s |
| L2 cache | ~4 ns | ~256 KB | ~500 GB/s |
| L3 cache | ~12 ns | ~30 MB | ~200 GB/s |
| DRAM | ~100 ns | ~64 GB | ~50 GB/s |
| GPU HBM | ~300 ns | ~80 GB | ~3 TB/s |

**Key insight:** Algorithm design for ML must respect the memory hierarchy. Operations that reuse cached data (high arithmetic intensity) are fast; those that stream through memory (low arithmetic intensity) are bottlenecked by bandwidth.

## Floating Point Representation

Real numbers are represented in **IEEE 754** format as $(-1)^s \times 1.m \times 2^{e - \text{bias}}$, where $s$ is the sign bit, $m$ is the mantissa (significand), and $e$ is the exponent.

| Format | Bits | Exponent | Mantissa | Range | Precision |
|--------|------|----------|----------|-------|-----------|
| FP32 | 32 | 8 | 23 | $\sim 10^{\pm 38}$ | $\sim 7$ digits |
| FP16 | 16 | 5 | 10 | $\sim 10^{\pm 5}$ | $\sim 3$ digits |
| BF16 | 16 | 8 | 7 | $\sim 10^{\pm 38}$ | $\sim 2$ digits |
| FP8 (E4M3) | 8 | 4 | 3 | $\sim 10^{\pm 2}$ | $\sim 1$ digit |

**Key insight:** BF16 keeps the same exponent range as FP32 (so it rarely overflows) at the cost of precision. This is why BF16 is preferred over FP16 for training -- gradient magnitudes vary widely, and overflow is more dangerous than rounding errors.

## Machine Epsilon and Numerical Stability

**Machine epsilon** $\epsilon_{\text{mach}}$ is the smallest $\epsilon$ such that $1 + \epsilon \neq 1$ in floating point:

$$
\epsilon_{\text{mach}} = 2^{-(p-1)}
$$

where $p$ is the number of mantissa bits (including the implicit leading 1). For FP32, $\epsilon_{\text{mach}} \approx 1.19 \times 10^{-7}$.

Common numerical pitfalls in ML:

- **Catastrophic cancellation:** $a - b$ when $a \approx b$ loses all significant digits
- **Overflow in softmax:** $e^{x_i}$ overflows; fix with $\text{softmax}(x)_i = e^{x_i - \max(x)} / \sum_j e^{x_j - \max(x)}$
- **Log-sum-exp:** compute $\log \sum e^{x_i}$ via $\max(x) + \log \sum e^{x_i - \max(x)}$

## Why GPUs Suit Matrix Math

A CPU has a few powerful cores optimized for sequential tasks. A GPU has thousands of simple cores optimized for parallel throughput:

| Property | CPU | GPU |
|----------|-----|-----|
| Cores | 8-128 | 5,000-20,000 |
| Clock speed | ~4 GHz | ~2 GHz |
| Peak FP32 FLOPS | ~2 TFLOPS | ~80 TFLOPS |
| Peak FP16 FLOPS | ~4 TFLOPS | ~300 TFLOPS |
| Memory bandwidth | ~50 GB/s | ~3 TB/s |

Matrix multiplication $C = AB$ where $A \in \mathbb{R}^{m \times k}$, $B \in \mathbb{R}^{k \times n}$ requires $2mkn$ FLOPs but only $mk + kn + mn$ memory accesses. The **arithmetic intensity** (FLOPs per byte) grows with matrix size, making it ideal for GPU parallelism.

**Key insight:** The arithmetic intensity of matrix multiplication is $O(n)$ for $n \times n$ matrices, meaning larger matrices use the GPU more efficiently. This is one reason why larger batch sizes and wider layers train faster per element.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $s, m, e$ | Sign, mantissa, exponent in IEEE 754 |
| $\epsilon_{\text{mach}}$ | Machine epsilon |
| $p$ | Number of mantissa bits |
| FLOPS | Floating point operations per second |
| HBM | High bandwidth memory (GPU) |
| BF16 | Brain floating point (8-bit exponent, 7-bit mantissa) |
