---
sidebar_position: 4
---

# Parallel and Distributed Computing

Training modern ML models requires distributing computation across multiple devices. This chapter develops the mathematical framework for understanding parallelism, its fundamental limits, and the communication patterns used in distributed training.

## Parallel Computing Models

<Definition id="def-parallel-models" name="Parallel Execution Models">
Parallel architectures are classified by how instructions and data are organized:
</Definition>

<Table id="tab-parallel-models" caption="Flynn's taxonomy of parallel computing models.">

| Model | Full Name | Description | ML Example |
|-------|-----------|-------------|------------|
| **SIMD** | Single Instruction, Multiple Data | One instruction operates on multiple data elements | AVX-512 vector instructions on CPU |
| **SIMT** | Single Instruction, Multiple Threads | Threads in a warp execute the same instruction (with masking for divergence) | NVIDIA GPU warps (32 threads) |
| **MIMD** | Multiple Instructions, Multiple Data | Independent processors execute different instructions | Multi-core CPU, multi-node cluster |
| **SPMD** | Single Program, Multiple Data | Same program runs on all processors, each on different data | `torchrun` distributed training |

</Table>

<Remark id="rmk-simt-divergence">
In SIMT execution, when threads in a warp take different branches (divergence), both branches execute serially with the inactive threads masked. This means `if-else` in GPU kernels can halve throughput. Minimizing warp divergence is a key GPU optimization principle.
</Remark>

## Amdahl's Law: The Limits of Parallelism

<Theorem id="thm-amdahl" name="Amdahl's Law">
If a fraction $p$ of a computation is perfectly parallelizable and the remaining fraction $(1-p)$ is inherently serial, the maximum speedup with $n$ processors is:

<Equation id="eq-amdahl">

$$S(n) = \frac{1}{(1 - p) + \frac{p}{n}} \xrightarrow{n \to \infty} \frac{1}{1 - p}$$

</Equation>

</Theorem>

**Proof.** Total time with one processor is $T_1 = T_{\text{serial}} + T_{\text{parallel}}$. With $n$ processors, the parallel part speeds up by $n$: $T_n = T_{\text{serial}} + T_{\text{parallel}}/n = (1-p)T_1 + pT_1/n$. The speedup is $S(n) = T_1/T_n = 1/((1-p) + p/n)$. $\square$

<Example id="ex-amdahl">
**Distributed training overhead.** Suppose 5% of your training pipeline is serial (data loading on rank 0, gradient synchronization latency, logging, checkpointing). Then:
- With 8 GPUs: $S(8) = 1/(0.05 + 0.95/8) = 1/0.169 \approx 5.9\times$ (74% efficiency)
- With 64 GPUs: $S(64) = 1/(0.05 + 0.95/64) = 1/0.065 \approx 15.4\times$ (24% efficiency)
- Theoretical maximum: $S(\infty) = 1/0.05 = 20\times$

This shows why scaling beyond a certain point yields diminishing returns. The 5% serial fraction caps the speedup at $20\times$ no matter how many GPUs are added.
</Example>

<Example id="ex-amdahl-pipeline-bubble">
**Pipeline parallelism bubble.** In pipeline parallelism with $p$ stages and $m$ micro-batches, the pipeline "bubble" (time where some stages are idle) takes a fraction $\frac{p-1}{m + p - 1}$ of total time. For $p = 8$ stages and $m = 32$ micro-batches, the bubble is $7/39 \approx 18\%$, limiting pipeline speedup to roughly $8 \times 0.82 = 6.6\times$.
</Example>

## Gustafson's Law: Scaling the Problem

<Theorem id="thm-gustafson" name="Gustafson's Law">
Amdahl's law assumes a fixed problem size. **Gustafson's law** assumes fixed execution time and asks: how much more work can $n$ processors accomplish?

<Equation id="eq-gustafson">

$$S(n) = n - (1 - p)(n - 1) = 1 + p(n - 1)$$

</Equation>

This gives a *scaled speedup* that grows linearly with $n$ when $p$ is close to 1.
</Theorem>

<Remark id="rmk-gustafson-ml">
Gustafson's law is the more relevant model for ML. With more GPUs, we do not just train the same model faster -- we train *larger models* or on *more data*. A model trained on 1024 GPUs is not the same workload as on 1 GPU scaled up; it is a fundamentally larger problem. This is why large-scale training achieves near-linear scaling: the serial fraction shrinks as the problem grows.
</Remark>

## Distributed Linear Algebra

Large matrix operations are distributed across devices by partitioning the matrices. Three fundamental parallelism strategies exist:

<Definition id="def-data-parallelism" name="Data Parallelism">
Each of $N$ devices holds a complete copy of the model parameters $W$. The dataset is sharded so device $i$ processes mini-batch $X_i$. Forward and backward passes run independently. Gradients are synchronized via **allreduce** before the optimizer step:

<Equation id="eq-allreduce-grad">

$$\nabla W = \frac{1}{N} \sum_{i=1}^{N} \nabla_W \mathcal{L}(f(X_i; W), Y_i)$$

</Equation>

The effective batch size scales as $N \times B_{\text{local}}$, where $B_{\text{local}}$ is the per-device batch size.
</Definition>

<Remark id="rmk-data-parallel-memory">
Data parallelism does not reduce per-device memory for model parameters and optimizer states -- each device holds a full copy. For a model with $P$ parameters in FP32 with Adam optimizer, per-device memory is $\approx 16P$ bytes ($4P$ parameters + $4P$ gradients + $4P$ first moments + $4P$ second moments). **ZeRO** [@rajbhandari2020zero] shards these across devices, reducing per-device memory to $\approx 16P/N$ bytes.
</Remark>

<Definition id="def-tensor-parallelism" name="Tensor Parallelism">
A single weight matrix $W \in \mathbb{R}^{m \times n}$ is partitioned across $k$ devices. The two most common partitioning schemes are:

**Column-parallel:** $W = [W_1 | W_2 | \cdots | W_k]$ where $W_i \in \mathbb{R}^{m \times n/k}$. Each device computes $Y_i = XW_i$, producing a shard of the output. An **allgather** reconstructs the full output.

**Row-parallel:** $W = \begin{bmatrix} W_1 \\ W_2 \\ \vdots \\ W_k \end{bmatrix}$ where $W_i \in \mathbb{R}^{m/k \times n}$. Input $X$ is sharded accordingly, and each device computes $Y_i = X_i W_i$. A **reduce-scatter** (or allreduce) combines partial sums.
</Definition>

<Remark id="rmk-megatron-tp">
Megatron-LM [@shoeybi2019megatron] pairs column-parallel in the first linear layer of a transformer FFN with row-parallel in the second, so only one allreduce per FFN block is needed (instead of two allgather + reduce-scatter pairs). This is a key insight that reduces communication by 50%.
</Remark>

<Definition id="def-pipeline-parallelism" name="Pipeline Parallelism">
The model's $L$ layers are partitioned into $p$ contiguous stages across $p$ devices. Device $i$ owns layers $\ell_{i-1}+1$ through $\ell_i$ and processes activations sequentially:

<Equation id="eq-pipeline">

$$h^{(\ell)} = f_\ell(h^{(\ell-1)}), \quad \ell = 1, \ldots, L$$

</Equation>

To minimize the pipeline bubble, the mini-batch is split into $m$ **micro-batches** that are pipelined through the stages. GPipe [@huang2019gpipe] accumulates gradients across micro-batches; PipeDream [@narayanan2019pipedream] uses asynchronous weight updates.
</Definition>

## Communication Primitives

<Table id="tab-comm-primitives" caption="Collective communication primitives used in distributed ML.">

| Primitive | Operation | Bandwidth Cost | Latency Cost | Used In |
|-----------|-----------|---------------|-------------|---------|
| **Broadcast** | Copy from one device to all | $m$ | $O(\log N)$ | Distributing initial weights |
| **Reduce** | Aggregate all to one | $m$ | $O(\log N)$ | Collecting global loss |
| **Allreduce** | Reduce + broadcast | $\frac{2(N-1)}{N} m$ | $O(\log N)$ | Gradient sync (DDP) |
| **Allgather** | Gather shards to all | $\frac{N-1}{N} m$ | $O(\log N)$ | Tensor parallelism output |
| **Reduce-scatter** | Reduce + scatter result | $\frac{N-1}{N} m$ | $O(\log N)$ | ZeRO, tensor parallelism |
| **All-to-all** | Each device sends shard to each | $\frac{N-1}{N} m$ | $O(N)$ | Expert parallelism (MoE) |

</Table>

Note: bandwidth costs are per device. $m$ is the total message size in bytes, $N$ is the number of devices.

<Definition id="def-ring-allreduce" name="Ring Allreduce">
The **ring allreduce** algorithm arranges $N$ devices in a logical ring. It proceeds in two phases:

1. **Reduce-scatter phase:** In $N-1$ steps, each device sends one chunk ($m/N$ bytes) to its neighbor and accumulates the received chunk. After this phase, each device holds the fully reduced version of one chunk.
2. **Allgather phase:** In $N-1$ steps, each device propagates its fully reduced chunk around the ring.

Total bandwidth per device: $2 \cdot \frac{N-1}{N} \cdot m$ bytes. This is bandwidth-optimal -- it matches the information-theoretic lower bound.
</Definition>

<Example id="ex-allreduce-cost">
**Allreduce cost for gradient sync.** A 70B parameter model with FP16 gradients has $m = 70 \times 10^9 \times 2 = 140$ GB of gradient data. With 8 GPUs on NVLink (900 GB/s bidirectional per link):
- Ring allreduce bandwidth per device: $2 \times \frac{7}{8} \times 140 = 245$ GB
- Time: $245 / 450 \approx 0.54$ seconds (using half-duplex bandwidth per direction)
- This is why gradient accumulation (computing multiple forward/backward passes before synchronizing) is used to amortize communication cost.
</Example>

## Communication--Computation Overlap

<Definition id="def-overlap" name="Communication-Computation Overlap">
Modern distributed training frameworks overlap communication with computation by splitting the backward pass into chunks. As gradients for layer $\ell$ are computed, allreduce for layer $\ell+1$ (already completed) proceeds concurrently:

<Equation id="eq-overlap">

$$T_{\text{total}} = T_{\text{compute}} + T_{\text{comm}} - T_{\text{overlap}} \leq \max(T_{\text{compute}}, T_{\text{comm}})$$

</Equation>

Perfect overlap is achieved when $T_{\text{compute}} \geq T_{\text{comm}}$, i.e., when the computation for each chunk takes longer than the communication for the previous chunk.
</Definition>

<Remark id="rmk-scaling-efficiency">
**Scaling efficiency** is defined as $\eta = S(N) / N$ where $S(N)$ is the actual speedup with $N$ devices. State-of-the-art distributed training achieves $\eta > 0.9$ for hundreds of GPUs by:

1. Using fast interconnects (NVLink within a node, InfiniBand across nodes)
2. Overlapping allreduce with backward computation
3. Using large batch sizes to increase the compute-to-communication ratio
4. Combining data, tensor, and pipeline parallelism (3D parallelism) to minimize total communication

For example, training LLaMA-65B on 2048 A100 GPUs achieved ~50% MFU (Model FLOP Utilization), meaning half the theoretical peak compute was utilized -- the rest was lost to communication, pipeline bubbles, and memory-bound operations [@touvron2023llama].
</Remark>

## Notation Summary

<Table id="tab-notation-hpc" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $p$ | Parallel fraction (Amdahl) or number of pipeline stages |
| $N$ | Number of processors/devices |
| $S(N)$ | Speedup with $N$ processors |
| $\eta$ | Scaling efficiency: $S(N)/N$ |
| $m$ | Message size (bytes) |
| $B_{\text{local}}$ | Per-device batch size |
| $F$ | Device compute throughput (FLOPS) |
| $B$ | Interconnect bandwidth (bytes/s) |
| MFU | Model FLOP Utilization |
| SIMD, SIMT, SPMD | Parallel execution models |
| DDP | Distributed Data Parallel |
| FSDP / ZeRO | Fully Sharded Data Parallel / Zero Redundancy Optimizer |

</Table>
