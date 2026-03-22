---
sidebar_position: 2
---

# Memory Model

## Memory Hierarchy

```
Registers     (per thread)    ~255 registers      ~1 cycle
Shared Memory (per block)     up to 228 KB/SM     ~5 cycles
L1 Cache      (per SM)        configurable        ~30 cycles
L2 Cache      (per device)    ~40 MB              ~100 cycles
Global Memory (HBM)           80 GB               ~300 cycles
```

## Global Memory and Coalescing

Global memory (HBM) is the main GPU memory. Access happens in 128-byte **transactions**. When 32 threads in a warp access consecutive addresses, the hardware **coalesces** them into a single transaction:

```cuda
// Coalesced: threads access consecutive elements (FAST)
// Thread 0 reads a[0], thread 1 reads a[1], ...
float val = a[threadIdx.x + blockIdx.x * blockDim.x];

// Strided: threads access every N-th element (SLOW)
// Thread 0 reads a[0], thread 1 reads a[N], ...
float val = a[(threadIdx.x + blockIdx.x * blockDim.x) * stride];
```

**Tip:** Always access global memory in a coalesced pattern. For 2D data stored in row-major order, iterate over columns in the inner loop (adjacent threads read adjacent memory).

## Shared Memory

Shared memory is fast, on-chip memory accessible by all threads in a block:

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

**Warning:** Always call `__syncthreads()` after writing to shared memory and before reading. Without it, some threads may read stale data.

## Bank Conflicts

Shared memory is divided into 32 **banks**. Consecutive 4-byte words go to consecutive banks. If two threads in a warp access the same bank (but different addresses), the accesses are **serialized**:

```cuda
// No bank conflict: consecutive access
tile[threadIdx.x]           // Thread k accesses bank k % 32

// Bank conflict: stride-2 access
tile[threadIdx.x * 2]       // Thread 0 and 16 both access bank 0

// No conflict: broadcast (same address)
tile[0]                     // All threads read the same address (broadcast)
```

**Tip:** Pad shared memory arrays to avoid bank conflicts: `__shared__ float tile[32][33]` instead of `[32][32]`. The extra column shifts bank assignments.

## Occupancy

**Occupancy** is the ratio of active warps to the maximum warps per SM. Higher occupancy helps hide memory latency:

$$
\text{Occupancy} = \frac{\text{Active warps per SM}}{\text{Max warps per SM}}
$$

Occupancy is limited by three resources:

| Resource | Limit per SM (A100) | Effect |
|----------|-------------------|--------|
| Threads | 2048 | More threads per block reduces max blocks |
| Registers | 65536 | More registers per thread = fewer threads |
| Shared memory | 164 KB | More shared memory per block = fewer blocks |

```bash
# Check occupancy with CUDA Occupancy Calculator
# Or use the CUDA profiler:
ncu --set full ./my_kernel
```

**Tip:** 100% occupancy is not always optimal. Sometimes using more registers or shared memory per thread (lower occupancy) gives better performance because each thread does more useful work per memory access.
