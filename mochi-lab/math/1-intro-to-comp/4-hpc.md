---
sidebar_position: 4
---

# Parallel and Distributed Computing

## Parallel Computing Models

| Model | Description | Example |
|-------|-------------|---------|
| **SIMD** | Single instruction, multiple data | AVX vector instructions, GPU warps |
| **MIMD** | Multiple instructions, multiple data | Multi-core CPU, multi-node clusters |
| **SPMD** | Single program, multiple data | MPI programs, distributed training |

GPUs use **SIMT** (Single Instruction, Multiple Threads) -- a variant of SIMD where threads in a **warp** (32 threads on NVIDIA) execute the same instruction in lockstep. Divergent branches cause serialization.

## Amdahl's Law

If a fraction $p$ of a computation is parallelizable, the maximum speedup with $n$ processors is:

$$
S(n) = \frac{1}{(1 - p) + \frac{p}{n}}
$$

As $n \to \infty$, $S \to \frac{1}{1 - p}$. Even with infinite parallelism, the serial fraction bounds the speedup.

**Key insight:** If 5% of your training pipeline is serial (data loading, logging, gradient synchronization overhead), the maximum speedup from adding GPUs is $1/0.05 = 20\times$, regardless of how many GPUs you add.

## Gustafson's Law

Amdahl's law assumes fixed problem size. **Gustafson's law** assumes fixed time and scales the problem:

$$
S(n) = n - (1 - p)(n - 1) = 1 + p(n - 1)
$$

This is more realistic for ML: with more GPUs, we train on larger batches or larger models, not the same model faster.

## Distributed Linear Algebra

Large matrix operations are distributed across devices by partitioning along rows, columns, or blocks:

**Data parallelism:** Each device holds a full copy of the model $W$ and a shard of the data $X_i$. Forward pass computes $Y_i = f(X_i; W)$ independently. Gradients are synchronized via **allreduce**:

$$
\nabla W = \frac{1}{N} \sum_{i=1}^{N} \nabla W_i
$$

**Model parallelism (tensor):** A weight matrix $W \in \mathbb{R}^{m \times n}$ is split column-wise across $k$ devices: $W = [W_1 | W_2 | \cdots | W_k]$. Each device computes $Y_i = XW_i$ and results are concatenated or reduced.

**Pipeline parallelism:** Model layers are partitioned across devices. Device $i$ processes layer $i$ and forwards activations to device $i+1$. Micro-batching fills the pipeline to reduce idle "bubble" time.

## Communication Primitives

| Primitive | Description | Cost |
|-----------|-------------|------|
| **Broadcast** | One-to-all | $O(\log n)$ latency, $O(m)$ bandwidth |
| **Reduce** | All-to-one with aggregation | $O(\log n)$ latency, $O(m)$ bandwidth |
| **Allreduce** | Reduce + broadcast | $2(n-1)/n \cdot m$ bandwidth-optimal |
| **Allgather** | Gather shards to all | $(n-1)/n \cdot m$ bandwidth |
| **ReduceScatter** | Reduce + scatter shards | $(n-1)/n \cdot m$ bandwidth |

The **ring allreduce** algorithm achieves bandwidth-optimal allreduce in $2(n-1)$ steps, each transferring $m/n$ data. Total bandwidth cost: $2 \cdot \frac{n-1}{n} \cdot m$, independent of the number of nodes (asymptotically).

## Communication-Computation Overlap

The ratio of computation to communication determines scalability. For a GEMM of size $m \times k \times n$ on $p$ devices:

$$
\text{Compute time} \propto \frac{2mkn}{p \cdot F}, \quad \text{Comm time} \propto \frac{m \cdot n}{B}
$$

where $F$ is per-device FLOPS and $B$ is interconnect bandwidth. Overlap is possible when communication of one micro-batch proceeds concurrently with computation of the next.

**Key insight:** Scaling efficiency depends on the ratio $F / (p \cdot B)$. Faster interconnects (NVLink, InfiniBand) and larger matrix sizes improve this ratio.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $p$ | Parallel fraction (Amdahl) or number of devices |
| $n$ | Number of processors/devices |
| $S(n)$ | Speedup with $n$ processors |
| $m$ | Message size (bytes) |
| $F$ | Device compute throughput (FLOPS) |
| $B$ | Interconnect bandwidth (bytes/s) |
| SIMD | Single instruction, multiple data |
| SIMT | Single instruction, multiple threads |
| SPMD | Single program, multiple data |
