---
sidebar_position: 4
---

# Profiling

## torch.profiler

PyTorch's built-in profiler traces CPU and GPU operations:

<Code id="code-profiling-1" caption="PyTorch's built-in profiler traces CPU and GPU operations.">

```python
import torch
from torch.profiler import profile, record_function, ProfilerActivity

with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    record_shapes=True,
    profile_memory=True,
    with_stack=True,
) as prof:
    with record_function("model_inference"):
        output = model(input)

# Print summary sorted by GPU time
print(prof.key_averages().table(
    sort_by="cuda_time_total", row_limit=20
))

# Export Chrome trace (open in chrome://tracing)
prof.export_chrome_trace("trace.json")

# Export for TensorBoard
prof.export_stacks("profiler_stacks.txt", "self_cuda_time_total")
```

</Code>

## Training Loop Profiling

<Code id="code-profiling-2" caption="Code example.">

```python
from torch.profiler import schedule

with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    schedule=schedule(
        wait=1,      # Skip 1 step (warmup)
        warmup=1,    # Profile 1 step (warmup, not recorded)
        active=3,    # Record 3 steps
        repeat=1,    # Repeat cycle 1 time
    ),
    on_trace_ready=torch.profiler.tensorboard_trace_handler('./log'),
) as prof:
    for step, (data, target) in enumerate(loader):
        if step >= 5:
            break
        output = model(data)
        loss = criterion(output, target)
        loss.backward()
        optimizer.step()
        optimizer.zero_grad()
        prof.step()  # Signal end of step
```

</Code>

## NVIDIA Nsight Systems (nsys)

System-level profiling -- see the full timeline of CPU, GPU, and communication:

<Code id="code-profiling-3" caption="System-level profiling -- see the full timeline of CPU, GPU, and communication.">

```bash
# Profile a training script
nsys profile \
    --trace=cuda,nvtx,osrt \
    --output=report \
    python train.py

# Convert to text summary
nsys stats report.nsys-rep

# Key things to look for:
# 1. GPU idle time (gaps between kernels)
# 2. Data loading bottlenecks (CPU busy, GPU idle)
# 3. Communication overhead (NCCL calls)
# 4. Memory copy time (H2D, D2H)
```

</Code>

## NVIDIA Nsight Compute (ncu)

Kernel-level profiling -- deep dive into a single CUDA kernel:

<Code id="code-profiling-4" caption="Kernel-level profiling -- deep dive into a single CUDA kernel.">

```bash
# Profile specific kernels
ncu --set full \
    --kernel-name "ampere_sgemm" \
    --launch-count 5 \
    python train.py

# Key metrics:
# Compute (SM) Throughput    -> Are we using the ALUs?
# Memory Throughput          -> Are we using the bandwidth?
# Achieved Occupancy         -> Are we hiding latency?
# Warp Stall Reasons         -> Why are warps waiting?
```

</Code>

## The Roofline Model

Determine if your kernel is compute-bound or memory-bound:

```
Arithmetic Intensity (AI) = FLOPs / Bytes accessed

If AI < machine_balance_point:
    Memory-bound -> optimize data movement
If AI > machine_balance_point:
    Compute-bound -> optimize computation

A100 balance point: ~200 FLOPS/byte (FP16 with Tensor Cores)
```

<Table id="tab-profiling-1" caption="A100 balance point: ~200 FLOPS/byte (FP16 with Tensor Cores).">

| Operation | Arithmetic Intensity | Bound |
|-----------|---------------------|-------|
| Element-wise (ReLU) | 0.25 FLOP/byte | Memory |
| Reduction (sum) | 0.25 FLOP/byte | Memory |
| BatchNorm | ~1 FLOP/byte | Memory |
| GEMM (4096x4096) | ~2048 FLOP/byte | Compute |
| Attention (seq=2048) | ~512 FLOP/byte | Compute |

</Table>

## Common Bottlenecks and Fixes

<Table id="tab-profiling-2" caption="## Common Bottlenecks and Fixes.">

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| GPU utilization < 80% | CPU bottleneck | More DataLoader workers, prefetch |
| Many tiny kernels | Launch overhead | `torch.compile`, CUDA Graphs |
| High NCCL time | Communication bound | Overlap compute/comm, gradient compression |
| Low memory bandwidth util | Poor access pattern | Coalesce memory, fuse kernels |
| High memory usage | Large activations | Gradient checkpointing, reduce batch |

</Table>

<Code id="code-profiling-5" caption="Code example.">

```python
# Quick GPU utilization check
import subprocess
result = subprocess.run(
    ['nvidia-smi', '--query-gpu=utilization.gpu',
     '--format=csv,noheader,nounits'],
    capture_output=True, text=True,
)
print(f"GPU utilization: {result.stdout.strip()}%")
```

</Code>

<Remark id="rmk-profiling-1">
**Tip:** Profile first, optimize second. Most training bottlenecks are in data loading, communication, or kernel launch overhead -- not in the model computation itself.
</Remark>
