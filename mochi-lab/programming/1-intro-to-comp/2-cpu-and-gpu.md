---
sidebar_position: 2
---

# CPU and GPU Architecture

## CPU: Optimized for Latency

A CPU core is designed to execute a single thread of instructions as fast as possible:

- **Out-of-order execution** -- reorders instructions to keep all execution units busy
- **Branch prediction** -- guesses which way branches go to avoid pipeline stalls
- **Large caches** -- L1/L2/L3 hierarchy to minimize memory latency
- **Few cores** -- 8-128 powerful cores, each running 1-2 threads

```
CPU Core Layout:
+------------------+
|  Branch Predict  |
|  Out-of-Order    |
|  Execution Units |
|  L1 Cache (64KB) |
|  L2 Cache (256KB)|
+------------------+
      x 8-128 cores
```

## GPU: Optimized for Throughput

A GPU trades single-thread performance for massive parallelism:

- **Simple cores** -- no branch prediction, limited caches
- **Thousands of threads** -- hide memory latency by switching between threads
- **Wide SIMT execution** -- 32 threads (a warp) execute the same instruction
- **High bandwidth memory** -- HBM provides 3+ TB/s vs ~50 GB/s for CPU DRAM

```
GPU Streaming Multiprocessor (SM):
+----------------------------------+
|  Warp Scheduler  | Warp Scheduler|
|  32 CUDA Cores   | 32 CUDA Cores |
|  Tensor Cores    |               |
|  Shared Memory / L1 (128 KB)     |
|  Register File (256 KB)          |
+----------------------------------+
      x 80-144 SMs per GPU
```

## Thread Hierarchy

CUDA organizes computation in a hierarchy:

```
Grid (entire kernel launch)
  |
  +-- Block 0              Block 1              Block 2
       |                    |                    |
       +-- Warp 0          +-- Warp 0           ...
       |    Thread 0-31    |    Thread 0-31
       +-- Warp 1          +-- Warp 1
       |    Thread 32-63   |    Thread 32-63
       ...                 ...
```

| Level | Size | Shared Resources |
|-------|------|-----------------|
| Thread | 1 | Registers (~255 per thread) |
| Warp | 32 threads | Lock-step execution |
| Block | Up to 1024 threads | Shared memory, synchronization |
| Grid | Up to 2^31 blocks | Global memory |

**Tip:** Always make your block size a multiple of 32 (the warp size). Non-multiple sizes waste execution slots.

## Memory Types

```
+--------------------------------------------------+
|                   Global Memory (HBM)             |
|                   80 GB, ~3 TB/s                  |
+--------------------------------------------------+
     |              |              |
+----------+  +----------+  +----------+
|   SM 0   |  |   SM 1   |  |   SM 2   |
| Shared   |  | Shared   |  | Shared   |
| 128 KB   |  | 128 KB   |  | 128 KB   |
| Registers|  | Registers|  | Registers|
| 256 KB   |  | 256 KB   |  | 256 KB   |
+----------+  +----------+  +----------+
```

| Memory | Scope | Latency | Size | Cached |
|--------|-------|---------|------|--------|
| Registers | Thread | ~1 cycle | 256 KB/SM | N/A |
| Shared | Block | ~5 cycles | 128 KB/SM | N/A |
| L1/L2 | SM/Device | ~30 cycles | 128KB/40MB | Yes |
| Global (HBM) | Device | ~300 cycles | 80 GB | Via L2 |
| Constant | Device | ~5 cycles (cached) | 64 KB | Yes |

## Bandwidth vs Compute: The Roofline Model

An operation is either **compute-bound** or **memory-bound**:

```
Performance (FLOPS)
     |          ______________  Peak Compute
     |         /
     |        /
     |       /    Compute-bound
     |      /
     |     /  Memory-bound
     |    /
     |   /
     +---+-----+------------>
         Ridge   Arithmetic Intensity (FLOPS/byte)
         Point
```

**Arithmetic intensity** = FLOPs / bytes transferred

- **Matrix multiply (GEMM):** ~100 FLOPS/byte (compute-bound)
- **Element-wise ops (ReLU):** ~0.25 FLOPS/byte (memory-bound)
- **Reduction (sum):** ~0.25 FLOPS/byte (memory-bound)

**Tip:** If your operation is memory-bound, making it faster requires reducing memory traffic (fusion, quantization), not adding more compute.
