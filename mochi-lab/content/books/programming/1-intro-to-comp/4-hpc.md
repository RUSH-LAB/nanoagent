---
sidebar_position: 4
---

# High-Performance Computing

Training large models requires distributing computation across multiple GPUs and nodes. This chapter covers the communication primitives, network topologies, and profiling techniques that underpin distributed ML systems. Understanding these fundamentals is essential for scaling training beyond a single GPU, which, at the frontier of ML research, means everything from 8-GPU nodes to 10,000+ GPU clusters.

## MPI: Message Passing Interface

MPI is the standard for distributed computing, developed in the 1990s and still the backbone of HPC. Each process (**rank**) has its own memory and communicates via explicit messages. There is no shared memory between ranks: all data sharing is intentional and visible in the code.

<Code id="code-mpi-example" caption="Basic MPI point-to-point and collective communication in Python.">

```python
from mpi4py import MPI
import numpy as np

comm = MPI.COMM_WORLD
rank = comm.Get_rank()    # Which process am I? (0, 1, ..., size-1)
size = comm.Get_size()    # Total number of processes

# Point-to-point: rank 0 sends to rank 1
if rank == 0:
    data = np.array([1.0, 2.0, 3.0])
    comm.Send(data, dest=1, tag=0)        # Blocking send
    print(f"Rank 0 sent {data}")
elif rank == 1:
    data = np.empty(3)
    comm.Recv(data, source=0, tag=0)      # Blocking receive
    print(f"Rank 1 received {data}")

# Collective: broadcast from rank 0 to all
if rank == 0:
    config = {'lr': 0.001, 'batch_size': 32}
else:
    config = None
config = comm.bcast(config, root=0)       # All ranks now have config
```

</Code>

<Remark id="rmk-mpi-vs-nccl">
**MPI vs. NCCL.** In modern ML training, you will rarely write raw MPI code. PyTorch's `torch.distributed` abstracts the communication layer, and for GPU-to-GPU communication, it uses **NCCL** (NVIDIA Collective Communications Library) rather than MPI. NCCL is optimized for GPU memory and NVLink/NVSwitch interconnects, achieving near-peak bandwidth.

However, understanding MPI concepts (ranks, communicators, collectives) is essential because `torch.distributed` uses the same abstractions:

| MPI Concept | PyTorch Equivalent |
|-------------|-------------------|
| `MPI.COMM_WORLD` | `torch.distributed.init_process_group()` |
| `rank = comm.Get_rank()` | `rank = dist.get_rank()` |
| `comm.Allreduce(...)` | `dist.all_reduce(tensor)` |
| `comm.Bcast(...)` | `dist.broadcast(tensor, src=0)` |
| Communicator groups | `dist.new_group(ranks)` |
</Remark>

## NCCL: GPU Collective Communication

NCCL is purpose-built for GPU-to-GPU communication, automatically selecting the fastest available transport:

<Table id="tab-gpu-interconnects" caption="GPU interconnect technologies and their bandwidths.">

| Interconnect | Bandwidth (per direction) | Latency | Topology | Use Case |
|-------------|--------------------------|---------|----------|----------|
| PCIe Gen4 x16 | 32 GB/s | ~1 us | Point-to-point | CPU-GPU, multi-GPU (budget) |
| PCIe Gen5 x16 | 64 GB/s | ~1 us | Point-to-point | CPU-GPU, modern systems |
| NVLink 3.0 (A100) | 300 GB/s (per GPU) | ~1 us | Mesh | Intra-node GPU-GPU |
| NVLink 4.0 (H100) | 450 GB/s (per GPU) | ~1 us | NVSwitch full bisection | Intra-node GPU-GPU |
| NVLink 5.0 (B200) | 900 GB/s (per GPU) | ~1 us | NVSwitch | Intra-node GPU-GPU |
| InfiniBand HDR | 200 Gb/s (25 GB/s) | ~1 us | Fat-tree/Dragonfly | Inter-node |
| InfiniBand NDR | 400 Gb/s (50 GB/s) | ~1 us | Fat-tree/Dragonfly | Inter-node |
| RoCE v2 | 100-400 Gb/s | ~2 us | Ethernet-based RDMA | Inter-node (cheaper) |

</Table>

All bandwidths in this table are **per direction** (unidirectional). NVLink is most commonly quoted as a bidirectional total, which is twice the per-GPU figure shown here: A100 at 600 GB/s, H100 at 900 GB/s, and B200 at 1.8 TB/s bidirectional. Watch for this convention when comparing against vendor specs, since the H100 bidirectional headline (900 GB/s) collides numerically with the B200 unidirectional figure listed above.

<Code id="code-nccl-allreduce" caption="NCCL-backed all-reduce for gradient synchronization in PyTorch.">

```python
import torch
import torch.distributed as dist
import os

# Initialize process group (one process per GPU)
dist.init_process_group(
    backend='nccl',                           # Use NCCL for GPU communication
    init_method='env://',                      # Read MASTER_ADDR, MASTER_PORT from env
    world_size=int(os.environ['WORLD_SIZE']),  # Total number of GPUs
    rank=int(os.environ['RANK']),              # This GPU's rank
)
torch.cuda.set_device(int(os.environ['LOCAL_RANK']))

# All-reduce: sum gradients across all GPUs
gradient = torch.randn(1000, device='cuda')
dist.all_reduce(gradient, op=dist.ReduceOp.SUM)  # In-place sum
gradient /= dist.get_world_size()                 # Average gradients

# Typical launch: torchrun --nproc_per_node=8 --nnodes=4 train.py
```

</Code>

<Remark id="rmk-nccl-environment">
**NCCL environment variables.** Performance-critical NCCL settings:

| Variable | Effect | Typical Value |
|----------|--------|--------------|
| `NCCL_DEBUG=INFO` | Print topology and algorithm selection | Debug only |
| `NCCL_IB_DISABLE=1` | Force TCP instead of InfiniBand | Testing only |
| `NCCL_SOCKET_IFNAME=eth0` | Select network interface | Multi-NIC systems |
| `NCCL_ALGO=Ring` | Force ring algorithm | Override auto-selection |
| `NCCL_NTHREADS=512` | NCCL kernel thread count | Fine-tuning |
| `NCCL_BUFFSIZE=4194304` | Internal buffer size | Large messages |
| `TORCH_NCCL_ASYNC_ERROR_HANDLING=1` | Detect NCCL errors asynchronously | Always recommended |
</Remark>

## Collective Operations

Collective operations are the building blocks of distributed ML. Each collective has a precise communication pattern:

<Code id="code-collectives" caption="Visual representation of distributed collective operations (4 ranks).">

```
Broadcast (root → all):   One rank sends its data to every other rank
  Rank 0: [A B C D]    →    Rank 0: [A B C D]
  Rank 1: [. . . .]    →    Rank 1: [A B C D]
  Rank 2: [. . . .]    →    Rank 2: [A B C D]
  Rank 3: [. . . .]    →    Rank 3: [A B C D]
  Use: distributing model weights at initialization

Scatter (root → shards):   Root splits its data evenly across ranks
  Rank 0: [A B C D]    →    Rank 0: [A]
                        →    Rank 1: [B]
                        →    Rank 2: [C]
                        →    Rank 3: [D]
  Use: distributing different data shards for processing

Gather (shards → root):   Root collects data from all ranks
  Rank 0: [A]           →    Rank 0: [A B C D]
  Rank 1: [B]
  Rank 2: [C]
  Rank 3: [D]
  Use: collecting results after parallel processing

AllGather (shards → all):   Every rank gets the full concatenated data
  Rank 0: [A]           →    Rank 0: [A B C D]
  Rank 1: [B]           →    Rank 1: [A B C D]
  Rank 2: [C]           →    Rank 2: [A B C D]
  Rank 3: [D]           →    Rank 3: [A B C D]
  Use: tensor parallelism (gathering activations after parallel linear layers)

Reduce (all → root):   Combines data from all ranks using an operation (sum, max)
  Rank 0: [1 2 3]       →    Rank 0: [10 14 18]
  Rank 1: [2 3 4]
  Rank 2: [3 4 5]
  Rank 3: [4 5 6]
  Use: aggregating metrics (loss, accuracy) on rank 0

AllReduce (reduce + broadcast):   Every rank gets the reduced result
  Rank 0: [1 2 3]       →    Rank 0: [10 14 18]
  Rank 1: [2 3 4]       →    Rank 1: [10 14 18]
  Rank 2: [3 4 5]       →    Rank 2: [10 14 18]
  Rank 3: [4 5 6]       →    Rank 3: [10 14 18]
  Use: gradient synchronization in data-parallel training (DDP)

ReduceScatter (reduce + scatter):   Each rank gets a shard of the reduced result
  Rank 0: [1 2 3 4]     →    Rank 0: [10]
  Rank 1: [2 3 4 5]     →    Rank 1: [14]
  Rank 2: [3 4 5 6]     →    Rank 2: [18]
  Rank 3: [4 5 6 7]     →    Rank 3: [22]
  Use: FSDP/ZeRO (each rank stores only its shard of gradients)
```

</Code>

<Table id="tab-collective-costs" caption="Communication cost of collective operations (N ranks, M bytes per rank).">

| Collective | Data Transferred per Rank | Latency Steps | ML Use |
|-----------|--------------------------|---------------|--------|
| Broadcast | $M$ | $\log N$ | Weight initialization, hyperparams |
| Scatter/Gather | $M$ | $\log N$ | Data distribution |
| AllGather | $M \cdot (N-1)/N$ | $N-1$ (ring) | Tensor parallelism |
| Reduce | $M$ | $\log N$ | Metric aggregation |
| AllReduce | $2M \cdot (N-1)/N$ | $2(N-1)$ (ring) | DDP gradient sync |
| ReduceScatter | $M \cdot (N-1)/N$ | $N-1$ (ring) | FSDP/ZeRO gradient sync |

</Table>

## Ring AllReduce

The bandwidth-optimal algorithm for AllReduce uses a ring topology. It is the default algorithm for DDP gradient synchronization:

<Code id="code-ring-allreduce-detail" caption="Ring AllReduce in two phases: reduce-scatter then all-gather.">

```
Phase 1: Reduce-Scatter (N-1 steps)
  Each rank sends one chunk to its right neighbor; received chunks are summed

  Step 1:  Rank 0 → Rank 1 → Rank 2 → Rank 3 → Rank 0 (ring)
           Each sends chunk 0, receives and reduces chunk 3 (from left)

  Step 2:  Each sends its newly reduced chunk, receives and reduces another

  Step 3:  After N-1 steps, each rank holds one fully-reduced chunk

Phase 2: All-Gather (N-1 steps)
  Each rank sends its fully-reduced chunk around the ring

  After N-1 more steps, every rank has all fully-reduced chunks

Total: 2(N-1) steps, each transferring M/N bytes
Total data per rank: 2 * (N-1)/N * M bytes ≈ 2M for large N
```

</Code>

<Code id="code-ring-allreduce" caption="PyTorch DistributedDataParallel handles AllReduce automatically.">

```python
# PyTorch handles ring AllReduce automatically with DDP
model = torch.nn.parallel.DistributedDataParallel(
    model,
    device_ids=[local_rank],
    output_device=local_rank,
    find_unused_parameters=False,  # Set True only if needed (adds overhead)
)
# Gradients are all-reduced automatically during backward()
# DDP buckets gradients and overlaps communication with backward computation
```

</Code>

<Remark id="rmk-ring-allreduce-cost">
**Ring AllReduce is bandwidth-optimal.** Each rank sends and receives exactly $2 \cdot (N-1)/N \cdot M$ bytes total, which approaches $2M$ regardless of the number of nodes. This means the AllReduce time is:

$$T_{\text{AllReduce}} = 2(N-1) \cdot \alpha + 2 \cdot \frac{N-1}{N} \cdot \frac{M}{\beta}$$

where $\alpha$ is the per-message latency and $\beta$ is the per-link bandwidth. For large messages ($M \gg \alpha \cdot \beta$), the time is dominated by the bandwidth term and is independent of $N$. This is why DDP scales well with the number of GPUs for large models.

**When ring AllReduce does not scale:** For small messages (small gradients), the latency term $2(N-1) \cdot \alpha$ dominates. Tree algorithms reduce this to $2 \log N \cdot \alpha$ at the cost of suboptimal bandwidth. NCCL automatically selects the best algorithm based on message size and topology.
</Remark>

<Example id="ex-allreduce-nvlink">
**AllReduce on a single NVLink node.** Consider data-parallel training on $N = 8$ H100 GPUs in one node, synchronizing a gradient of $M = 1\ \text{GB} = 10^9$ bytes per step. From [](#tab-gpu-interconnects), NVLink 4.0 gives $\beta = 450\ \text{GB/s} = 4.5 \times 10^{11}$ bytes/s per direction, and we take a per-message latency of $\alpha = 1\ \mu\text{s} = 10^{-6}\ \text{s}$.

Plug into the cost model $T_{\text{AllReduce}} = 2(N-1)\alpha + 2 \cdot \frac{N-1}{N} \cdot \frac{M}{\beta}$:

- **Latency term:** $2(N-1)\alpha = 2 \cdot 7 \cdot 10^{-6} = 1.4 \times 10^{-5}\ \text{s} = 0.014\ \text{ms}$.
- **Bandwidth term:** $2 \cdot \frac{7}{8} \cdot \frac{10^9}{4.5 \times 10^{11}} = 1.75 \cdot 2.22 \times 10^{-3} = 3.89 \times 10^{-3}\ \text{s} = 3.89\ \text{ms}$.
- **Total:** $T_{\text{AllReduce}} \approx 3.90\ \text{ms}$, dominated entirely by bandwidth (the latency term is under $0.4\%$).

Now suppose each step does $T_{\text{compute}} = 100\ \text{ms}$ of backward work per GPU (an illustrative figure). With no communication-computation overlap, the per-step time is $T_N \approx 100 + 3.90 = 103.90\ \text{ms}$, giving a scaling efficiency of $\frac{T_{\text{compute}}}{T_{\text{compute}} + T_{\text{AllReduce}}} = \frac{100}{103.90} \approx 96.2\%$. Overlapping the AllReduce with the backward pass (see [](#rmk-overlap-tuning)) pushes this even closer to $100\%$.
</Example>

<Example id="ex-allreduce-infiniband">
**Faded example: the same AllReduce across nodes.** Now move the eight GPUs to eight separate nodes connected by InfiniBand NDR. From [](#tab-gpu-interconnects), $\beta = 50\ \text{GB/s} = 5 \times 10^{10}$ bytes/s per direction; keep $N = 8$, $M = 10^9$ bytes, and take $\alpha = 1\ \mu\text{s}$ to match the InfiniBand NDR row of [](#tab-gpu-interconnects). The latency term is again negligible ($2 \cdot 7 \cdot 1 \times 10^{-6} = 0.014\ \text{ms}$), so the bandwidth term sets the cost:

$$T_{\text{AllReduce}} = 2 \cdot \frac{N-1}{N} \cdot \frac{M}{\beta} + (\text{latency term}) = 2 \cdot \frac{7}{8} \cdot \frac{10^9}{5 \times 10^{10}} + 0.014\ \text{ms} = \underline{\phantom{35.0}}\ \text{ms}.$$

Filling in the blank gives $1.75 \cdot 0.02\ \text{s} = 35.0\ \text{ms}$ (about $9\times$ the NVLink result, matching the $6\text{-}9\times$ interconnect gap noted later in [](#rmk-scaling-efficiency)). With the same $100\ \text{ms}$ of compute and no overlap, the scaling efficiency drops to $\frac{100}{100 + 35.0} \approx 74\%$, which is why cross-node data parallelism leans so heavily on overlap, gradient bucketing, and faster interconnects.
</Example>

## Distributed Training Topologies

<Table id="tab-dist-topologies" caption="Distributed training communication topologies and their properties.">

| Topology | Bandwidth | Latency | Scalability | Use Case |
|----------|-----------|---------|-------------|----------|
| Ring AllReduce | Optimal: $2M(N-1)/N$ | $O(N)$ steps | Good (bandwidth-limited) | DDP, same node or homogeneous cluster |
| Tree AllReduce | Sub-optimal: $M \log N$ | $O(\log N)$ steps | Good (latency-limited) | Cross-node, small messages |
| Recursive halving-doubling | Optimal | $O(\log N)$ steps | Excellent | NCCL default for medium messages |
| Parameter Server | Centralized | $O(1)$ round-trips | Poor (server bottleneck) | Async SGD, legacy systems |
| Hierarchical | Optimal within, tree across | Mixed | Excellent | Multi-node GPU clusters |

</Table>

<Remark id="rmk-topology-selection">
**How NCCL selects algorithms.** NCCL profiles the interconnect topology at initialization and automatically selects the best algorithm:

- **Small messages (< 256 KB):** Tree algorithm (latency-optimal)
- **Medium messages (256 KB - 4 MB):** Recursive halving-doubling
- **Large messages (> 4 MB):** Ring algorithm (bandwidth-optimal)
- **NVSwitch systems (DGX H100):** Direct all-to-all via NVSwitch (bypasses ring overhead)

You can override with `NCCL_ALGO=Ring|Tree|CollNet` but the automatic selection is almost always correct.
</Remark>

## Network Topology and Bandwidth

<Remark id="rmk-network-topology">
**Understanding cluster network topology.** Large GPU clusters use a **fat-tree** or **rail-optimized** network topology:

```
Fat-tree topology (simplified):
                    Core Switches
                   /      |      \
              Spine 0  Spine 1  Spine 2
             /    \   /    \   /    \
          Leaf0  Leaf1  Leaf2  Leaf3  ...
          /  \    /  \   /  \   /  \
        N0   N1  N2  N3  N4  N5  N6  N7    (Nodes, each with 8 GPUs)

Rail-optimized topology:
  GPU 0 in each node → Switch 0   (all GPU 0s share a network)
  GPU 1 in each node → Switch 1   (all GPU 1s share a network)
  ...
  GPU 7 in each node → Switch 7
```

The key performance question: **bisection bandwidth**, the total bandwidth across the narrowest point that cuts the network in half. Insufficient bisection bandwidth causes congestion during AllReduce, which shows up as variable step times and degraded scaling efficiency.
</Remark>

## Communication-Computation Overlap

The key to efficient distributed training is **overlapping communication with computation**, so that gradient synchronization happens while the backward pass is still computing other gradients:

<Code id="code-overlap" caption="DDP gradient bucketing and overlap with backward computation.">

```
Timeline of a DDP backward pass:

Layer N:    [Backward compute]  [AllReduce bucket 3 ←→ Compute overlap]
Layer N-1:  [Backward compute]  [AllReduce bucket 2 ←→ Compute overlap]
Layer N-2:  [Backward compute]  [AllReduce bucket 1 ←→ ]
Layer 1:    [Backward compute]  [AllReduce bucket 0]

DDP groups gradients into buckets (default: 25 MiB each).
When a bucket is full, its AllReduce begins immediately,
overlapping with backward computation of earlier layers.
```

</Code>

<Remark id="rmk-overlap-tuning">
**Tuning overlap.** The `bucket_cap_mb` parameter in DDP controls the tradeoff:
- **Larger buckets (50-100 MB):** Better bandwidth efficiency (each AllReduce moves more data), but less overlap opportunity (more compute finishes before the AllReduce starts).
- **Smaller buckets (5-10 MB):** More overlap opportunity (AllReduce starts sooner), but higher latency overhead (more AllReduce operations).

For most workloads, the default (25 MiB) works well. Increase it for very large models with many small parameters; decrease it for small models where you want maximum overlap.
</Remark>

## Profiling Distributed Training

<Code id="code-nsys-profiling" caption="Using nsys to profile distributed CUDA training workloads.">

```bash
# Profile a distributed training script
nsys profile \
    -o report_rank${RANK} \
    --trace=cuda,nvtx,nccl,osrt \
    --cuda-graph-trace=node \
    python -m torch.distributed.run \
        --nproc_per_node=8 \
        train.py

# View the report (GUI)
nsys-ui report_rank0.nsys-rep

# View summary statistics (CLI)
nsys stats report_rank0.nsys-rep

# Key sections to examine:
# 1. CUDA Kernel Summary:  Are kernels large enough? (duration > 10 us)
# 2. NCCL Summary:         How much time in communication?
# 3. GPU Gaps:             Are there idle periods between kernels?
# 4. Memory Copies:        Are there unnecessary H2D/D2H transfers?
```

</Code>

<Remark id="rmk-pytorch-profiler">
**PyTorch Profiler vs nsys.** Both are useful but serve different purposes:

| Tool | Strengths | Best For |
|------|----------|---------|
| `torch.profiler` | Python-level stack traces, memory tracking, TensorBoard integration | Understanding which PyTorch ops are slow |
| `nsys` | Hardware-level timeline, NCCL traces, GPU kernel details | Understanding *why* ops are slow (memory stalls, kernel config) |
| `ncu` (Nsight Compute) | Per-kernel analysis: occupancy, memory throughput, instruction mix | Optimizing individual CUDA kernels |

```python
# PyTorch Profiler example
with torch.profiler.profile(
    activities=[
        torch.profiler.ProfilerActivity.CPU,
        torch.profiler.ProfilerActivity.CUDA,
    ],
    schedule=torch.profiler.schedule(wait=1, warmup=1, active=3),
    on_trace_ready=torch.profiler.tensorboard_trace_handler('./log'),
    with_stack=True,          # Include Python stack traces
    record_shapes=True,       # Record tensor shapes
    profile_memory=True,      # Track memory allocations
) as prof:
    for step, batch in enumerate(dataloader):
        loss = train_step(batch)
        prof.step()  # Mark step boundary
```
</Remark>

<Table id="tab-profiling-bottlenecks" caption="Common training bottlenecks: symptoms, diagnosis, and fixes.">

| Problem | Symptom in Profile | How to Diagnose | Fix |
|---------|-------------------|----------------|-----|
| Low GPU utilization | Long CPU gaps between kernels | nsys timeline shows idle GPU | Async data loading, prefetch, pin_memory=True |
| Communication bound | NCCL > 30% of step time | nsys NCCL summary | Gradient compression, increase batch size, overlap |
| Memory bound | Small kernels, high memory bandwidth | ncu shows low compute throughput | Operator fusion, torch.compile |
| Kernel launch bound | Many tiny kernels (< 5 us each) | nsys shows launch overhead | torch.compile, CUDA graphs |
| Data loading bound | GPU idle at start of each step | CPU time > GPU time | More workers, faster storage, prefetch |
| Memory allocation | `cudaMalloc` in profile | Memory allocator traces | Use memory pool, avoid dynamic allocation |
| Synchronization | `cudaDeviceSynchronize` calls | CPU blocks waiting for GPU | Remove explicit syncs, use async ops |

</Table>

<Remark id="rmk-scaling-efficiency">
**Measuring scaling efficiency.** The key metric for distributed training is **scaling efficiency**:

$$\text{Scaling Efficiency} = \frac{T_1}{N \cdot T_N}$$

where $T_1$ is the time per step with 1 GPU and $T_N$ is the time per step with $N$ GPUs. Perfect scaling gives efficiency = 1.0 (100%).

| Efficiency | Interpretation | Typical Cause |
|-----------|---------------|--------------|
| > 95% | Excellent | Large models, fast interconnect |
| 80-95% | Good | Most well-optimized workloads |
| 60-80% | Acceptable | Communication overhead or load imbalance |
| < 60% | Poor | Insufficient compute-to-communication ratio |

**Common causes of poor scaling:**
1. **Small batch per GPU:** Not enough compute to overlap with communication.
2. **Many small parameters:** High AllReduce latency overhead.
3. **Cross-node communication:** InfiniBand (~50 GB/s) is 6-9x slower than NVLink (~300-450 GB/s).
4. **Load imbalance:** One rank takes longer than others, causing all ranks to wait.
5. **Data loading:** Disk I/O does not scale with GPU count.
</Remark>

<Remark id="rmk-nvidia-smi">
**Quick health check with nvidia-smi.** Before diving into detailed profiling, a quick `nvidia-smi` check can identify obvious problems:

```bash
# Real-time monitoring (refresh every 1 second)
nvidia-smi dmon -s u -d 1

# Key columns:
# sm   : SM utilization (target: > 80%)
# mem  : Memory controller utilization
# enc  : Encoder utilization (not relevant for ML)
# dec  : Decoder utilization (not relevant for ML)

# Memory usage
nvidia-smi --query-gpu=memory.used,memory.total --format=csv

# If SM utilization < 80%, you likely have a bottleneck outside GPU compute
# (data loading, CPU preprocessing, communication, or kernel launch overhead)
```
</Remark>
