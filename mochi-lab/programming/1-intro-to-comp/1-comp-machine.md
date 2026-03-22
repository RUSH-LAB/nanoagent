---
sidebar_position: 1
---

# How Programs Execute

## The Fetch-Decode-Execute Cycle

Every CPU runs the same fundamental loop:

1. **Fetch** -- read the next instruction from memory at the address in the program counter (PC)
2. **Decode** -- interpret the instruction (opcode + operands)
3. **Execute** -- perform the operation (arithmetic, memory access, branch)
4. **Update PC** -- advance to the next instruction (or jump target)

Modern CPUs pipeline these stages so multiple instructions are in-flight simultaneously. A 20-stage pipeline can have 20 instructions at different stages of completion.

```
Time -->  1    2    3    4    5    6    7
Inst 1:  [F]  [D]  [E]
Inst 2:       [F]  [D]  [E]
Inst 3:            [F]  [D]  [E]
Inst 4:                 [F]  [D]  [E]
```

**Tip:** Branch mispredictions flush the pipeline, wasting all in-flight work. This is why branchless code (e.g., using conditional moves) can be faster for tight loops.

## Registers and Memory

Registers are the fastest storage, sitting inside the CPU core itself:

```
x86-64 General Purpose Registers:
  RAX, RBX, RCX, RDX    -- arithmetic, function returns
  RSI, RDI               -- source/destination for string ops, function args
  RSP                    -- stack pointer
  RBP                    -- base pointer (frame pointer)
  R8-R15                 -- additional general purpose
  XMM0-XMM15             -- 128-bit SIMD registers
  YMM0-YMM15             -- 256-bit SIMD registers (AVX)
```

## The Memory Hierarchy

Data moves through a hierarchy of increasingly large but slower storage:

| Level | Typical Size | Latency | Analogy |
|-------|-------------|---------|---------|
| Registers | ~1 KB | ~0.3 ns | Your hands |
| L1 cache | 64 KB | ~1 ns (4 cycles) | Your desk |
| L2 cache | 256 KB | ~4 ns (12 cycles) | Filing cabinet |
| L3 cache | 30 MB | ~12 ns (36 cycles) | Office library |
| DRAM | 64-512 GB | ~100 ns (300 cycles) | City library |
| SSD | 1-8 TB | ~100 us | Warehouse |
| HDD | 1-20 TB | ~10 ms | Another city |

## Latency Numbers Every Programmer Should Know

```
L1 cache reference                            1 ns
L2 cache reference                            4 ns
Main memory reference                       100 ns
SSD random read                         100,000 ns  (100 us)
Read 1 MB sequentially from SSD       1,000,000 ns  (1 ms)
HDD seek                             10,000,000 ns  (10 ms)
Send packet SF -> NYC -> SF           40,000,000 ns  (40 ms)
```

**Tip:** The 100x gap between L1 and DRAM is why cache-friendly data access patterns (sequential, predictable) dramatically outperform random access. In ML, this means contiguous tensor layouts and sequential memory access matter.

## Cache Lines and Spatial Locality

Caches operate on **cache lines** (typically 64 bytes). When you access one byte, the entire 64-byte line is fetched. This means:

```python
# Fast: sequential access (one cache miss per 16 floats)
for i in range(N):
    total += array[i]

# Slow: strided access (one cache miss per access if stride > 64 bytes)
for i in range(0, N, stride):
    total += array[i]
```

**Tip:** When iterating over 2D arrays, always iterate over the last dimension in the inner loop (row-major order in C/NumPy). This is why PyTorch tensors default to contiguous row-major layout.

## How This Relates to ML

Training a neural network is dominated by matrix multiplications, which are compute-bound on GPUs but can be memory-bound on CPUs. Understanding the memory hierarchy explains:

- Why **batch size** matters: larger batches amortize the cost of loading weights
- Why **mixed precision** helps: FP16 tensors are half the size, doubling effective bandwidth
- Why **operator fusion** is important: fewer round-trips to global memory
