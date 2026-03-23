# CUDA and GPU Programming

This chapter covers GPU programming from first principles: writing CUDA kernels, understanding the memory model, optimization techniques, and higher-level tools like Triton.

- **[Your First Kernel](./1-first-kernel.md)** -- Hello world, thread indexing, vector addition, compiling with nvcc
- **[Memory Model](./2-memory-model.md)** -- Global, shared, and register memory, coalescing, bank conflicts, occupancy
- **[Optimization](./3-optimization.md)** -- Warp divergence, tiling, reduction, streams, profiling
- **[Triton](./4-triton.md)** -- OpenAI Triton, block-level programming, fused softmax, matmul kernel
- **[Custom PyTorch Ops](./5-custom-ops.md)** -- C++ extensions, CUDA kernels from Python, torch.library
