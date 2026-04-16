---
sidebar_position: 1
---

# How Programs Execute

Every program you write -- from a single-line Python script to a distributed training job spanning 256 GPUs -- ultimately reduces to the same primitive operation: a processor fetching instructions from memory and executing them one at a time. Understanding this execution model is the foundation for everything in this book: why GPUs are fast for matrix math, why memory layout matters, and why your training loop has the performance characteristics it does.

## The Fetch-Decode-Execute Cycle

Every CPU runs the same fundamental loop, repeated billions of times per second:

1. **Fetch** -- read the next instruction from memory at the address in the program counter (PC)
2. **Decode** -- interpret the instruction (opcode + operands), and read any required register values
3. **Execute** -- perform the operation (arithmetic, memory access, branch)
4. **Write back** -- store the result to a register or memory
5. **Update PC** -- advance to the next instruction (or jump to a branch target)

This cycle runs at the **clock frequency** of the processor. A 4 GHz CPU completes 4 billion cycles per second. But not every cycle completes an instruction -- some instructions take multiple cycles (division, memory loads), and pipeline stalls waste cycles entirely.

<Code id="code-pipeline" caption="CPU instruction pipeline showing overlap of fetch, decode, and execute stages.">

```
Time -->  1    2    3    4    5    6    7
Inst 1:  [F]  [D]  [E]  [W]
Inst 2:       [F]  [D]  [E]  [W]
Inst 3:            [F]  [D]  [E]  [W]
Inst 4:                 [F]  [D]  [E]  [W]

Throughput: 1 instruction per cycle (ideal)
Latency per instruction: 4 cycles
```

</Code>

Modern CPUs pipeline these stages so multiple instructions are in-flight simultaneously. A 20-stage pipeline (typical for Intel/AMD) can have 20 instructions at different stages of completion, achieving a throughput of up to one instruction per cycle despite each instruction taking 20 cycles from start to finish.

<Remark id="rmk-branch-misprediction">
**Branch mispredictions flush the pipeline.** When the CPU encounters a conditional branch (`if/else`), it *predicts* which direction the branch will take and speculatively fetches instructions along the predicted path. If the prediction is wrong, all speculatively executed work is discarded and the pipeline is flushed -- wasting 10-20 cycles. Modern branch predictors are extremely accurate (>95%), but in tight loops with unpredictable branches, mispredictions can dominate execution time.

This is why branchless code (using conditional moves, `cmov`, or arithmetic tricks) can be 2-5x faster for data-dependent operations. In ML, this shows up in custom kernels where data-dependent control flow should be minimized.
</Remark>

<Remark id="rmk-ilp">
**Instruction-level parallelism (ILP).** Modern CPUs are **superscalar**: they can issue multiple independent instructions per cycle. An Intel Core can issue up to 6 micro-operations per cycle. The CPU automatically detects data dependencies between instructions and executes independent ones in parallel (out-of-order execution). This means the actual throughput can exceed one instruction per cycle when there is sufficient independent work.

| Technique | What It Does | Impact |
|-----------|-------------|--------|
| Pipelining | Overlaps stages of different instructions | 1 instruction/cycle throughput |
| Superscalar | Multiple execution units per core | 2-6 instructions/cycle |
| Out-of-order | Reorders instructions to fill bubbles | Hides latency of slow operations |
| Speculative execution | Executes past branches before resolution | Avoids branch stalls (when prediction is correct) |

For ML workloads, ILP is mostly relevant on CPUs. GPUs use a fundamentally different approach (thread-level parallelism) to hide latency.
</Remark>

## Registers and Memory

Registers are the fastest storage, sitting inside the CPU core itself. They are the only storage that the ALU (arithmetic logic unit) can operate on directly -- all data must be loaded into registers before it can be processed.

<Code id="code-x86-registers" caption="x86-64 general purpose and SIMD registers.">

```
x86-64 General Purpose Registers (64-bit):
  RAX              -- accumulator, function return values
  RBX              -- callee-saved general purpose
  RCX              -- loop counter, 4th function argument
  RDX              -- 3rd function argument, I/O
  RSI, RDI         -- 2nd and 1st function arguments (System V ABI)
  RSP              -- stack pointer (top of stack)
  RBP              -- base pointer (frame pointer)
  R8-R15           -- additional general purpose (R8-R9 = 5th-6th args)

SIMD Registers:
  XMM0-XMM15       -- 128-bit (SSE: 4 floats or 2 doubles)
  YMM0-YMM15       -- 256-bit (AVX: 8 floats or 4 doubles)
  ZMM0-ZMM31       -- 512-bit (AVX-512: 16 floats or 8 doubles)

Special Registers:
  RIP              -- instruction pointer (program counter)
  RFLAGS           -- condition flags (zero, carry, overflow)
```

</Code>

<Remark id="rmk-register-naming">
**Register naming conventions.** The x86 architecture has accumulated layers of history. RAX is the 64-bit extension of EAX (32-bit), which extended AX (16-bit), which has sub-registers AH and AL (high and low bytes). When you see `movl %eax, ...` in compiler output, the `l` suffix and `%eax` register name tell you it is a 32-bit operation. Understanding these conventions is essential for reading compiler output and assembly.
</Remark>

## The Memory Hierarchy

Data moves through a hierarchy of increasingly large but slower storage. The key insight is that each level is roughly 10x slower than the level above, but also roughly 10x larger. This hierarchy exists because fast memory is physically small and expensive (SRAM), while large memory is slow and cheap (DRAM).

<Table id="tab-memory-hierarchy-prog" caption="Memory hierarchy with typical latencies, sizes, and bandwidths (circa 2024).">

| Level | Typical Size | Latency | Bandwidth | Analogy |
|-------|-------------|---------|-----------|---------|
| Registers | ~1 KB per core | ~0.3 ns (1 cycle) | ~10 TB/s | Your hands |
| L1 cache | 32-64 KB per core | ~1 ns (4 cycles) | ~1 TB/s | Your desk |
| L2 cache | 256 KB-2 MB per core | ~4 ns (12 cycles) | ~500 GB/s | Filing cabinet |
| L3 cache (shared) | 16-64 MB per chip | ~12 ns (36 cycles) | ~300 GB/s | Office library |
| DRAM (main memory) | 64-512 GB | ~80-100 ns (300 cycles) | 50-100 GB/s | City library |
| SSD (NVMe) | 1-8 TB | ~100 us (300K cycles) | 3-7 GB/s | Warehouse |
| HDD | 1-20 TB | ~10 ms (30M cycles) | 100-200 MB/s | Another city |
| Network (same datacenter) | Unlimited | ~0.5 ms | 25-400 Gb/s | Mail system |

</Table>

<Remark id="rmk-hierarchy-implication">
**The 100x latency gap between L1 cache and DRAM is the single most important performance fact in computing.** Accessing data in L1 takes 1 ns; accessing DRAM takes 100 ns. This means that a cache miss is not "slightly slower" -- it is catastrophically slower. An algorithm that fits in cache can be 100x faster than one that constantly accesses main memory, even if the cache-friendly version does more total work.

In ML, this explains why:
- **Operator fusion** is so important (keep intermediate results in registers/cache instead of writing to global memory)
- **Tiling** GEMM operations is essential (process blocks that fit in cache)
- **Tensor layout** matters (contiguous memory access patterns hit cache; strided access misses)
</Remark>

## Latency Numbers Every Programmer Should Know

These numbers, originally compiled by Jeff Dean, should become intuition.

<Code id="code-latency-numbers" caption="Key latency numbers for system design decisions (approximate, 2024 hardware).">

```
L1 cache reference                            1 ns
L2 cache reference                            4 ns
Branch mispredict penalty                     5 ns
L3 cache reference                           12 ns
Mutex lock/unlock                            25 ns
Main memory reference                       100 ns
Compress 1KB with Snappy                  3,000 ns    (3 us)
SSD random read                         100,000 ns    (100 us)
Read 1 MB sequentially from SSD       1,000,000 ns    (1 ms)
GPU kernel launch overhead                  5,000 ns    (5 us)
Read 1 MB sequentially from DRAM          12,000 ns    (12 us)
NCCL AllReduce 1 MB (8 GPUs, NVLink)     10,000 ns    (10 us)
HDD seek                            10,000,000 ns    (10 ms)
Send packet SF -> NYC -> SF          40,000,000 ns    (40 ms)
```

</Code>

<Remark id="rmk-ml-latency-implications">
**Latency implications for ML systems:**

- **GPU kernel launch overhead (~5 us):** If your kernel runs for less than 5 us, the launch overhead dominates. This is why batching small operations (via `torch.compile` or CUDA graphs) is critical.
- **NCCL AllReduce (~10 us + bandwidth):** Communication latency puts a floor on how small your gradient tensors can be before communication overhead dominates compute.
- **SSD random read (~100 us):** Data loading must be asynchronous and prefetched. A single random read per sample at 100 us limits you to 10,000 samples/second before the data pipeline becomes the bottleneck.
- **DRAM sequential bandwidth (~50 GB/s on CPU, ~3 TB/s on GPU HBM):** This 60x difference is why memory-bound operations (elementwise ops, reductions) are so much faster on GPUs.
</Remark>

## Cache Lines and Spatial Locality

Caches do not operate on individual bytes -- they operate on **cache lines**, typically 64 bytes. When you access one byte, the entire 64-byte line is fetched from the next level. This has profound implications for performance:

<Code id="code-cache-access" caption="Sequential vs strided memory access patterns and their cache behavior.">

```python
import numpy as np

# Fast: sequential access (1 cache miss per 16 floats = 64 bytes)
# Each cache line contains 16 contiguous float32 values
def sequential_sum(arr):
    total = 0.0
    for i in range(len(arr)):
        total += arr[i]  # Next element is in the same cache line
    return total

# Slow: strided access (1 cache miss PER access if stride >= 16)
def strided_sum(arr, stride=64):
    total = 0.0
    for i in range(0, len(arr), stride):
        total += arr[i]  # Each access loads a new cache line, wastes 15/16 of it
    return total

# The sequential version touches the same total data but runs ~10x faster
# because it uses every byte in each cache line
```

</Code>

<Remark id="rmk-row-major">
**Row-major vs column-major ordering.** When iterating over 2D arrays, always iterate over the **last dimension** in the inner loop. This accesses memory sequentially (row-major order in C/NumPy/PyTorch):

```python
# FAST: inner loop over columns (contiguous in memory)
for i in range(rows):
    for j in range(cols):
        process(matrix[i, j])

# SLOW: inner loop over rows (stride = cols * sizeof(float))
for j in range(cols):
    for i in range(rows):
        process(matrix[i, j])
```

PyTorch tensors default to contiguous row-major (C-order) layout. Transposing a tensor does not move data -- it only changes the stride metadata. This is why `tensor.t().contiguous()` triggers a copy: it rearranges memory to make the transposed view contiguous.
</Remark>

<Remark id="rmk-temporal-locality">
**Temporal and spatial locality.** Caches exploit two patterns:
- **Spatial locality:** If you access address $x$, you will soon access $x+1, x+2, \ldots$ (the rest of the cache line). Sequential array traversal exhibits perfect spatial locality.
- **Temporal locality:** If you access address $x$, you will access $x$ again soon. Loop variables and frequently-used data exhibit temporal locality.

A cache-friendly algorithm maximizes both: process data in blocks that fit in cache (temporal), and access each block sequentially (spatial). This is exactly what tiled matrix multiplication does, and why GEMM implementations spend enormous effort on tile scheduling.
</Remark>

## Virtual Memory

Programs do not access physical memory directly. Instead, each process gets its own **virtual address space**, and the hardware translates virtual addresses to physical addresses:

<Code id="code-virtual-memory" caption="Virtual memory mapping from process address space to physical memory.">

```
Process A virtual space:    Process B virtual space:    Physical Memory:
+------------------+       +------------------+       +------------------+
| Stack    0x7fff  |       | Stack    0x7fff  |       |  Page Frame 0    |
|       ...        |       |       ...        |  +--->|  Page Frame 1    |
| Heap     0x5000  |--+    | Heap     0x5000  |--+    |  Page Frame 2    |
|       ...        |  |    |       ...        |       |  Page Frame 3    |
| Code     0x0400  |  +--->|  Page Frame 5    |       |  Page Frame 4    |
+------------------+       +------------------+       |  Page Frame 5    |
                                                      +------------------+
                                Page Table
                           (per-process mapping)
```

</Code>

<Remark id="rmk-virtual-memory-ml">
**Virtual memory and ML.** Virtual memory matters for ML in several ways:

- **Page faults during data loading:** When a memory-mapped file (`mmap`) is accessed for the first time, a page fault triggers I/O to load the page. This is why memory-mapped datasets have high latency on the first epoch.
- **CUDA unified memory:** `torch.cuda.memory_map` and CUDA managed memory use virtual memory to provide a unified address space across CPU and GPU. Data is paged between CPU and GPU memory on demand.
- **Large allocations:** PyTorch's caching allocator reserves large blocks of GPU memory to avoid the overhead of repeated `cudaMalloc` calls. Understanding this explains why `torch.cuda.memory_allocated()` and `nvidia-smi` show different numbers.
- **NUMA (Non-Uniform Memory Access):** On multi-socket servers, memory attached to a remote CPU socket has ~2x higher latency. Pinning processes to the correct NUMA node matters for data loading performance.
</Remark>

## How This Relates to ML

Training a neural network is dominated by matrix multiplications, which are compute-bound on GPUs but can be memory-bound on CPUs. Understanding the memory hierarchy and execution model explains the key performance characteristics of ML workloads:

<Table id="tab-ml-implications" caption="How hardware fundamentals affect ML performance.">

| Concept | ML Implication | Practical Consequence |
|---------|---------------|----------------------|
| Cache lines (64B) | Tensor memory layout matters | Use contiguous tensors; avoid strided access |
| L1-DRAM gap (100x) | Operator fusion is critical | Fused kernels avoid global memory round-trips |
| Pipeline stalls | Data-dependent branching hurts | Avoid `if` in custom CUDA kernels; use masks |
| Bandwidth limits | Most ops are memory-bound | Mixed precision (FP16) doubles effective bandwidth |
| Kernel launch overhead | Many small kernels are slow | `torch.compile` / CUDA graphs batch launches |
| Virtual memory | Large model loading | Memory-mapped weights; lazy allocation |

</Table>

<Remark id="rmk-batch-size-memory">
**Why batch size matters from a hardware perspective.** Larger batches amortize three costs:
1. **Kernel launch overhead:** Each forward/backward pass launches hundreds of kernels. The fixed overhead per kernel is amortized over more data.
2. **Weight loading:** Matrix multiplication loads weights from global memory once per batch element in the naive case. Tiling amortizes this, but larger batches still improve compute-to-memory ratio.
3. **Communication overhead:** In distributed training, gradient synchronization (AllReduce) has a fixed latency component. Larger batches do more compute between synchronizations, improving the compute-to-communication ratio.

The tradeoff: very large batches can hurt convergence (generalization gap), requiring learning rate warmup and scaling rules.
</Remark>
