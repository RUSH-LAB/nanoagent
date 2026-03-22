---
sidebar_position: 1
---

# Your First Kernel

## What Is a CUDA Kernel?

A **kernel** is a function that runs on the GPU, executed by thousands of threads in parallel. The `__global__` keyword marks a function as a kernel.

```cuda
// hello.cu
#include <stdio.h>

__global__ void hello_kernel() {
    int tid = threadIdx.x + blockIdx.x * blockDim.x;
    printf("Hello from thread %d (block %d, thread %d)\n",
           tid, blockIdx.x, threadIdx.x);
}

int main() {
    // Launch 2 blocks of 4 threads each = 8 threads total
    hello_kernel<<<2, 4>>>();
    cudaDeviceSynchronize();  // Wait for GPU to finish
    return 0;
}
```

```bash
# Compile and run
nvcc hello.cu -o hello
./hello
```

## Thread Indexing

Every thread knows its position in the grid:

```cuda
// 1D indexing (most common)
int tid = threadIdx.x + blockIdx.x * blockDim.x;

// 2D indexing (useful for matrices)
int row = threadIdx.y + blockIdx.y * blockDim.y;
int col = threadIdx.x + blockIdx.x * blockDim.x;
int idx = row * width + col;

// Built-in variables:
// threadIdx.x/y/z  -- thread position within block
// blockIdx.x/y/z   -- block position within grid
// blockDim.x/y/z   -- number of threads per block
// gridDim.x/y/z    -- number of blocks in grid
```

## Vector Addition

The "hello world" of GPU programming:

```cuda
__global__ void vec_add(float* a, float* b, float* c, int n) {
    int tid = threadIdx.x + blockIdx.x * blockDim.x;
    if (tid < n) {      // Bounds check (grid may be larger than data)
        c[tid] = a[tid] + b[tid];
    }
}

int main() {
    int n = 1 << 20;  // 1M elements
    size_t bytes = n * sizeof(float);

    // Allocate host memory
    float *h_a = (float*)malloc(bytes);
    float *h_b = (float*)malloc(bytes);
    float *h_c = (float*)malloc(bytes);

    // Initialize
    for (int i = 0; i < n; i++) {
        h_a[i] = 1.0f;
        h_b[i] = 2.0f;
    }

    // Allocate device memory
    float *d_a, *d_b, *d_c;
    cudaMalloc(&d_a, bytes);
    cudaMalloc(&d_b, bytes);
    cudaMalloc(&d_c, bytes);

    // Copy host -> device
    cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_b, h_b, bytes, cudaMemcpyHostToDevice);

    // Launch kernel
    int block_size = 256;
    int grid_size = (n + block_size - 1) / block_size;  // Ceiling division
    vec_add<<<grid_size, block_size>>>(d_a, d_b, d_c, n);

    // Copy device -> host
    cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost);

    // Cleanup
    cudaFree(d_a); cudaFree(d_b); cudaFree(d_c);
    free(h_a); free(h_b); free(h_c);
    return 0;
}
```

**Tip:** The grid size calculation `(n + block_size - 1) / block_size` ensures we launch enough threads even when `n` is not a multiple of `block_size`. The bounds check `if (tid < n)` handles the excess threads.

## Common Patterns

```cuda
// Pattern: stride loop (handle more data than threads)
__global__ void stride_kernel(float* data, int n) {
    int tid = threadIdx.x + blockIdx.x * blockDim.x;
    int stride = blockDim.x * gridDim.x;
    for (int i = tid; i < n; i += stride) {
        data[i] = data[i] * 2.0f;
    }
}

// Pattern: 2D grid for matrix operations
dim3 block(16, 16);  // 256 threads per block
dim3 grid((width + 15) / 16, (height + 15) / 16);
matrix_kernel<<<grid, block>>>(data, width, height);
```

## Error Checking

```cuda
// Always check CUDA calls for errors
#define CUDA_CHECK(call) do {                                    \
    cudaError_t err = call;                                      \
    if (err != cudaSuccess) {                                    \
        fprintf(stderr, "CUDA error at %s:%d: %s\n",            \
                __FILE__, __LINE__, cudaGetErrorString(err));    \
        exit(1);                                                 \
    }                                                            \
} while(0)

// Usage
CUDA_CHECK(cudaMalloc(&d_a, bytes));
CUDA_CHECK(cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice));
```

**Warning:** Kernel launches are asynchronous and do not return errors directly. To catch kernel errors, call `cudaGetLastError()` after the launch and `cudaDeviceSynchronize()` to wait for completion.
