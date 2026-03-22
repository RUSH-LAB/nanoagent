---
sidebar_position: 1
---

# Distributed Training

## DistributedDataParallel (DDP)

DDP is the standard approach for multi-GPU training. Each GPU runs a full copy of the model on a shard of the data:

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
        sampler.set_epoch(epoch)
        for data, target in loader:
            data, target = data.to(rank), target.to(rank)
            optimizer.zero_grad()
            loss = model(data, target)
            loss.backward()  # Gradients are all-reduced automatically
            optimizer.step()

# Launch with torchrun
# torchrun --nproc_per_node=4 train.py
```

**Tip:** DDP hooks into the backward pass to overlap gradient all-reduce with backward computation. Gradients are bucketed and communicated in order, so the first gradients computed are communicated while later gradients are still being computed.

## Model Parallelism

When a model does not fit in one GPU's memory:

```python
# Tensor parallelism: split weight matrices across GPUs
# Column parallel: split W along columns, each GPU computes partial output
# Row parallel: split W along rows, each GPU has partial input

# Pipeline parallelism with torch.distributed.pipelining
from torch.distributed.pipelining import SplitPoint, pipeline

pipe = pipeline(
    model,
    mb_args=(input,),
    split_spec={
        "layer12": SplitPoint.BEGINNING,  # Split model at layer 12
        "layer24": SplitPoint.BEGINNING,
    },
)
```

| Strategy | What is split | Communication | Memory savings |
|----------|--------------|---------------|---------------|
| Data parallel (DDP) | Data batches | AllReduce gradients | None (full model copy) |
| Tensor parallel | Weight matrices | AllReduce activations | Linear in TP degree |
| Pipeline parallel | Model layers | Point-to-point activations | Linear in PP degree |
| Sequence parallel | Sequence dimension | AllGather/ReduceScatter | Linear in SP degree |

## FSDP (Fully Sharded Data Parallel)

FSDP shards model parameters, gradients, and optimizer states across GPUs:

```python
from torch.distributed.fsdp import FullyShardedDataParallel as FSDP
from torch.distributed.fsdp import MixedPrecision

mp_policy = MixedPrecision(
    param_dtype=torch.bfloat16,
    reduce_dtype=torch.bfloat16,
    buffer_dtype=torch.bfloat16,
)

model = FSDP(
    model,
    mixed_precision=mp_policy,
    use_orig_params=True,
)
```

Memory comparison for a 7B parameter model:

| Strategy | Parameters | Gradients | Optimizer | Total |
|----------|-----------|-----------|-----------|-------|
| DDP (1 GPU) | 14 GB | 14 GB | 28 GB | 56 GB |
| FSDP (4 GPUs) | 3.5 GB | 3.5 GB | 7 GB | 14 GB/GPU |

## DeepSpeed ZeRO

Similar to FSDP with three stages of sharding:

| Stage | What is sharded | Memory reduction |
|-------|----------------|-----------------|
| ZeRO-1 | Optimizer states | ~4x |
| ZeRO-2 | + Gradients | ~8x |
| ZeRO-3 | + Parameters | ~Nx (N = num GPUs) |

```python
# DeepSpeed configuration (ds_config.json)
{
    "bf16": {"enabled": true},
    "zero_optimization": {
        "stage": 3,
        "offload_param": {"device": "cpu"},
        "offload_optimizer": {"device": "cpu"}
    },
    "train_batch_size": 32
}
```

**Tip:** For models up to ~13B parameters on 8 GPUs, FSDP is usually sufficient. For larger models (70B+), combine FSDP/DeepSpeed with tensor parallelism and pipeline parallelism (3D parallelism).
