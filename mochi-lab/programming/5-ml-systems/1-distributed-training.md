---
sidebar_position: 1
---

# Distributed Training

Training large models on a single GPU is either too slow (days instead of hours) or impossible (the model does not fit in memory). Distributed training solves both problems by splitting work across multiple GPUs. The challenge is doing this efficiently -- naively partitioning work introduces communication overhead that can negate the benefit of extra GPUs. This chapter covers the four main strategies (data parallelism, tensor parallelism, pipeline parallelism, and fully sharded data parallelism), the communication patterns they use, and the practical considerations that determine which approach to use.

## Data Parallelism (DDP)

**DistributedDataParallel** (DDP) is the simplest and most commonly used strategy. Each GPU holds a complete copy of the model and processes a different shard of the data. After each backward pass, gradients are **all-reduced** across GPUs so every replica updates identically:

<Code id="code-distributed-training-1" caption="Complete DDP training script. Each GPU runs this function with a different rank.">

```python
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP

def setup(rank, world_size):
    dist.init_process_group("nccl", rank=rank, world_size=world_size)
    torch.cuda.set_device(rank)

def train(rank, world_size):
    setup(rank, world_size)

    model = MyModel().to(rank)
    model = DDP(model, device_ids=[rank])

    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    sampler = torch.utils.data.distributed.DistributedSampler(
        dataset, num_replicas=world_size, rank=rank
    )
    loader = DataLoader(dataset, sampler=sampler, batch_size=32)

    for epoch in range(10):
        sampler.set_epoch(epoch)  # Reshuffle data across GPUs each epoch
        for data, target in loader:
            data, target = data.to(rank), target.to(rank)
            optimizer.zero_grad()
            loss = model(data, target)
            loss.backward()  # Gradients are all-reduced automatically
            optimizer.step()

    dist.destroy_process_group()

# Launch: torchrun --nproc_per_node=4 train.py
```

</Code>

<Remark id="rmk-ddp-internals">
**How DDP overlaps communication with computation.** DDP does not wait until all gradients are computed before communicating. It groups parameters into **buckets** (default 25 MB) and begins all-reducing each bucket as soon as all gradients in that bucket are computed during backward. Because backward computes gradients in reverse order (last layer first), the first bucket communicated contains the last layer's gradients -- which are typically computed first. By the time the optimizer runs, all all-reduce operations are complete.
</Remark>

<Table id="tab-ddp-pitfalls" caption="Common DDP mistakes and their solutions.">

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Forgetting `sampler.set_epoch(epoch)` | All GPUs see same data order every epoch | Call it before each epoch |
| Logging/saving from all ranks | Duplicate checkpoints, garbled logs | Guard with `if rank == 0:` |
| Different batch sizes per rank | Training hangs (collective mismatch) | Use DistributedSampler (handles uneven data) |
| Unused parameters in forward | Hangs during backward (unused grad bucket never fires) | Set `find_unused_parameters=True` (slower) or fix the model |
| Not synchronizing BatchNorm | Each GPU normalizes over local batch only | Use `torch.nn.SyncBatchNorm.convert_sync_batchnorm(model)` |
| Scaling learning rate | Underfitting with more GPUs | Linear scaling rule: multiply LR by world_size (with warmup) |

</Table>

<Remark id="rmk-ddp-scaling">
**The linear scaling rule.** With DDP, each GPU processes `batch_size` samples, so the effective global batch size is `batch_size * world_size`. To maintain the same training dynamics, scale the learning rate proportionally: `lr = base_lr * world_size`. Always combine this with a warmup period (typically 1-5% of training) to stabilize early training with the larger learning rate.
</Remark>

## Model Parallelism

When a model does not fit in a single GPU's memory, you must split the model itself across GPUs. There are three complementary strategies:

<Table id="tab-model-parallelism" caption="Model parallelism strategies: what is split, how communication works, and when to use each.">

| Strategy | What Is Split | Communication Pattern | Memory Savings | Compute Efficiency | When to Use |
|----------|--------------|----------------------|---------------|-------------------|-------------|
| Data parallel (DDP) | Data batches | AllReduce gradients | None (full copy) | Near-linear scaling | Model fits in 1 GPU |
| Tensor parallel (TP) | Weight matrices (columns/rows) | AllReduce or AllGather activations | ~N$\times$ (N = TP degree) | High (if interconnect is fast) | Large layers, NVLink nodes |
| Pipeline parallel (PP) | Model layers | Point-to-point activations | ~N$\times$ (N = PP stages) | Lower (pipeline bubbles) | Many layers, across nodes |
| Sequence parallel (SP) | Sequence dimension | AllGather/ReduceScatter | Activation memory reduction | High | Long sequences, with TP |

</Table>

<Code id="code-tensor-parallel" caption="Tensor parallelism: splitting a linear layer's weight matrix across GPUs.">

```python
# Tensor parallelism splits weight matrices across GPUs.
# For a Linear layer Y = XW + b:

# Column parallel: split W along columns
# GPU 0: Y_0 = X @ W[:, :d//2]     (computes first half of output features)
# GPU 1: Y_1 = X @ W[:, d//2:]     (computes second half of output features)
# -> AllGather Y = [Y_0 | Y_1] to reconstruct full output

# Row parallel: split W along rows
# GPU 0: Y_0 = X_0 @ W[:d//2, :]  (each GPU has partial input)
# GPU 1: Y_1 = X_1 @ W[d//2:, :]
# -> AllReduce Y = Y_0 + Y_1 to combine partial sums

# In practice, column-parallel followed by row-parallel avoids
# an AllGather between layers (Megatron-LM pattern)
```

</Code>

<Code id="code-pipeline-parallel" caption="Pipeline parallelism with PyTorch's pipelining API.">

```python
# Pipeline parallelism: split model into stages across GPUs
from torch.distributed.pipelining import SplitPoint, pipeline

pipe = pipeline(
    model,
    mb_args=(input,),
    split_spec={
        "layer12": SplitPoint.BEGINNING,   # Stage 0: layers 0-11 (GPU 0)
        "layer24": SplitPoint.BEGINNING,   # Stage 1: layers 12-23 (GPU 1)
    },                                      # Stage 2: layers 24+ (GPU 2)
)
```

</Code>

<Remark id="rmk-pipeline-bubbles">
**Pipeline bubbles.** Naive pipeline parallelism wastes $(P-1)/P$ of each GPU's time, where $P$ is the number of pipeline stages, because each GPU must wait for the previous stage's output. **Micro-batching** (splitting each mini-batch into $M$ micro-batches and pipelining them) reduces the bubble to $(P-1)/(P-1+M)$. With $M \gg P$, the bubble becomes negligible. Advanced schedules (1F1B, interleaved 1F1B, zero-bubble) further reduce idle time.
</Remark>

## FSDP (Fully Sharded Data Parallel)

FSDP extends DDP by sharding not just gradients but also parameters and optimizer states across GPUs. Each GPU stores only a shard of the model. Before each layer's forward/backward, the full parameters are gathered; after, they are discarded:

<Code id="code-distributed-training-3" caption="FSDP configuration with mixed precision. Parameters are sharded across GPUs.">

```python
from torch.distributed.fsdp import FullyShardedDataParallel as FSDP
from torch.distributed.fsdp import MixedPrecision, ShardingStrategy

mp_policy = MixedPrecision(
    param_dtype=torch.bfloat16,      # Parameters gathered in BF16
    reduce_dtype=torch.bfloat16,     # Gradient reduction in BF16
    buffer_dtype=torch.bfloat16,     # Buffers (e.g., BatchNorm running stats)
)

model = FSDP(
    model,
    mixed_precision=mp_policy,
    sharding_strategy=ShardingStrategy.FULL_SHARD,  # Shard everything
    use_orig_params=True,  # Required for torch.compile compatibility
    # auto_wrap_policy: controls which submodules get their own FSDP wrapper
    # Each wrapped module gathers/discards parameters independently
)
```

</Code>

<Table id="tab-fsdp-memory" caption="Memory per GPU for a 7B parameter model (FP32 parameters, AdamW optimizer).">

| Component | DDP (1 GPU) | FSDP (4 GPUs) | FSDP (8 GPUs) |
|-----------|------------|---------------|---------------|
| Parameters | 28 GB | 7 GB | 3.5 GB |
| Gradients | 28 GB | 7 GB | 3.5 GB |
| Optimizer states (AdamW: m, v) | 56 GB | 14 GB | 7 GB |
| **Total per GPU** | **112 GB** | **28 GB** | **14 GB** |
| Communication overhead | AllReduce gradients | AllGather params (2x per layer: fwd + bwd) | Same, more shards |

</Table>

<Remark id="rmk-fsdp-vs-ddp">
**When to use FSDP vs DDP.** Use DDP when the model fits comfortably in one GPU's memory (including optimizer states and activations). Switch to FSDP when you run out of memory. FSDP introduces additional AllGather communication (parameters must be gathered before each forward and backward), so it is slower than DDP for models that fit in memory. The communication overhead is typically 5-15% compared to DDP.
</Remark>

## DeepSpeed ZeRO

DeepSpeed's ZeRO (Zero Redundancy Optimizer) provides three progressive stages of memory optimization, equivalent to FSDP but with a different API and additional features:

<Table id="tab-deepspeed-zero" caption="DeepSpeed ZeRO stages and their memory reduction.">

| Stage | What Is Sharded | Memory per GPU | Communication |
|-------|----------------|---------------|---------------|
| ZeRO-1 | Optimizer states only | ~4$\times$ reduction | Same as DDP (AllReduce gradients) |
| ZeRO-2 | Optimizer states + gradients | ~8$\times$ reduction | ReduceScatter gradients |
| ZeRO-3 | Optimizer states + gradients + parameters | ~N$\times$ reduction | AllGather params (like FSDP) |
| ZeRO-Offload | + CPU/NVMe offloading | Train 10$\times$ larger models | CPU-GPU transfer overhead |

</Table>

<Code id="code-distributed-training-4" caption="DeepSpeed ZeRO-3 configuration with CPU offloading.">

```python
# DeepSpeed configuration (ds_config.json)
{
    "bf16": {"enabled": true},
    "zero_optimization": {
        "stage": 3,
        "offload_param": {"device": "cpu", "pin_memory": true},
        "offload_optimizer": {"device": "cpu", "pin_memory": true},
        "overlap_comm": true,
        "contiguous_gradients": true,
        "prefetch_bucket_size": 5e7,
        "param_persistence_threshold": 1e5
    },
    "train_micro_batch_size_per_gpu": 4,
    "gradient_accumulation_steps": 8,
    "gradient_clipping": 1.0
}
```

</Code>

<Remark id="rmk-deepspeed-vs-fsdp">
**FSDP vs DeepSpeed ZeRO-3.** Both achieve the same memory savings through parameter sharding. Key differences:
- **FSDP** is native PyTorch (no external dependency), better integration with `torch.compile`, and is the recommended approach for new projects.
- **DeepSpeed** offers CPU/NVMe offloading (ZeRO-Offload/Infinity), more mature for very large models (100B+), and has additional features like sparse attention and compression.
- For models up to ~13B on 8 GPUs, FSDP is sufficient. For 70B+ models, combine FSDP or DeepSpeed with tensor parallelism.
</Remark>

## 3D Parallelism

For the largest models (70B+), you combine all three strategies:

<Code id="code-3d-parallelism" caption="3D parallelism: combining data, tensor, and pipeline parallelism.">

```
Example: 70B model on 64 GPUs (8 nodes, 8 GPUs each)

Tensor parallel (TP=8):   Split each layer across 8 GPUs within a node (NVLink)
Pipeline parallel (PP=4): Split 80 layers into 4 stages across 4 groups
Data parallel (DP=2):     2 replicas of the full pipeline, each on 32 GPUs

Total: TP(8) x PP(4) x DP(2) = 64 GPUs

Communication:
- TP: AllReduce within node (NVLink, ~900 GB/s) -> fast
- PP: Point-to-point between nodes (InfiniBand, ~400 Gb/s) -> moderate
- DP: AllReduce across DP replicas (InfiniBand) -> infrequent (once per step)
```

</Code>

<Table id="tab-parallelism-decision" caption="Decision guide for choosing parallelism strategy based on model size and hardware.">

| Model Size | GPUs Available | Recommended Strategy |
|-----------|---------------|---------------------|
| < 1B | 1-8 | DDP |
| 1-13B | 4-8 | FSDP or ZeRO-3 |
| 13-70B | 8-64 | FSDP + TP (within node) |
| 70B+ | 64-512 | TP + PP + DP (3D parallelism) |
| 200B+ | 512+ | 3D parallelism + sequence parallelism + expert parallelism |

</Table>
