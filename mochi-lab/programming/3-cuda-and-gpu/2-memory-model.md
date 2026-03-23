---
sidebar_position: 2
---

# Memory Model

Understanding the GPU memory hierarchy is the single most important skill for writing fast CUDA kernels. The difference between a naive kernel and an optimized one is often 10-100x, and nearly all of that difference comes from how data is accessed. This chapter covers the memory hierarchy, coalescing rules, shared memory, bank conflicts, and occupancy.

## Memory Hierarchy

<Table id="tab-gpu-mem-hierarchy" caption="GPU memory hierarchy with latencies, bandwidths, and scope.">

| Memory | Scope | Size (H100) | Latency | Bandwidth | Read/Write |
|--------|-------|-------------|---------|-----------|-----------|
| Registers | Per thread | ~255 x 32-bit per thread | ~1 cycle | ~20 TB/s | R/W |
| Shared Memory | Per block | Up to 228 KB per SM | ~20-30 cycles | ~12 TB/s | R/W |
| L1 Cache | Per SM | Combined with shared | ~30 cycles | Automatic | Read (mostly) |
| L2 Cache | Per device | 50 MB | ~30-100 cycles | ~12 TB/s | R/W |
| Global Memory (HBM) | Per device | 80 GB | ~300 cycles | ~3350 GB/s | R/W |
| Constant Memory | Per device | 64 KB | ~5 cycles (cached) | High | Read only |
| Texture Memory | Per device | = Global | ~5 cycles (cached) | High (cached) | Read only |

</Table>

<Remark id="rmk-memory-hierarchy-strategy">
**The optimization strategy is always the same:** move data from slow memory to fast memory, use it as many times as possible, then discard it. Specifically:

1. **Global -> Shared:** Load a tile of data into shared memory. Cost: ~300 cycles per element.
2. **Shared -> Registers:** Each thread loads its portion. Cost: ~20 cycles per element.
3. **Registers -> Compute:** Perform operations. Cost: ~1 cycle per operation.
4. **Registers -> Shared -> Global:** Write results back out.

The arithmetic intensity of your kernel determines which level matters most. For memory-bound kernels, minimizing global memory accesses is paramount. For compute-bound kernels (GEMM), maximizing register reuse is key.
</Remark>

## Global Memory and Coalescing

Global memory (HBM) is the main GPU memory. Access happens in 128-byte **transactions** (or 32-byte L2 sectors). When 32 threads in a warp access consecutive addresses, the hardware **coalesces** them into a minimal number of transactions:

<Code id="code-memory-model-1" caption="Coalesced vs uncoalesced global memory access patterns.">

```cuda
// COALESCED: threads access consecutive 4-byte elements (FAST)
// Thread 0 reads a[0], thread 1 reads a[1], ..., thread 31 reads a[31]
// -> One 128-byte transaction
float val = a[threadIdx.x + blockIdx.x * blockDim.x];

// STRIDED: threads access every N-th element (SLOW)
// Thread 0 reads a[0], thread 1 reads a[stride], thread 2 reads a[2*stride]...
// -> Up to 32 separate 128-byte transactions (one per thread)
float val = a[(threadIdx.x + blockIdx.x * blockDim.x) * stride];

// RANDOM: threads access arbitrary addresses (WORST)
// Each thread may trigger its own transaction
float val = a[indices[threadIdx.x]];
```

</Code>

<Table id="tab-coalescing-patterns" caption="Memory access patterns and their efficiency.">

| Pattern | Example | Transactions per Warp (32 floats) | Efficiency |
|---------|---------|----------------------------------|-----------|
| Coalesced (stride 1) | `a[tid]` | 1 (128 bytes) | 100% |
| Stride 2 | `a[tid * 2]` | 2 | 50% |
| Stride 32 | `a[tid * 32]` | 32 | 3% |
| Random | `a[random[tid]]` | Up to 32 | ~3-10% |
| Broadcast (all same) | `a[0]` | 1 | 100% (but no parallelism) |

</Table>

<Remark id="rmk-memory-model-1">
**Tip:** Always access global memory in a coalesced pattern. For 2D data stored in row-major order, iterate over columns in the inner loop (adjacent threads read adjacent memory).
</Remark>

## Shared Memory

Shared memory is fast, on-chip memory accessible by all threads in a block:

<Code id="code-memory-model-2" caption="Shared memory is fast, on-chip memory accessible by all threads in a block.">

```cuda
__global__ void shmem_example(float* input, float* output, int n) {
    __shared__ float tile[256];  // Shared by all threads in this block

    int tid = threadIdx.x + blockIdx.x * blockDim.x;

    // Load from global to shared
    if (tid < n) {
        tile[threadIdx.x] = input[tid];
    }
    __syncthreads();  // Barrier: wait for all threads to finish loading

    // Now all threads can read any element in the tile
    if (tid < n && threadIdx.x > 0) {
        output[tid] = tile[threadIdx.x] + tile[threadIdx.x - 1];
    }
}
```

</Code>

<Remark id="rmk-memory-model-2">
**Warning:** Always call `__syncthreads()` after writing to shared memory and before reading. Without it, some threads may read stale data.
</Remark>

## Bank Conflicts

Shared memory is divided into 32 **banks**. Consecutive 4-byte words go to consecutive banks. If two threads in a warp access the same bank (but different addresses), the accesses are **serialized**:

<Code id="code-memory-model-3" caption="Shared memory is divided into 32 banks.">

```cuda
// No bank conflict: consecutive access
tile[threadIdx.x]           // Thread k accesses bank k % 32

// Bank conflict: stride-2 access
tile[threadIdx.x * 2]       // Thread 0 and 16 both access bank 0

// No conflict: broadcast (same address)
tile[0]                     // All threads read the same address (broadcast)
```

</Code>

<Remark id="rmk-memory-model-3">
**Padding to avoid bank conflicts.** The classic fix: add one extra element per row:

```cuda
// CONFLICT: 32 threads accessing column 0 of a 32-wide array
// Thread k accesses tile[k][0] -> bank = (k * 32) % 32 = 0 (all same bank!)
__shared__ float tile[32][32];

// NO CONFLICT: padding shifts each row by 1 bank
// Thread k accesses tile[k][0] -> bank = (k * 33) % 32 = k (all different banks!)
__shared__ float tile[32][33];  // Extra column for padding
```

This wastes `32 * 4 = 128` bytes of shared memory but eliminates all bank conflicts for column access patterns.
</Remark>

## Registers

Registers are the fastest memory but also the most limited. Each thread can use up to 255 32-bit registers on modern GPUs. Using more registers per thread reduces the number of threads that can be active on an SM (occupancy), which reduces the GPU's ability to hide memory latency.

<Code id="code-register-usage" caption="Register pressure and its effect on occupancy.">

```cuda
// Few registers: high occupancy, good for memory-bound kernels
__global__ void low_register_kernel(float* a, float* b, float* c, int n) {
    int tid = threadIdx.x + blockIdx.x * blockDim.x;
    if (tid < n) c[tid] = a[tid] + b[tid];
    // Uses ~8 registers per thread -> high occupancy
}

// Many registers: low occupancy, good for compute-bound kernels
__global__ void high_register_kernel(float* A, float* B, float* C, int N) {
    // Each thread computes a 4x4 tile, accumulating in 16 register variables
    float acc[4][4] = {0};   // 16 float registers just for accumulation
    float a_frag[4];          // 4 registers for A fragment
    float b_frag[4];          // 4 registers for B fragment
    // ... tiling logic ...
    // Uses ~40+ registers per thread -> lower occupancy, but higher compute throughput
}

// Control register usage with launch bounds
__global__ void __launch_bounds__(256, 2)  // 256 threads/block, min 2 blocks/SM
my_kernel(...) {
    // Compiler will limit registers to fit 2 blocks of 256 threads per SM
}
```

</Code>

## Occupancy

**Occupancy** is the ratio of active warps to the maximum warps per SM. Higher occupancy helps hide memory latency:

$$
\text{Occupancy} = \frac{\text{Active warps per SM}}{\text{Max warps per SM}}
$$

Occupancy is limited by three resources:

<Table id="tab-memory-model-1" caption="Resources that limit occupancy and their tradeoffs.">

| Resource | Limit per SM (H100) | How It Limits Occupancy | Diagnosis |
|----------|-------------------|----------------------|-----------|
| Threads | 2048 (64 warps) | More threads/block = fewer blocks fit | `ncu --set full` reports achieved occupancy |
| Registers | 65536 x 32-bit | More registers/thread = fewer threads | `ncu` reports register usage per thread |
| Shared memory | 228 KB | More shared/block = fewer blocks fit | `ncu` reports shared memory per block |

</Table>

<Remark id="rmk-occupancy-tradeoff">
**Occupancy vs. efficiency tradeoff.** Higher occupancy helps the GPU hide memory latency by having more warps to switch between. But lower occupancy can be faster if each thread does more useful work per memory access:

| Approach | Occupancy | Per-Thread Efficiency | Best For |
|----------|-----------|----------------------|----------|
| Many threads, few registers | High (75-100%) | Low (simple computation) | Memory-bound kernels (elementwise, reduction) |
| Fewer threads, many registers | Low (25-50%) | High (complex computation) | Compute-bound kernels (tiled GEMM) |
| Balance | Medium (50-75%) | Medium | Most practical kernels |

Use Nsight Compute's occupancy calculator to find the sweet spot. Often, 50% occupancy with good register usage outperforms 100% occupancy with register spilling.
</Remark>
