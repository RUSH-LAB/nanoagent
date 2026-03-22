---
sidebar_position: 4
---

# High-Performance Computing

## MPI: Message Passing Interface

MPI is the standard for distributed computing. Each process (rank) has its own memory and communicates via messages:

```python
from mpi4py import MPI

comm = MPI.COMM_WORLD
rank = comm.Get_rank()   # Which process am I? (0, 1, 2, ...)
size = comm.Get_size()   # Total number of processes

# Point-to-point communication
if rank == 0:
    comm.send(data, dest=1, tag=0)
elif rank == 1:
    data = comm.recv(source=0, tag=0)
```

## NCCL: GPU Collective Communication

NCCL (NVIDIA Collective Communications Library) is optimized for GPU-to-GPU communication:

```python
import torch
import torch.distributed as dist

# Initialize process group (one process per GPU)
dist.init_process_group(backend='nccl')

# All-reduce: sum gradients across all GPUs
tensor = torch.randn(1000, device='cuda')
dist.all_reduce(tensor, op=dist.ReduceOp.SUM)
tensor /= dist.get_world_size()  # Average
```

## Collective Operations

```
Broadcast (root -> all):
  Rank 0: [A B C D]    -->  Rank 0: [A B C D]
  Rank 1: [. . . .]    -->  Rank 1: [A B C D]
  Rank 2: [. . . .]    -->  Rank 2: [A B C D]

Scatter (root -> shards):
  Rank 0: [A B C D]    -->  Rank 0: [A]
                        -->  Rank 1: [B]
                        -->  Rank 2: [C]

Gather (shards -> root):
  Rank 0: [A]           -->  Rank 0: [A B C]
  Rank 1: [B]           -->
  Rank 2: [C]           -->

AllReduce (reduce + broadcast):
  Rank 0: [1 2 3]       -->  Rank 0: [6 9 12]
  Rank 1: [2 3 4]       -->  Rank 1: [6 9 12]
  Rank 2: [3 4 5]       -->  Rank 2: [6 9 12]

ReduceScatter (reduce + scatter):
  Rank 0: [1 2 3]       -->  Rank 0: [6]
  Rank 1: [2 3 4]       -->  Rank 1: [9]
  Rank 2: [3 4 5]       -->  Rank 2: [12]
```

## Ring AllReduce

The bandwidth-optimal algorithm for AllReduce uses a ring topology:

```
Step 1: Each rank sends a shard to the next rank
  Rank 0 --> Rank 1 --> Rank 2 --> Rank 0

Step 2: Repeat N-1 times (reduce-scatter phase)
Step 3: Repeat N-1 times (all-gather phase)
Total: 2(N-1) steps, each transferring M/N data
```

```python
# PyTorch handles this automatically with DistributedDataParallel
model = torch.nn.parallel.DistributedDataParallel(
    model,
    device_ids=[local_rank],
)
# Gradients are all-reduced automatically during backward()
```

**Tip:** Ring AllReduce transfers `2 * (N-1)/N * M` total bytes, which approaches `2M` regardless of the number of nodes. This is bandwidth-optimal.

## Distributed Training Topologies

| Topology | Use Case | Communication |
|----------|----------|--------------|
| Ring AllReduce | DDP, same-node | Bandwidth-optimal |
| Tree AllReduce | Cross-node | Lower latency |
| Parameter Server | Async SGD | Centralized but scalable |
| Hierarchical | Multi-node GPU | Ring within node, tree across nodes |

## Profiling with nsys

```bash
# Profile a training script
nsys profile -o report python train.py

# View the report
nsys stats report.nsys-rep

# Key metrics to look for:
# - CUDA kernel time vs. CPU time (GPU utilization)
# - Memory copy time (H2D, D2H transfers)
# - NCCL collective time (communication overhead)
# - Kernel launch gaps (pipeline bubbles)
```

Common bottlenecks:

```
Problem              | Symptom                  | Fix
---------------------|--------------------------|---------------------------
Low GPU utilization  | Long CPU gaps            | Async data loading, prefetch
Communication bound  | NCCL > 30% of step time  | Gradient compression, overlap
Memory bound         | Small kernels, high BW   | Operator fusion, larger batch
Kernel launch bound  | Many tiny kernels        | torch.compile, CUDA graphs
```

**Tip:** Run `nvidia-smi dmon -s u` during training to monitor GPU utilization in real time. If SM utilization is below 80%, you likely have a bottleneck outside of GPU compute.
