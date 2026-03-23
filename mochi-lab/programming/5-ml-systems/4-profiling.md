---
sidebar_position: 4
---

# Profiling

The most common mistake in ML performance optimization is guessing where the bottleneck is. Profiling replaces guesses with measurements. A training step involves CPU computation (data loading, preprocessing), GPU computation (forward, backward), memory transfers (CPU-GPU, GPU-GPU), and communication (gradient all-reduce, parameter gather). Profiling reveals which of these dominates wall-clock time and where optimization effort will have the most impact. Always profile first, optimize second.

## Profiling Hierarchy

Different tools answer different questions. Start broad (system-level) and narrow down (kernel-level):

<Table id="tab-profiling-tools" caption="Profiling tools from broadest to most granular.">

| Tool | Level | What It Shows | When to Use |
|------|-------|-------------|-------------|
| `nvidia-smi` / `nvitop` | System | GPU utilization, memory, power | Quick health check |
| `torch.profiler` | Framework | Per-op CPU/GPU time, memory, shapes | First profiling pass |
| NVIDIA Nsight Systems (nsys) | System | Full timeline: CPU, GPU, NCCL, memory copies | Identify idle gaps and overlap issues |
| NVIDIA Nsight Compute (ncu) | Kernel | SM utilization, memory throughput, occupancy, stall reasons | Deep dive into a specific slow kernel |
| `torch.cuda.Event` | Manual | Wall-clock time for specific code sections | Micro-benchmarking |

</Table>

## torch.profiler

PyTorch's built-in profiler traces CPU and GPU operations with minimal setup:

<Code id="code-profiling-1" caption="Basic profiling of a model inference or single training step.">

```python
import torch
from torch.profiler import profile, record_function, ProfilerActivity

with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    record_shapes=True,       # Log tensor shapes for each op
    profile_memory=True,      # Track memory allocation/deallocation
    with_stack=True,          # Record Python call stack (slower but useful)
) as prof:
    with record_function("model_forward"):
        output = model(input)
    with record_function("loss_backward"):
        loss = criterion(output, target)
        loss.backward()

# Print summary sorted by GPU time
print(prof.key_averages().table(
    sort_by="cuda_time_total", row_limit=20
))

# Export Chrome trace (open in chrome://tracing or Perfetto)
prof.export_chrome_trace("trace.json")

# Export for TensorBoard
prof.export_stacks("profiler_stacks.txt", "self_cuda_time_total")
```

</Code>

<Remark id="rmk-profiler-output">
**Reading the profiler table.** Key columns in the output:
- **Self CPU time**: Time spent in the operation itself on CPU (excluding children)
- **CPU time total**: Time including children (e.g., a Linear includes matmul + bias)
- **Self CUDA time**: Time spent on GPU (excluding children)
- **CUDA time total**: GPU time including children
- **# Calls**: Number of times the operation was invoked
- **CPU Mem / CUDA Mem**: Memory allocated/freed by this operation

Look for operations with high `Self CUDA time` -- these are the actual compute bottlenecks. High `CPU time total` with low `CUDA time` suggests CPU-side overhead.
</Remark>

## Training Loop Profiling

Profile multiple training steps to capture the full cycle (data loading, forward, backward, optimizer, communication):

<Code id="code-profiling-2" caption="Profiling a training loop with warmup and scheduled recording.">

```python
from torch.profiler import schedule

with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    schedule=schedule(
        wait=1,       # Step 0: skip (cold start)
        warmup=1,     # Step 1: profile but don't record (JIT warmup)
        active=3,     # Steps 2-4: record these steps
        repeat=1,     # Do one cycle of wait+warmup+active
    ),
    on_trace_ready=torch.profiler.tensorboard_trace_handler('./log/profiler'),
    record_shapes=True,
    profile_memory=True,
    with_stack=True,
) as prof:
    for step, (data, target) in enumerate(loader):
        if step >= 5:  # 1 (wait) + 1 (warmup) + 3 (active) = 5 steps
            break
        data, target = data.to(device), target.to(device)
        optimizer.zero_grad()

        with record_function("forward"):
            output = model(data)
            loss = criterion(output, target)
        with record_function("backward"):
            loss.backward()
        with record_function("optimizer"):
            optimizer.step()

        prof.step()  # Signal end of step to scheduler

# View in TensorBoard:
# tensorboard --logdir=./log/profiler
```

</Code>

<Table id="tab-profiler-interpretation" caption="What to look for in training profile results.">

| Observation | Likely Cause | Fix |
|------------|-------------|-----|
| Large gaps between GPU kernels | CPU-side overhead (data loading, Python) | More DataLoader workers, `pin_memory=True`, `torch.compile` |
| One step much slower than others | JIT compilation, first-time allocation | Use warmup steps; check `torch.compile` initial overhead |
| `aten::copy_` dominates | Excessive CPU-GPU data transfer | Preprocess on GPU, use `non_blocking=True` |
| `aten::to` appears frequently | Repeated dtype/device casting | Cast data once, keep on device |
| Forward time >> backward time | Not typical; check for synchronization | Look for `.item()`, `print(tensor)`, or `.cpu()` in forward |
| Backward time >> 2x forward | Gradient checkpointing active (expected) or inefficient backward | Check activation memory vs compute tradeoff |

</Table>

## NVIDIA Nsight Systems (nsys)

`nsys` provides a system-level timeline showing CPU, GPU, NCCL, and memory copy operations on a single timeline. This is the best tool for identifying idle gaps and overlap issues:

<Code id="code-profiling-3" caption="Using nsys to profile a training script with CUDA, NVTX, and OS runtime tracing.">

```bash
# Profile a training script
nsys profile \
    --trace=cuda,nvtx,osrt,cudnn,cublas \
    --cuda-memory-usage=true \
    --output=training_profile \
    --force-overwrite=true \
    python train.py

# Generate text summary from the profile
nsys stats training_profile.nsys-rep

# Key things to look for in the timeline:
# 1. GPU idle gaps       -> CPU is the bottleneck (data loading, Python overhead)
# 2. Long cudaMemcpy     -> Excessive host-device transfers
# 3. NCCL AllReduce      -> Communication overhead (overlap with compute?)
# 4. Many tiny kernels   -> Launch overhead (use torch.compile or CUDA Graphs)
# 5. cudaMalloc calls    -> Memory allocation during training (should use caching)
```

</Code>

<Table id="tab-nsys-patterns" caption="Common patterns in nsys timelines and their diagnoses.">

| Timeline Pattern | Diagnosis | Solution |
|-----------------|-----------|----------|
| GPU idle, CPU busy | Data loading bottleneck | More workers, pin_memory, prefetch_factor |
| GPU idle, CPU idle | Synchronization barrier (NCCL wait) | Overlap compute and communication |
| Many short GPU kernels with gaps | Launch overhead | `torch.compile`, CUDA Graphs |
| Long `cudaMemcpyAsync` blocks | Large host-device transfers | Keep data on GPU, use pinned memory |
| NCCL calls between backward and optimizer | DDP gradient sync not overlapped | Check bucket size, use `gradient_as_bucket_view=True` |
| Backward kernels with large gaps | Compute not overlapping with grad allreduce | Ensure DDP bucketing is configured correctly |

</Table>

<Remark id="rmk-nsys-nvtx">
**Adding custom markers with NVTX.** Use `torch.cuda.nvtx.range_push`/`range_pop` or `record_function` to mark specific code sections in the nsys timeline:

```python
# These markers appear as labeled ranges in the nsys timeline
with torch.cuda.nvtx.range("data_loading"):
    data = next(loader)
with torch.cuda.nvtx.range("forward_pass"):
    output = model(data)
with torch.cuda.nvtx.range("backward_pass"):
    loss.backward()
```
</Remark>

## NVIDIA Nsight Compute (ncu)

`ncu` profiles individual CUDA kernels at maximum detail -- SM utilization, memory throughput, occupancy, warp stall reasons, instruction mix. Use it when nsys identifies a specific slow kernel:

<Code id="code-profiling-4" caption="Using ncu to profile specific CUDA kernels.">

```bash
# Profile specific kernels with full metrics
ncu --set full \
    --kernel-name "ampere_sgemm" \
    --launch-count 5 \
    --target-processes all \
    python train.py

# Profile with specific metrics only (faster)
ncu --metrics \
    sm__throughput.avg.pct_of_peak_sustained_elapsed,\
    dram__throughput.avg.pct_of_peak_sustained_elapsed,\
    gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed \
    --kernel-name "my_kernel" \
    python train.py

# Key metrics to examine:
# Compute (SM) Throughput   -> Are we using the ALUs?
# Memory Throughput         -> Are we saturating memory bandwidth?
# Achieved Occupancy        -> Are we hiding memory latency?
# Warp Stall Reasons        -> Why are warps waiting?
# L1/L2 Hit Rate            -> Is caching effective?
# Registers per Thread      -> Is register pressure limiting occupancy?
```

</Code>

<Table id="tab-ncu-metrics" caption="Key ncu metrics, their target values, and what to do when they are poor.">

| Metric | What It Measures | Good | Poor | Action if Poor |
|--------|-----------------|------|------|---------------|
| SM Throughput (%) | How busy the SMs are | > 80% | < 50% | Increase occupancy, reduce launch overhead |
| Memory Throughput (%) | HBM bandwidth utilization | > 60% (memory-bound) | < 20% | Improve coalescing, fuse kernels |
| Achieved Occupancy | Active warps / max warps per SM | > 50% | < 25% | Reduce registers/shared memory per thread |
| L2 Hit Rate | Cache effectiveness | > 50% | < 20% | Improve data reuse, tiling |
| Warp Stall: Memory | Stalled waiting for memory | < 30% | > 50% | Fuse kernels, use shared memory |
| Warp Stall: Sync | Stalled at `__syncthreads` | < 10% | > 20% | Reduce barriers, balance workload |
| Warp Stall: Not Selected | Warps ready but not scheduled | Some is OK | Dominant | Increase occupancy for latency hiding |
| Instructions per Cycle | Throughput of execution units | > 1.0 | < 0.5 | Memory-bound or insufficient ILP |

</Table>

## The Roofline Model

The roofline model determines whether a kernel is **compute-bound** or **memory-bound** by comparing its arithmetic intensity (FLOPS per byte accessed) to the machine's compute-to-bandwidth ratio:

<Code id="code-roofline" caption="Roofline model: classify operations as compute-bound or memory-bound.">

```
Arithmetic Intensity (AI) = FLOPs performed / Bytes read from memory

Machine balance point = Peak FLOPS / Peak Memory Bandwidth

If AI < balance point:  MEMORY-BOUND  -> optimize data movement (fusion, caching)
If AI > balance point:  COMPUTE-BOUND -> optimize computation (Tensor Cores, tiling)

Example balance points (FP16 Tensor Cores):
  A100: 312 TFLOPS / 2039 GB/s  ≈ 153 FLOPS/byte
  H100: 990 TFLOPS / 3350 GB/s  ≈ 296 FLOPS/byte
```

</Code>

<Table id="tab-arithmetic-intensity" caption="Arithmetic intensity and roofline classification for common ML operations.">

| Operation | FLOPs | Bytes Accessed | Arithmetic Intensity | Classification |
|-----------|-------|---------------|---------------------|---------------|
| ReLU / element-wise | 1 per element | 8 (read + write float) | 0.125 FLOP/byte | Memory-bound |
| Reduction (sum, mean) | 1 per element | 4 (read only) | 0.25 FLOP/byte | Memory-bound |
| Layer norm | ~10 per element | 8 | ~1.25 FLOP/byte | Memory-bound |
| Softmax | ~5 per element | 8 | ~0.6 FLOP/byte | Memory-bound |
| Attention (seq=2K, d=128) | $O(s^2 d)$ | $O(s \cdot d)$ read | ~512 FLOP/byte | Compute-bound |
| GEMM (M=N=K=4096, FP16) | $2 \times 4096^3$ | $3 \times 4096^2 \times 2$ | ~2730 FLOP/byte | Compute-bound |
| Conv2d (large channels) | $2 \times C_{in} \times C_{out} \times K^2 \times H \times W$ | Depends | Usually compute-bound | Compute-bound |

</Table>

<Remark id="rmk-roofline-implications">
**The roofline model tells you what to optimize.** For memory-bound operations (most elementwise and normalization ops), increasing compute throughput (e.g., Tensor Cores) provides no benefit -- you need to reduce memory movement through **kernel fusion** (combine multiple elementwise ops into one kernel that reads/writes memory once). For compute-bound operations (matmul, convolution), increasing compute throughput (reduced precision, Tensor Cores) directly improves performance. `torch.compile` primarily helps by fusing memory-bound operations.
</Remark>

## Micro-Benchmarking with CUDA Events

For precise timing of specific operations, use CUDA events (which synchronize correctly with the GPU):

<Code id="code-cuda-events" caption="Correct GPU timing with CUDA events (not Python time.time).">

```python
# WRONG: Python time.time() does not account for GPU async execution
import time
start = time.time()
output = model(input)  # Returns immediately! GPU still computing
elapsed = time.time() - start  # Measures CPU time, not GPU time

# RIGHT: Use CUDA events for GPU timing
start_event = torch.cuda.Event(enable_timing=True)
end_event = torch.cuda.Event(enable_timing=True)

# Warmup (first run triggers compilation, allocation)
for _ in range(3):
    output = model(input)

torch.cuda.synchronize()
start_event.record()
for _ in range(100):
    output = model(input)
end_event.record()
torch.cuda.synchronize()

elapsed_ms = start_event.elapsed_time(end_event) / 100
print(f"Average forward time: {elapsed_ms:.2f} ms")

# Or use torch.utils.benchmark for proper benchmarking
from torch.utils.benchmark import Timer

timer = Timer(
    stmt="model(input)",
    globals={"model": model, "input": input},
    num_threads=1,
)
result = timer.blocked_autorange(min_run_time=2.0)
print(result)
```

</Code>

## Common Bottlenecks and Fixes

<Table id="tab-bottleneck-diagnosis" caption="Training bottleneck diagnosis and solutions, in order of frequency.">

| Symptom | How to Diagnose | Root Cause | Fix |
|---------|----------------|-----------|-----|
| GPU utilization < 80% | nsys timeline shows GPU idle gaps | CPU data loading bottleneck | More workers, pin_memory, prefetch, DALI |
| Throughput does not scale with GPUs | nsys shows large NCCL time | Communication overhead | Overlap compute/comm, gradient compression, increase batch |
| Many tiny GPU kernels (< 10 us each) | nsys timeline, profiler op count | Python/framework overhead | `torch.compile`, CUDA Graphs, fuse ops |
| OOM despite small model | `torch.cuda.memory_summary()` | Memory fragmentation or leak | `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |
| Forward pass slower than expected | ncu on slow kernel | Suboptimal kernel (memory-bound) | `torch.compile`, FlashAttention, fusion |
| Training slower after adding logging | Profiler, check `.item()` calls | GPU-CPU synchronization | Remove `.item()` from training loop, log every N steps |
| First epoch much slower | nsys shows `cudaMalloc`, JIT compilation | Cold start overhead | Warmup step, pre-allocate with dummy forward |
| Memory grows over time | `torch.cuda.memory_stats()` per step | Memory leak | Check for growing lists, `detach()` tensors stored for logging |

</Table>

<Remark id="rmk-profile-first">
**The profiling workflow.** Follow this order:
1. **nvidia-smi**: Is the GPU even being used? What is the memory utilization?
2. **torch.profiler**: Which operations take the most GPU time? Any unexpected CPU overhead?
3. **nsys**: Where are the gaps in the GPU timeline? Is communication overlapping with compute?
4. **ncu**: For the specific slow kernel identified in steps 2-3, what limits it (compute, memory, occupancy)?

Most training bottlenecks (>60%) are in data loading, communication, or launch overhead -- not in the model computation itself. Profile before optimizing.
</Remark>
