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

<Code id="code-cpu-layout" caption="Schematic layout of a CPU core.">

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

</Code>

## GPU: Optimized for Throughput

A GPU trades single-thread performance for massive parallelism:

- **Simple cores** -- no branch prediction, limited caches
- **Thousands of threads** -- hide memory latency by switching between threads
- **Wide SIMT execution** -- 32 threads (a warp) execute the same instruction
- **High bandwidth memory** -- HBM provides 3+ TB/s vs ~50 GB/s for CPU DRAM

<Code id="code-gpu-sm-layout" caption="Schematic layout of a GPU Streaming Multiprocessor (SM).">

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

</Code>

## Thread Hierarchy

CUDA organizes computation in a hierarchy:

<Code id="code-thread-hierarchy" caption="CUDA thread hierarchy: grid, blocks, warps, and threads.">

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

</Code>

<Table id="tab-thread-levels" caption="CUDA thread hierarchy levels and their shared resources.">

| Level | Size | Shared Resources |
|-------|------|-----------------|
| Thread | 1 | Registers (~255 per thread) |
| Warp | 32 threads | Lock-step execution |
| Block | Up to 1024 threads | Shared memory, synchronization |
| Grid | Up to 2^31 blocks | Global memory |

</Table>

<Remark id="rmk-warp-size">
Always make your block size a multiple of 32 (the warp size). Non-multiple sizes waste execution slots.
</Remark>

## Memory Types

<Code id="code-gpu-memory" caption="GPU memory hierarchy showing global, shared, and register memory.">

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

</Code>

<Table id="tab-gpu-memory-types" caption="GPU memory types, scopes, and latencies.">

| Memory | Scope | Latency | Size | Cached |
|--------|-------|---------|------|--------|
| Registers | Thread | ~1 cycle | 256 KB/SM | N/A |
| Shared | Block | ~5 cycles | 128 KB/SM | N/A |
| L1/L2 | SM/Device | ~30 cycles | 128KB/40MB | Yes |
| Global (HBM) | Device | ~300 cycles | 80 GB | Via L2 |
| Constant | Device | ~5 cycles (cached) | 64 KB | Yes |

</Table>

## Bandwidth vs Compute: The Roofline Model

<Definition id="def-roofline" name="Roofline Model">
An operation is either **compute-bound** or **memory-bound**, determined by its **arithmetic intensity** (FLOPs per byte transferred):

- **Matrix multiply (GEMM):** ~100 FLOPS/byte (compute-bound)
- **Element-wise ops (ReLU):** ~0.25 FLOPS/byte (memory-bound)
- **Reduction (sum):** ~0.25 FLOPS/byte (memory-bound)
</Definition>

<Code id="code-roofline" caption="The roofline model showing the compute-bound and memory-bound regimes.">

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

</Code>

<Remark id="rmk-memory-bound-fix">
If your operation is memory-bound, making it faster requires reducing memory traffic (fusion, quantization), not adding more compute.
</Remark>
