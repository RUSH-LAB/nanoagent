# Introduction to Computing

This chapter covers how programs execute on modern hardware, from the fetch-decode-execute cycle to distributed GPU clusters.

- **[How Programs Execute](./1-comp-machine.md)**: The fetch-decode-execute cycle, registers, memory hierarchy, and latency numbers every programmer should know
- **[CPU and GPU Architecture](./2-cpu-and-gpu.md)**: CPU vs GPU design, SIMT execution, thread hierarchy, memory types, and bandwidth vs latency
- **[From Assembly to PyTorch](./3-assembly-cuda-torch.md)**: The abstraction stack: how `torch.matmul` becomes GPU instructions
- **[High-Performance Computing](./4-hpc.md)**: MPI, NCCL, distributed training topology, and profiling with nsys
