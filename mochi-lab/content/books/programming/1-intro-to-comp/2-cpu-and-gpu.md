---
sidebar_position: 2
---

# CPU and GPU Architecture

CPUs and GPUs solve fundamentally different problems. A CPU is optimized to execute a single thread of instructions as fast as possible -- minimizing the latency of each operation. A GPU is optimized to execute millions of threads simultaneously -- maximizing the throughput of parallel operations. Understanding this distinction is essential for writing efficient ML code, because it determines which operations are fast, which are slow, and why.

## CPU: Optimized for Latency

A CPU core is a marvel of complexity engineering, designed to make *one* thread run as fast as possible:

- **Out-of-order execution** -- reorders instructions to keep all execution units busy, even when some instructions are waiting for data
- **Branch prediction** -- guesses which way branches go to avoid pipeline stalls (>95% accuracy on typical code)
- **Speculative execution** -- executes instructions past predicted branches before the branch is resolved
- **Large caches** -- L1/L2/L3 hierarchy absorbs most memory accesses, reducing effective latency
- **Few powerful cores** -- 8-128 cores, each running 1-2 hardware threads (hyperthreading)

<Code id="code-cpu-layout" caption="Schematic layout of a modern CPU (e.g., AMD EPYC or Intel Xeon).">

```
CPU Core (x 64-128 cores per chip):
+------------------------------------------+
|  Branch Predictor  |  Instruction Fetch   |
|  Decode (4-6 wide) |  Rename/Allocate     |
|--------------------------------------------
|  Execution Units:                         |
|  [ALU] [ALU] [ALU] [AGU] [FPU] [SIMD]   |
|  Out-of-Order Scheduler (up to 256 ops)  |
|--------------------------------------------
|  L1 Data Cache:  48-64 KB  (~1 ns)       |
|  L1 Inst Cache:  32-64 KB                |
|  L2 Cache:       256 KB-2 MB  (~4 ns)    |
+------------------------------------------+
        |
    L3 Cache: 32-64 MB shared (~12 ns)
        |
    DRAM: 256-2048 GB (~100 ns, ~50 GB/s per channel)
```

</Code>

<Remark id="rmk-cpu-transistor-budget">
**Where do the transistors go?** On a modern CPU, roughly 50-60% of the die area is devoted to caches (L1/L2/L3), 20-30% to control logic (branch prediction, out-of-order scheduling, speculation), and only 10-15% to actual computation (ALUs, FPUs). This reflects the latency-optimization strategy: most of the chip exists to feed data quickly to a relatively small number of execution units.

On a GPU, these proportions are inverted: most of the die is computation (CUDA cores, Tensor Cores), with minimal caching and no branch prediction or out-of-order logic. This is why a GPU die can fit thousands of simple cores where a CPU die fits dozens of complex ones.
</Remark>

## GPU: Optimized for Throughput

A GPU trades single-thread performance for massive parallelism. The key design principle is **latency hiding through parallelism**: instead of making each thread fast (CPU approach), the GPU runs so many threads that it always has work to do while some threads are waiting for memory.

- **Simple cores** -- no branch prediction, no out-of-order execution, minimal caches
- **Massive parallelism** -- thousands of threads executing simultaneously, with tens of thousands more ready to be scheduled
- **Wide SIMT execution** -- 32 threads (a **warp**) execute the same instruction in lockstep
- **High bandwidth memory** -- HBM provides 2-3+ TB/s vs ~50 GB/s for CPU DRAM (a 40-60x advantage)
- **Hardware thread scheduling** -- the GPU switches between warps every cycle at zero cost (no context switch overhead)

<Code id="code-gpu-sm-layout" caption="Schematic layout of a GPU Streaming Multiprocessor (SM) on NVIDIA H100.">

```
GPU Streaming Multiprocessor (SM):
+------------------------------------------------------+
|  Warp Scheduler 0    |    Warp Scheduler 1            |
|  Dispatch Unit       |    Dispatch Unit               |
|------------------------------------------------------|
|  32 FP32 Cores | 32 FP32 Cores | 16 FP64 Cores      |
|  16 INT32 Cores| 16 INT32 Cores                      |
|------------------------------------------------------|
|  4th-gen Tensor Cores (FP8/FP16/BF16/TF32/INT8)     |
|  each: 256 FP16 FMAs/cycle or 512 FP8 FMAs/cycle    |
|------------------------------------------------------|
|  Shared Memory / L1 Cache: 228 KB (configurable)     |
|  Register File: 256 KB (65536 x 32-bit registers)    |
|  L0 Instruction Cache                                |
+------------------------------------------------------+
              x 132 SMs on H100 SXM
              = 16896 FP32 cores total
              ~1000 TFLOPS FP8, ~990 TFLOPS FP16 (with sparsity)
```

</Code>

<Remark id="rmk-gpu-latency-hiding">
**How GPUs hide memory latency without caches.** When a warp issues a memory load (300+ cycles to global memory), the CPU approach would be to wait, stalling the pipeline. The GPU approach: switch to another warp that is ready to execute. With 48-64 active warps per SM (1536-2048 threads), there is almost always a warp ready to run. By the time the GPU cycles through all ready warps, the original memory load has completed.

This means GPU performance depends critically on **occupancy** -- the ratio of active warps to maximum warps per SM. Low occupancy (too few threads, too many registers per thread) means the GPU cannot hide memory latency, and performance drops.
</Remark>

## CPU vs GPU: A Quantitative Comparison

<Table id="tab-cpu-vs-gpu" caption="CPU vs GPU comparison for ML workloads (circa 2024).">

| Property | CPU (AMD EPYC 9654) | GPU (NVIDIA H100 SXM) | Ratio |
|----------|-------------------|---------------------|-------|
| Cores | 96 | 16,896 FP32 | 176x |
| Clock speed | 2.4 GHz (base) | 1.83 GHz | 0.76x |
| FP32 throughput | ~4.6 TFLOPS | ~67 TFLOPS | 15x |
| FP16 throughput | ~9.2 TFLOPS (AVX-512) | ~990 TFLOPS (Tensor Cores) | 108x |
| Memory bandwidth | ~460 GB/s (12ch DDR5) | ~3350 GB/s (HBM3) | 7x |
| Memory capacity | 768 GB (max) | 80 GB | 0.1x |
| Memory latency | ~80 ns | ~300 ns (but hidden) | 3.75x |
| Power | 360W | 700W | 2x |
| FLOPS/watt (FP16) | ~26 TFLOPS/W | ~1414 TFLOPS/W | 54x |

</Table>

<Remark id="rmk-when-cpu-wins">
**When CPUs beat GPUs.** Despite GPUs dominating ML training, CPUs are faster for:
- **Small, sequential tasks:** Data preprocessing, tokenization, JSON parsing. The kernel launch overhead (~5 us) makes GPUs slower for operations that complete in microseconds.
- **Irregular, branching computation:** Tree traversal, graph algorithms with irregular access patterns, complex control flow. GPU warp divergence destroys parallelism.
- **Large memory requirements:** Models or datasets that exceed GPU memory (80 GB) but fit in CPU memory (hundreds of GB to TB).
- **I/O-bound tasks:** Reading from disk, network communication, database queries. These are latency-bound, not compute-bound.
- **Single-sample inference:** Inference on one input at a time (e.g., interactive applications) often does not have enough parallelism to saturate a GPU. CPU inference can be faster for small batch sizes.
</Remark>

## Thread Hierarchy (CUDA)

CUDA organizes computation in a hierarchy that maps to the GPU hardware:

<Code id="code-thread-hierarchy" caption="CUDA thread hierarchy: grid, blocks, warps, and threads.">

```
Grid (entire kernel launch)
  |
  +-- Block (0,0)            Block (1,0)            Block (2,0)
  |    |                      |                      |
  |    +-- Warp 0             +-- Warp 0             ...
  |    |    Thread 0-31       |    Thread 0-31
  |    +-- Warp 1             +-- Warp 1
  |    |    Thread 32-63      |    Thread 32-63
  |    +-- Warp 2             +-- Warp 2
  |    |    Thread 64-95      |    Thread 64-95
  |    ...                    ...
  |
  +-- Block (0,1)            Block (1,1)            ...
       ...

Hardware mapping:
  Block --> assigned to one SM (cannot span SMs)
  Warp  --> scheduled by warp scheduler
  Thread --> executed on a CUDA core
```

</Code>

<Table id="tab-thread-levels" caption="CUDA thread hierarchy levels and their resources.">

| Level | Size | Shared Resources | Hardware Mapping |
|-------|------|-----------------|-----------------|
| Thread | 1 | Registers (up to 255 x 32-bit per thread) | One CUDA core |
| Warp | 32 threads | Lock-step execution (SIMT) | One warp scheduler |
| Block | Up to 1024 threads (32 warps) | Shared memory (up to 228 KB), `__syncthreads()` | One SM |
| Grid | Up to $2^{31} - 1$ blocks | Global memory (80 GB HBM) | Entire GPU |

</Table>

<Remark id="rmk-block-size-guidelines">
**Choosing block size.** The block size (threads per block) is the most important configuration choice for a CUDA kernel:

| Block Size | Threads | Warps | Notes |
|-----------|---------|-------|-------|
| 32 | 32 | 1 | Minimum useful; wastes scheduler capacity |
| 128 | 128 | 4 | Good for register-heavy kernels |
| 256 | 256 | 8 | Common default; good balance |
| 512 | 512 | 16 | Good for shared-memory-heavy kernels |
| 1024 | 1024 | 32 | Maximum; limits registers per thread to ~32 |

**Rules of thumb:**
1. Always use a multiple of 32 (warp size). Non-multiples waste execution slots.
2. Use at least 128 threads per block to give the warp scheduler enough work.
3. Use 256 as the default unless you have a reason to change it.
4. Reduce block size if your kernel uses many registers or much shared memory (to increase occupancy by fitting more blocks per SM).
</Remark>

<Remark id="rmk-warp-divergence">
**Warp divergence.** When threads within a warp take different branches of an `if/else`, the GPU must execute *both* paths, masking out the threads that should not participate. This is called **warp divergence** and can halve (or worse) performance:

```c
// BAD: threads in the same warp diverge
if (threadIdx.x % 2 == 0) {
    do_something();    // half the warp active
} else {
    do_other_thing();  // other half active
}
// Total time: time(do_something) + time(do_other_thing)

// BETTER: diverge at warp boundaries
if (threadIdx.x / 32 % 2 == 0) {
    do_something();    // entire warp active
} else {
    do_other_thing();  // entire warp active
}
// Total time: max(time(do_something), time(do_other_thing))
```

In ML kernels, warp divergence typically arises from boundary checks (e.g., last tile in a matrix) or data-dependent operations (e.g., sparse attention). Minimizing these branches is a key optimization.
</Remark>

## GPU Memory Architecture

<Code id="code-gpu-memory" caption="GPU memory hierarchy showing global, shared, and register memory.">

```
+------------------------------------------------------------------+
|                     Global Memory (HBM3)                          |
|                     80 GB, ~3350 GB/s bandwidth                   |
|                     ~300 cycle latency                            |
+------------------------------------------------------------------+
    |                    |                    |
    v                    v                    v
+--L2 Cache: 50 MB, ~12 TB/s bandwidth, ~30 cycles-----------------+
    |                    |                    |
+---------------+  +---------------+  +---------------+
|     SM 0      |  |     SM 1      |  |     SM 2      |
| Shared Memory |  | Shared Memory |  | Shared Memory |
| up to 228 KB  |  | up to 228 KB  |  | up to 228 KB  |
| ~20-30 cycles |  | ~20-30 cycles |  | ~20-30 cycles |
|               |  |               |  |               |
| Register File |  | Register File |  | Register File |
| 256 KB        |  | 256 KB        |  | 256 KB        |
| ~1 cycle      |  | ~1 cycle      |  | ~1 cycle      |
+---------------+  +---------------+  +---------------+
```

</Code>

<Table id="tab-gpu-memory-types" caption="GPU memory types: scope, latency, size, and typical use in ML.">

| Memory | Scope | Latency | Size | Bandwidth | ML Use |
|--------|-------|---------|------|-----------|--------|
| Registers | Thread | ~1 cycle | 256 KB/SM | ~20 TB/s | Intermediate values, loop variables |
| Shared Memory | Block | ~20-30 cycles | Up to 228 KB/SM | ~12 TB/s | Tile buffers for GEMM, reduction intermediates |
| L1 Cache | SM | ~30 cycles | Combined with shared | Automatic | Transparent caching of global reads |
| L2 Cache | Device | ~30 cycles | 50 MB (H100) | ~12 TB/s | Automatic caching layer |
| Global (HBM) | Device | ~300 cycles | 80 GB | ~3350 GB/s | Tensors, weights, activations |
| Constant Memory | Device | ~5 cycles (cached) | 64 KB | High (if cached) | Hyperparameters, lookup tables |

</Table>

<Remark id="rmk-shared-memory-usage">
**Shared memory is the key to fast GPU kernels.** The 10x latency gap between shared memory (~20 cycles) and global memory (~300 cycles) means that loading data into shared memory and reusing it multiple times is the primary optimization technique for GPU kernels. This is the central idea behind:

- **Tiled GEMM:** Load tiles of A and B into shared memory, compute the partial product, and accumulate across tiles. Each element is loaded once from global memory but used $k$ times in computation.
- **FlashAttention:** Process Q, K, V in tiles that fit in shared memory, computing softmax statistics incrementally.
- **Reduction kernels:** First reduce within shared memory (fast), then across blocks via global memory (slow but infrequent).

The shared memory vs. L1 cache split is configurable on most GPUs (e.g., `cudaFuncSetAttribute(..., cudaFuncAttributePreferredSharedMemoryCarveout, 100)` allocates all shared/L1 capacity to shared memory).
</Remark>

## The Roofline Model

<Definition id="def-roofline" name="Roofline Model">
The **roofline model** predicts the maximum achievable performance of an operation based on its **arithmetic intensity** (AI) -- the ratio of FLOPs to bytes transferred from memory:

$$\text{AI} = \frac{\text{FLOPs}}{\text{Bytes transferred}}$$

The maximum performance is:

$$\text{Performance} = \min(\text{Peak FLOPS}, \; \text{AI} \times \text{Memory Bandwidth})$$

Operations with low AI are **memory-bound** (limited by how fast data can be loaded). Operations with high AI are **compute-bound** (limited by how fast the hardware can compute).
</Definition>

<Code id="code-roofline" caption="The roofline model showing the compute-bound and memory-bound regimes.">

```
Performance (TFLOPS)
     |
 990 |                    ____________________________  Peak FP16 Compute (H100)
     |                   /
     |                  /
  67 |                 /____________________________  Peak FP32 Compute
     |                /
     |               /
     |              /  Memory-bound     Compute-bound
     |             /     regime           regime
     |            /
     |           / Slope = Memory Bandwidth (3350 GB/s)
     |          /
     |         /
     |        /
     +--------+------+--+--------------------->
              1      ~20 ~295  Arithmetic Intensity (FLOPS/byte)
            Ridge points (FP32, FP16)
```

</Code>

<Table id="tab-arithmetic-intensity" caption="Arithmetic intensity of common ML operations on H100.">

| Operation | AI (FLOPS/byte) | Bound | Why |
|-----------|----------------|-------|-----|
| Element-wise (ReLU, GELU) | 0.25 | Memory | 1 FLOP per 4 bytes loaded |
| Softmax | ~0.5 | Memory | Few FLOPs per element, multiple passes |
| Layer normalization | ~1 | Memory | Mean + variance + normalize |
| Reduction (sum, mean) | 0.25 | Memory | 1 add per 4 bytes |
| Batch norm | ~2 | Memory | Statistics + normalize |
| Attention ($QK^T$) | ~$d_k/4$ | Depends on $d_k$ | Compute grows with head dim |
| GEMM ($M \times K \times N$) | ~$\frac{2MKN}{4(MK + KN + MN)}$ | Compute (usually) | High reuse of loaded data |
| Conv2D | 10-100+ | Compute | High reuse via im2col or direct |

</Table>

<Remark id="rmk-memory-bound-fix">
**If your operation is memory-bound, adding more compute does not help.** The fixes are:
1. **Operator fusion:** Combine multiple memory-bound operations into one kernel, eliminating intermediate global memory reads/writes.
2. **Quantization:** Using FP16/BF16 instead of FP32 halves memory traffic, effectively doubling bandwidth.
3. **FP8/INT8:** Further reduces memory traffic by 4x compared to FP32.
4. **Increase batch size:** Amortizes weight loading over more data, increasing arithmetic intensity.

If your operation is compute-bound (GEMM), the fix is to use Tensor Cores (FP16/BF16) for a 16x speedup, or FP8 for 32x.
</Remark>

## Tensor Cores

<Definition id="def-tensor-core" name="Tensor Core">
**Tensor Cores** are specialized matrix multiply-accumulate (MMA) units that compute $D = A \times B + C$ on small matrix tiles in a single operation:

| Generation | GPU | Tile Size | Precisions | Peak TFLOPS |
|-----------|-----|-----------|-----------|------------|
| 1st gen | V100 | 4x4x4 | FP16 | 125 |
| 2nd gen | A100 | 8x4x8 | FP16, BF16, TF32, INT8, FP64 | 312 (FP16) |
| 3rd gen | H100 (Hopper) | 16x8x16 | FP16, BF16, TF32, FP8, INT8 | 990 (FP16), 1979 (FP8) |
| 4th gen | B200 (Blackwell) | 16x16x16 | FP16, BF16, TF32, FP8, FP4 | 2250 (FP16), 4500 (FP4) |

</Definition>

<Remark id="rmk-tensor-core-usage">
**When Tensor Cores are used.** Tensor Cores are automatically engaged by cuBLAS when:
1. The operation is a matrix multiply (GEMM, batched GEMM, or convolution via im2col)
2. The data type is FP16, BF16, TF32, FP8, or INT8
3. Matrix dimensions are multiples of 8 (for FP16) or 16 (for FP8)

In PyTorch, you enable Tensor Cores by:
```python
# Use FP16 or BF16 tensors
A = torch.randn(1024, 1024, device='cuda', dtype=torch.float16)
B = torch.randn(1024, 1024, device='cuda', dtype=torch.float16)
C = torch.matmul(A, B)  # Uses Tensor Cores automatically

# Or use torch.autocast for mixed precision
with torch.autocast(device_type='cuda', dtype=torch.bfloat16):
    output = model(input)
```

**If you are using FP32 tensors on H100, you are leaving 15-30x performance on the table.** Always use mixed precision unless you have a specific numerical reason to use FP32.
</Remark>
