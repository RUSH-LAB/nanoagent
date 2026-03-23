---
sidebar_position: 3
---

# Optimization

The difference between a naive CUDA kernel and an optimized one can be 10-100x. This chapter covers the key optimization techniques: eliminating warp divergence, tiling for data reuse, parallel reduction, asynchronous execution with streams, and profiling with NVIDIA tools. Each technique addresses a specific performance bottleneck.

## Warp Divergence

All 32 threads in a warp execute the same instruction. When threads take different branches, both paths are executed with threads masked:

<Code id="code-optimization-1" caption="All 32 threads in a warp execute the same instruction.">

```cuda
// Divergent: threads in the same warp take different branches
if (threadIdx.x % 2 == 0) {
    // Even threads execute this (odd threads are idle)
    a[tid] = expensive_function(a[tid]);
} else {
    // Odd threads execute this (even threads are idle)
    a[tid] = other_function(a[tid]);
}
// Total time: cost of BOTH branches (not one)

// Better: group work by warp boundaries
if (threadIdx.x < 16) {
    // First half-warp: different warps, no divergence within a warp
    ...
}
```

</Code>

## Tiling for Matrix Multiplication

Naive matrix multiply has poor data reuse. **Tiling** loads sub-matrices into shared memory:

<Code id="code-optimization-2" caption="Naive matrix multiply has poor data reuse.">

```cuda
#define TILE 16

__global__ void matmul_tiled(float* A, float* B, float* C, int N) {
    __shared__ float As[TILE][TILE];
    __shared__ float Bs[TILE][TILE];

    int row = blockIdx.y * TILE + threadIdx.y;
    int col = blockIdx.x * TILE + threadIdx.x;
    float sum = 0.0f;

    for (int t = 0; t < N / TILE; t++) {
        // Load tiles into shared memory
        As[threadIdx.y][threadIdx.x] = A[row * N + t * TILE + threadIdx.x];
        Bs[threadIdx.y][threadIdx.x] = B[(t * TILE + threadIdx.y) * N + col];
        __syncthreads();

        // Compute partial dot product from shared memory
        for (int k = 0; k < TILE; k++) {
            sum += As[threadIdx.y][k] * Bs[k][threadIdx.x];
        }
        __syncthreads();
    }

    C[row * N + col] = sum;
}
```

</Code>

The tiled version reads each element from global memory once per tile instead of once per output element, reducing global memory accesses by a factor of `TILE`.

<Remark id="rmk-tiling-analysis">
**Tiling analysis for matrix multiplication.**

| Version | Global Memory Reads per Output | FLOPS per Read | Arithmetic Intensity |
|---------|-------------------------------|----------------|---------------------|
| Naive ($N \times N$) | $2N$ reads per output element | 1 FLOP per read | 0.25 FLOPS/byte |
| Tiled ($T \times T$ tiles) | $2N/T$ reads per output element | $T$ FLOPS per read | $T/8$ FLOPS/byte |
| Tiled ($T=16$) | $N/8$ reads | 16 FLOPS per read | 2 FLOPS/byte |
| Tiled ($T=32$) | $N/16$ reads | 32 FLOPS per read | 4 FLOPS/byte |

For a 1024x1024 matrix with $T=16$: global memory reads decrease by 16x compared to naive. On H100, the ridge point (where compute meets bandwidth) for FP32 is ~20 FLOPS/byte, so even tiled FP32 GEMM is memory-bound. Using Tensor Cores (FP16) shifts the ridge point, making tiled GEMM compute-bound.
</Remark>

## Parallel Reduction

Summing an array in parallel:

<Code id="code-optimization-3" caption="Summing an array in parallel.">

```cuda
__global__ void reduce_sum(float* input, float* output, int n) {
    __shared__ float sdata[256];

    int tid = threadIdx.x;
    int i = blockIdx.x * blockDim.x + threadIdx.x;

    sdata[tid] = (i < n) ? input[i] : 0.0f;
    __syncthreads();

    // Tree reduction in shared memory
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            sdata[tid] += sdata[tid + s];
        }
        __syncthreads();
    }

    if (tid == 0) output[blockIdx.x] = sdata[0];
}
```

</Code>

<Remark id="rmk-optimization-1">
**Tip:** For the final warp (32 threads), you can skip `__syncthreads()` and use `__shfl_down_sync` for faster warp-level reduction:
</Remark>

<Code id="code-optimization-4" caption="Tip: For the final warp (32 threads), you can skip `__syncthreads()` and.">

```cuda
// Warp-level reduction (no shared memory needed)
float val = ...;
for (int offset = 16; offset > 0; offset >>= 1) {
    val += __shfl_down_sync(0xFFFFFFFF, val, offset);
}
// Thread 0 of each warp now has the sum
```

</Code>

## CUDA Streams

Streams enable concurrent execution of kernels and memory copies:

<Code id="code-optimization-5" caption="Streams enable concurrent execution of kernels and memory copies.">

```cuda
cudaStream_t stream1, stream2;
cudaStreamCreate(&stream1);
cudaStreamCreate(&stream2);

// These can execute concurrently
cudaMemcpyAsync(d_a, h_a, bytes, cudaMemcpyHostToDevice, stream1);
kernel1<<<grid, block, 0, stream1>>>(d_a);

cudaMemcpyAsync(d_b, h_b, bytes, cudaMemcpyHostToDevice, stream2);
kernel2<<<grid, block, 0, stream2>>>(d_b);

cudaStreamSynchronize(stream1);
cudaStreamSynchronize(stream2);
```

</Code>

## Profiling

<Code id="code-optimization-6" caption="Code example.">

```bash
# NVIDIA Nsight Compute (kernel-level profiling)
ncu --set full ./my_program

# Key metrics:
# - SM Utilization (target: >80%)
# - Memory Throughput (% of peak)
# - Achieved Occupancy
# - Warp Stall Reasons

# NVIDIA Nsight Systems (system-level timeline)
nsys profile -o timeline ./my_program
nsys stats timeline.nsys-rep
```

</Code>

<Table id="tab-optimization-1" caption="Key profiling metrics and their target values.">

| Metric | What It Tells You | Good Value | Poor Value |
|--------|------------------|------------|-----------|
| SM Utilization (%) | How busy the SMs are | > 80% | < 50% (low occupancy or idle GPU) |
| Memory Bandwidth (%) | Fraction of peak HBM bandwidth used | > 60% (memory-bound) | < 20% (not enough data flow) |
| Achieved Occupancy | Active warps / max warps per SM | > 50% | < 25% (too many registers or shared memory) |
| L2 Hit Rate | Cache effectiveness | > 50% | < 20% (poor data reuse) |
| Warp Stall: Memory | Stalled waiting for memory | < 30% | > 50% (memory-bound; need fusion or tiling) |
| Warp Stall: Sync | Stalled at `__syncthreads` | < 10% | > 20% (load imbalance in shared memory) |
| Inst Executed per Cycle | Instructions throughput | > 1.0 | < 0.5 (underutilized execution units) |

</Table>

## Optimization Checklist

<Table id="tab-optimization-checklist" caption="GPU kernel optimization checklist in priority order.">

| Priority | Optimization | Bottleneck Addressed | Expected Speedup |
|----------|-------------|---------------------|-----------------|
| 1 | Coalesced memory access | Memory bandwidth waste | 2-10x |
| 2 | Use shared memory for data reuse | Global memory latency | 2-5x |
| 3 | Eliminate warp divergence | Execution efficiency | 1.5-2x |
| 4 | Avoid bank conflicts | Shared memory throughput | 1.2-2x |
| 5 | Use warp-level primitives (`__shfl`) | Reduction/communication overhead | 1.2-1.5x |
| 6 | Tune occupancy (registers vs threads) | Latency hiding | 1.1-1.5x |
| 7 | Use Tensor Cores (for GEMM) | Compute throughput | 8-16x |
| 8 | Async memory copy (streams) | Pipeline utilization | 1.5-2x |
| 9 | Launch configuration tuning | SM utilization | 1.1-1.3x |

</Table>
