---
sidebar_position: 3
---

# Optimization

## Warp Divergence

All 32 threads in a warp execute the same instruction. When threads take different branches, both paths are executed with threads masked:

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

## Tiling for Matrix Multiplication

Naive matrix multiply has poor data reuse. **Tiling** loads sub-matrices into shared memory:

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

The tiled version reads each element from global memory once per tile instead of once per output element, reducing global memory accesses by a factor of `TILE`.

## Parallel Reduction

Summing an array in parallel:

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

**Tip:** For the final warp (32 threads), you can skip `__syncthreads()` and use `__shfl_down_sync` for faster warp-level reduction:

```cuda
// Warp-level reduction (no shared memory needed)
float val = ...;
for (int offset = 16; offset > 0; offset >>= 1) {
    val += __shfl_down_sync(0xFFFFFFFF, val, offset);
}
// Thread 0 of each warp now has the sum
```

## CUDA Streams

Streams enable concurrent execution of kernels and memory copies:

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

## Profiling

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

| Metric | What it tells you | Good value |
|--------|------------------|------------|
| SM % | GPU compute utilization | > 80% |
| Memory BW % | Memory bandwidth utilization | > 60% |
| Occupancy | Warps hiding latency | > 50% |
| L2 hit rate | Cache effectiveness | > 50% |
