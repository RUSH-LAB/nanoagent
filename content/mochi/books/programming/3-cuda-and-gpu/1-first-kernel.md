---
sidebar_position: 1
---

# Your First Kernel

Writing a CUDA kernel is the fundamental skill of GPU programming. Once you understand how to launch a kernel, how threads are indexed, and how to move data between CPU and GPU, you can write any parallel computation. This chapter walks through the complete process: from a "hello world" kernel to a full vector addition with memory management and error checking.

## What Is a CUDA Kernel?

A **kernel** is a function that runs on the GPU, executed by thousands of threads in parallel. The `__global__` keyword marks a function as callable from CPU code but running on the GPU. Each thread executes the same code but on different data: this is the **SIMT** (Single Instruction, Multiple Threads) model.

<Code id="code-first-kernel-1" caption="A minimal CUDA kernel: a __global__ function launched across multiple blocks and threads.">

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

</Code>

```bash
# Compile and run
nvcc hello.cu -o hello
./hello
```

## Thread Indexing

Every thread knows its position in the grid:

<Code id="code-first-kernel-2" caption="Every thread knows its position in the grid.">

```cuda
// 1D indexing (most common)
int tid = threadIdx.x + blockIdx.x * blockDim.x;

// 2D indexing (useful for matrices)
int row = threadIdx.y + blockIdx.y * blockDim.y;
int col = threadIdx.x + blockIdx.x * blockDim.x;
int idx = row * width + col;

// Built-in variables:
// threadIdx.x/y/z  : thread position within block
// blockIdx.x/y/z   : block position within grid
// blockDim.x/y/z   : number of threads per block
// gridDim.x/y/z    : number of blocks in grid
```

</Code>

## Vector Addition

The "hello world" of GPU programming:

<Code id="code-first-kernel-3" caption="The 'hello world' of GPU programming.">

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

</Code>

<Remark id="rmk-first-kernel-1">
**The grid size formula and bounds check pattern.** `(n + block_size - 1) / block_size` is integer ceiling division: it ensures we launch enough threads even when `n` is not a multiple of `block_size`. The bounds check `if (tid < n)` in the kernel handles the excess threads (threads with `tid >= n` do nothing). This two-part pattern appears in essentially every CUDA kernel.
</Remark>

<Example id="ex-vec-add-trace" name="Tracing the index math for a small launch">
Suppose `n = 10` and we pick `block_size = 4`. The grid size is `(10 + 4 - 1) / 4 = 13 / 4 = 3` blocks, so we launch `3 * 4 = 12` threads for 10 elements.

Each thread computes `tid = threadIdx.x + blockIdx.x * blockDim.x`:

| Block | `threadIdx.x` | `tid` | Action |
|-------|---------------|-------|--------|
| 0 | 0, 1, 2, 3 | 0, 1, 2, 3 | `c[tid] = a[tid] + b[tid]` |
| 1 | 0, 1, 2, 3 | 4, 5, 6, 7 | `c[tid] = a[tid] + b[tid]` |
| 2 | 0, 1, 2, 3 | 8, 9, 10, 11 | `tid` 8 and 9 compute; `tid` 10 and 11 fail `tid < n` and exit |

With `a[i] = 1.0` and `b[i] = 2.0`, every valid thread writes `c[tid] = 3.0`, and the two out-of-range threads in block 2 do nothing. This is exactly why the ceiling-division launch and the `if (tid < n)` guard must always travel together.
</Example>

<Table id="tab-cuda-function-qualifiers" caption="CUDA function qualifiers and where they can be called from.">

| Qualifier | Runs On | Callable From | Notes |
|-----------|---------|---------------|-------|
| `__global__` | GPU | CPU (or GPU with dynamic parallelism) | Kernel entry point; must return `void` |
| `__device__` | GPU | GPU only | Helper function called from kernels |
| `__host__` | CPU | CPU only | Normal CPU function (default) |
| `__host__ __device__` | Both | Both | Compiled for both architectures |

</Table>

<Remark id="rmk-kernel-launch-syntax">
<strong>The triple chevron syntax.</strong> The <code>&lt;&lt;&lt;grid, block&gt;&gt;&gt;</code> kernel launch configuration specifies:
- **grid**: number of blocks (can be 1D, 2D, or 3D using `dim3`)
- **block**: threads per block (can be 1D, 2D, or 3D using `dim3`)
- Optional 3rd argument: shared memory bytes (e.g., <code>&lt;&lt;&lt;grid, block, shmem_bytes&gt;&gt;&gt;</code>)
- Optional 4th argument: CUDA stream (e.g., <code>&lt;&lt;&lt;grid, block, 0, stream&gt;&gt;&gt;</code>)

Total threads launched = `grid.x * grid.y * grid.z * block.x * block.y * block.z`.
</Remark>

<Remark id="rmk-hardware-limits">
**Hardware limits on launch configuration.** The CUDA runtime enforces strict limits on kernel launch parameters:

| Parameter | Maximum Value | Notes |
|-----------|-------------|-------|
| Threads per block | 1024 | `block.x * block.y * block.z <= 1024` |
| Block dimension x | 1024 | |
| Block dimension y/z | 1024 / 64 | |
| Grid dimension x | $2^{31} - 1$ | Over 2 billion blocks |
| Grid dimension y/z | 65535 | |

Exceeding these limits causes a silent launch failure: the kernel does not execute and `cudaGetLastError()` returns `cudaErrorInvalidConfiguration`. This is one of the most common beginner mistakes: using a block size of 2048 or a 2D block of `(64, 64)` (which is 4096 threads). Always check `cudaGetLastError()` after every kernel launch.
</Remark>

## Common Patterns

<Code id="code-first-kernel-4" caption="Essential CUDA kernel patterns.">

```cuda
// Pattern 1: stride loop (handle more data than threads)
// When data size >> grid size, each thread processes multiple elements
__global__ void stride_kernel(float* data, int n) {
    int tid = threadIdx.x + blockIdx.x * blockDim.x;
    int stride = blockDim.x * gridDim.x;  // Total number of threads
    for (int i = tid; i < n; i += stride) {
        data[i] = data[i] * 2.0f;
    }
}
// Launch with a fixed grid size (e.g., 256 blocks * 256 threads = 65K threads)
// Each thread processes n/65K elements : works for any n

// Pattern 2: 2D grid for matrix operations
dim3 block(16, 16);  // 256 threads per block arranged in 16x16
dim3 grid((width + 15) / 16, (height + 15) / 16);
matrix_kernel<<<grid, block>>>(data, width, height);

// Pattern 3: Conditional execution based on thread position
__global__ void boundary_kernel(float* data, int rows, int cols) {
    int row = blockIdx.y * blockDim.y + threadIdx.y;
    int col = blockIdx.x * blockDim.x + threadIdx.x;

    if (row < rows && col < cols) {  // 2D bounds check
        int idx = row * cols + col;
        data[idx] = process(data[idx]);
    }
}
```

</Code>

<Remark id="rmk-stride-pattern">
**Why use stride loops?** In production kernels, the stride loop pattern is preferred over launching one thread per element because:
1. **Fixed launch overhead:** Launching a fixed number of blocks avoids the overhead of computing the grid size for every different input.
2. **Better register usage:** Fewer blocks per SM can mean more registers per thread.
3. **Coalesced access:** When `stride = gridDim.x * blockDim.x`, consecutive threads still access consecutive memory in each iteration.
4. **Works for any input size:** No need to recompute grid configuration.
</Remark>

## Error Checking

<Code id="code-first-kernel-5" caption="CUDA error checking macro: always wrap every CUDA API call.">

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

</Code>

<Remark id="rmk-first-kernel-2">
**Kernel launches are asynchronous.** The CPU does not wait for the kernel to finish: it continues executing the next line immediately. This is by design: it allows the CPU to queue up work (data transfers, more kernels) while the GPU computes. But it means errors are not reported at the launch site:

```cuda
my_kernel<<<grid, block>>>(args);  // This returns immediately
cudaError_t err = cudaGetLastError();  // Check for launch configuration errors
if (err != cudaSuccess) { /* handle */ }

cudaDeviceSynchronize();  // Wait for kernel to finish
err = cudaGetLastError();  // Check for runtime errors (out-of-bounds, etc.)
if (err != cudaSuccess) { /* handle */ }
```

In production code, use the `CUDA_CHECK` macro on every CUDA API call.
</Remark>

## Memory Management Patterns

<Code id="code-memory-patterns" caption="Common memory management patterns in CUDA.">

```cuda
// Pattern 1: Manual allocation and deallocation
float *d_ptr;
CUDA_CHECK(cudaMalloc(&d_ptr, n * sizeof(float)));
// ... use d_ptr ...
CUDA_CHECK(cudaFree(d_ptr));

// Pattern 2: Unified memory (automatic CPU-GPU migration)
float *u_ptr;
CUDA_CHECK(cudaMallocManaged(&u_ptr, n * sizeof(float)));
// Can be accessed from BOTH CPU and GPU
// Data migrates on demand (page faults)
for (int i = 0; i < n; i++) u_ptr[i] = 1.0f;  // CPU access
my_kernel<<<grid, block>>>(u_ptr);                // GPU access (data migrates)
CUDA_CHECK(cudaFree(u_ptr));

// Pattern 3: Pinned host memory (faster CPU-GPU transfers)
float *h_pinned;
CUDA_CHECK(cudaMallocHost(&h_pinned, n * sizeof(float)));
// cudaMemcpyAsync works with pinned memory
CUDA_CHECK(cudaMemcpyAsync(d_ptr, h_pinned, n * sizeof(float),
                           cudaMemcpyHostToDevice, stream));
CUDA_CHECK(cudaFreeHost(h_pinned));
```

</Code>

<Table id="tab-memory-allocation" caption="CUDA memory allocation methods.">

| Function | Location | Access From | Transfer | Use Case |
|----------|----------|-------------|----------|----------|
| `cudaMalloc` | GPU | GPU only | Explicit (cudaMemcpy) | Standard GPU allocation |
| `cudaMallocHost` | CPU (pinned) | CPU | Async-capable | Fast CPU-GPU transfers |
| `cudaMallocManaged` | Unified | CPU + GPU | Automatic (page fault) | Prototyping, sparse access |

</Table>
