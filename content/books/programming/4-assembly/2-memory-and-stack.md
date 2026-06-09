---
sidebar_position: 2
---

# Memory and Stack

Every running program uses memory organized into distinct regions with different lifetimes, access speeds, and purposes. Understanding this layout (the stack for function calls, the heap for dynamic allocations, virtual memory for isolation, and cache lines for performance) is essential for debugging crashes in C++/CUDA extensions, understanding why PyTorch allocators exist, and writing code that cooperates with the memory hierarchy rather than fighting it.

## Process Memory Layout

Every process sees a flat 64-bit virtual address space. The OS maps this to physical memory through page tables, giving each process the illusion of owning all of memory:

<Code id="code-memory-layout" caption="Virtual address space layout for a typical x86-64 Linux process.">

```
High addresses (0x00007FFFFFFFFFFF)
    +---------------------------+
    | Stack                     |  <- grows downward (toward lower addresses)
    |   (function frames,       |     RSP points to current top
    |    local variables)       |     Default limit: 8 MB per thread
    +---------------------------+
    |          |                |
    |          v                |
    |     (unmapped gap)        |
    |          ^                |
    |          |                |
    +---------------------------+
    | Memory-mapped region      |  <- mmap, shared libraries, file mappings
    +---------------------------+
    |          ^                |
    |          |                |
    | Heap                      |  <- grows upward (toward higher addresses)
    |   (malloc, new, PyTorch   |     managed by allocator (glibc, jemalloc, etc.)
    |    CPU tensor storage)    |
    +---------------------------+
    | BSS (.bss)                |  <- uninitialized globals (zero-filled)
    | Data (.data)              |  <- initialized globals
    | Read-only data (.rodata)  |  <- string literals, constants
    | Code (.text)              |  <- executable instructions
    +---------------------------+
    | (unmapped)                |  <- NULL dereference caught here (SIGSEGV)
Low addresses (0x0000000000000000)
```

</Code>

<Remark id="rmk-memory-layout-ml">
**Where ML data lives.** PyTorch CPU tensors are allocated on the heap by `c10::DefaultCPUAllocator`, which calls `posix_memalign` for 64-byte alignment, drawing from the linked libc `malloc`. Replacing the underlying allocator with jemalloc or tcmalloc is opt-in via `LD_PRELOAD`. GPU tensors live in GPU virtual memory (a separate address space), allocated via `cudaMalloc`. Pinned host memory (`torch.cuda.pinned_memory`) uses `cudaMallocHost`, which allocates page-locked memory on the CPU heap that the GPU can access directly via DMA, enabling asynchronous transfers.
</Remark>

## Stack Frames

Each function call creates a **stack frame**, a region of the stack that holds the function's local variables, saved registers, and the return address. The stack grows **downward** (toward lower addresses). The following examples use x86-64 registers (RSP, RBP, RIP, RBX, R12-R15) introduced in the prior section, [x86 Basics](./1-x86-basics.md):

<Code id="code-stack-frame-diagram" caption="Anatomy of a stack frame in x86-64.">

```
High addresses
    +--------------------+
    | argument 7+        |  <- overflow arguments (7th and beyond)
    +--------------------+
    | return address     |  <- pushed by CALL instruction (8 bytes)
    +--------------------+
    | saved RBP          |  <- callee pushes old frame pointer
    +--------------------+  <- RBP points here (frame pointer)
    | local variable 1   |
    | local variable 2   |
    | saved registers    |  <- callee-saved registers (RBX, R12-R15)
    | alignment padding  |
    +--------------------+  <- RSP points here (stack pointer)
Low addresses
```

</Code>

<Code id="code-memory-and-stack-1" caption="Function prologue and epilogue: setting up and tearing down a stack frame.">

```asm
; ── Function prologue ──
push rbp            ; Save caller's base pointer (RSP -= 8, [RSP] = RBP)
mov rbp, rsp        ; Set up our base pointer (RBP = RSP)
sub rsp, 32         ; Allocate 32 bytes for locals (RSP -= 32)

; ── Function body ──
mov [rbp-8], rdi    ; Store 1st argument in local variable
mov [rbp-16], rsi   ; Store 2nd argument
mov rax, [rbp-8]    ; Load local variable
add rax, [rbp-16]   ; Add second local

; ── Function epilogue ──
mov rsp, rbp        ; Deallocate locals (RSP = RBP)
pop rbp             ; Restore caller's base pointer
ret                 ; Pop return address into RIP, jump back
; Equivalent shorthand: "leave" = mov rsp,rbp + pop rbp
```

</Code>

<Example id="ex-prologue-rsp-rbp">

**Tracing RSP and RBP through a prologue.** Suppose `code-memory-and-stack-1` is entered with `RSP = 0x7FFFFFFFE000` immediately after the `CALL` instruction has pushed the 8-byte return address. We will trace the two pointers instruction by instruction through the prologue. Recall that the stack grows downward, so a push or an allocation *subtracts* from RSP.

*Step 0: on entry.* The `CALL` already decremented RSP by 8 to store the return address. The caller's RBP still holds whatever value the caller set up:

$$\text{RSP} = \texttt{0x7FFFFFFFE000}, \qquad \text{RBP} = \text{caller's frame pointer.}$$

*Step 1: `push rbp`.* This pushes the caller's RBP, so RSP drops by 8:

$$\text{RSP} = \texttt{0x7FFFFFFFE000} - 8 = \texttt{0x7FFFFFFFDFF8}.$$

The value of RBP is unchanged at this instruction; the old RBP is now stored at `[0x7FFFFFFFDFF8]`.

*Step 2: `mov rbp, rsp`.* The new frame pointer is set to the current top of stack:

$$\text{RBP} = \text{RSP} = \texttt{0x7FFFFFFFDFF8}.$$

*Step 3: `sub rsp, 32`.* The function reserves 32 bytes for locals:

$$\text{RSP} = \texttt{0x7FFFFFFFDFF8} - 32 = \texttt{0x7FFFFFFFDFD8}.$$

After the prologue, locals are addressed relative to the stable RBP: the first argument stored by `mov [rbp-8], rdi` lands at `0x7FFFFFFFDFF8 - 8 = 0x7FFFFFFFDFF0`, and the second at `0x7FFFFFFFDFF8 - 16 = 0x7FFFFFFFDFE8`. Both sit inside the 32-byte region between RSP and RBP.

</Example>

<Example id="ex-epilogue-rsp-rbp">

**Tearing the frame back down (harder).** Continuing from the previous example, the epilogue must restore the stack to exactly the state the `RET` instruction expects. At the start of the epilogue we have `RSP = 0x7FFFFFFFDFD8` and `RBP = 0x7FFFFFFFDFF8`. Trace the pointers through `mov rsp, rbp`, `pop rbp`, and `ret`.

*Step 1: `mov rsp, rbp`.* This discards the 32 bytes of locals in a single move by snapping RSP back up to the frame pointer:

$$\text{RSP} = \text{RBP} = \boxed{\quad?\quad}$$

*Step 2: `pop rbp`.* Popping reads the saved caller's RBP from `[RSP]` into RBP and then *adds* 8 to RSP (the stack shrinks upward). What is RSP now, and what does RBP hold?

*Step 3: `ret`.* `RET` pops the 8-byte return address into RIP, adding 8 more to RSP. Show that RSP returns to its value from Step 0 of the previous example, confirming the frame was balanced.

<details>
<summary>Solution</summary>

Step 1: `RSP = RBP = 0x7FFFFFFFDFF8`.

Step 2: `pop rbp` loads `[0x7FFFFFFFDFF8]` (the saved caller frame pointer) into RBP, restoring the caller's RBP, then sets `RSP = 0x7FFFFFFFDFF8 + 8 = 0x7FFFFFFFE000`.

Step 3: `ret` pops the return address and sets `RSP = 0x7FFFFFFFE000 + 8 = 0x7FFFFFFFE008`. This is exactly the RSP the caller held before issuing `CALL` (which had subtracted 8 to push the return address), so the stack is perfectly balanced.

</details>

</Example>

<Remark id="rmk-frame-pointer-omission">
**Frame pointer omission.** With `-fomit-frame-pointer` (default at `-O2`), the compiler does not save/restore RBP, freeing it as a general-purpose register. Instead, it accesses locals relative to RSP. This makes stack frames smaller and frees a register, but makes debugging harder because `gdb` cannot always walk the stack. Use `-fno-omit-frame-pointer` when profiling with `perf` or debugging crashes.
</Remark>

<Remark id="rmk-stack-debugging">
**Debugging segfaults in C/C++ extensions.** When a PyTorch C++ extension crashes, `gdb`'s `backtrace` command walks the chain of saved RBP pointers to reconstruct the call stack. Each frame shows the function name, arguments, and source location. Common causes of stack-related crashes:

| Crash Type | Symptom | Common Cause |
|-----------|---------|-------------|
| Stack overflow | `SIGSEGV` in deeply nested call | Unbounded recursion, very large local arrays |
| Stack buffer overflow | Corrupted return address | Writing past array bounds on stack |
| Use after return | Reading garbage values | Returning pointer to local variable |
| Misaligned stack | `SIGSEGV` in SSE/AVX instruction | Stack not 16-byte aligned before CALL |
</Remark>

## Heap Allocation

The heap provides dynamic memory with programmer-controlled lifetime. Unlike the stack, heap allocations survive beyond the function that created them:

<Code id="code-memory-and-stack-2" caption="Stack vs heap allocation patterns in C and their ML equivalents.">

```c
// Stack allocation: fast, automatic, limited size
int array[1000];                   // On the stack (~8 KB)
// Freed automatically when function returns

// Heap allocation: slower, manual, virtually unlimited
int* array = malloc(1000 * sizeof(int));   // On the heap
// ... use array ...
free(array);                       // Must free manually (memory leak if forgotten)
array = NULL;                      // Defensive: prevent use-after-free

// C++ RAII: automatic cleanup via destructor
std::vector<int> vec(1000);        // Heap-allocated, freed when vec goes out of scope

// PyTorch tensors: heap allocation via custom allocator
// torch::empty({1000}) calls c10::Allocator::raw_allocate()
//   -> CPU: posix_memalign (64-byte aligned)
//   -> CUDA: cudaMalloc (via caching allocator to amortize allocation cost)
```

</Code>

<Table id="tab-stack-vs-heap" caption="Stack vs heap memory comparison.">

| Property | Stack | Heap |
|----------|-------|------|
| Allocation cost | ~1 ns (move RSP) | ~100-1000 ns (allocator overhead) |
| Deallocation | Automatic (function return) | Manual (`free`/`delete`) or GC |
| Size limit | ~8 MB per thread (configurable) | Limited by available RAM |
| Fragmentation | None (LIFO discipline) | Yes (can waste memory over time) |
| Cache behavior | Excellent (recently used, contiguous) | Variable (depends on allocation pattern) |
| Thread safety | Per-thread (no contention) | Shared (allocator needs synchronization) |

</Table>

<Remark id="rmk-pytorch-allocator">
**PyTorch's caching allocator.** Raw `cudaMalloc`/`cudaFree` calls take 1-10 ms because they synchronize the GPU. PyTorch's CUDA caching allocator calls `cudaMalloc` once for a large block, then sub-allocates from it without GPU synchronization. This is why `torch.cuda.memory_allocated()` and `torch.cuda.memory_reserved()` show different values: "reserved" is what was obtained from `cudaMalloc`, "allocated" is what tensors are actually using.
</Remark>

## Virtual Memory

Virtual memory provides three critical properties: **isolation** (each process gets its own address space), **abstraction** (programs use flat addresses without knowing physical layout), and **overcommit** (programs can map more memory than physically available).

<Table id="tab-virtual-memory" caption="Virtual memory key concepts.">

| Concept | Description | ML Implication |
|---------|------------|----------------|
| Page | 4 KB unit of virtual-to-physical mapping | Large tensors span many pages; TLB misses add latency |
| Huge pages | 2 MB or 1 GB pages | Reduce TLB misses for large allocations; `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |
| Page fault | Access to unmapped page triggers OS handler | First touch on `cudaMallocManaged` memory triggers migration |
| TLB | Cache of virtual-to-physical translations | TLB misses cost ~100 cycles; huge pages reduce them |
| mmap | Map files or anonymous memory into address space | Used by data loaders for memory-mapped datasets |
| Copy-on-write | Pages shared until one process writes | `fork()` in DataLoader workers shares parent memory initially |

</Table>

<Remark id="rmk-cuda-virtual-memory">
**CPU vs GPU virtual memory.** The CPU and GPU have separate virtual address spaces. `cudaMemcpy` copies data between them via PCIe or NVLink. CUDA Unified Memory (`cudaMallocManaged`) creates pages that can be accessed by both CPU and GPU: the CUDA runtime migrates pages on demand via page faults, which simplifies programming but adds latency from fault handling and migration.
</Remark>

## Cache Lines and Alignment

The CPU does not read individual bytes from memory. It reads **cache lines** of 64 bytes. Every memory access brings an entire 64-byte cache line into L1 cache. This has profound implications for data layout:

<Code id="code-memory-and-stack-3" caption="Data alignment and struct packing affect cache efficiency.">

```c
// ── Aligned access: one cache line fetch ──
float array[16];             // 16 * 4 = 64 bytes = one cache line (when 64-byte aligned)
float val = array[0];        // Brings all 16 floats into cache

// ── Misaligned struct: wastes cache bandwidth ──
struct Bad {
    char a;       //  1 byte
                  //  7 bytes padding (align double to 8-byte boundary)
    double b;     //  8 bytes
    char c;       //  1 byte
                  //  7 bytes padding (align struct size to 8)
};  // Total: 24 bytes (only 10 bytes are data = 42% utilization)

// ── Packed struct: group fields by size ──
struct Good {
    double b;     //  8 bytes
    char a;       //  1 byte
    char c;       //  1 byte
                  //  6 bytes padding
};  // Total: 16 bytes (10 bytes data = 63% utilization)
```

</Code>

<Table id="tab-cache-line-effects" caption="How data layout affects cache behavior.">

| Pattern | Cache Lines Touched | Effective Bandwidth |
|---------|-------------------|-------------------|
| Sequential array access | 1 per 16 floats | 100% (every byte used) |
| Stride-2 array access | 1 per 8 useful floats | 50% (half the bytes wasted) |
| Stride-16 array access | 1 per 1 useful float | 6% (60 of 64 bytes wasted) |
| Random access | 1 per element | ~6% (worst case) |
| Array of structs (AoS, padded) | Depends on struct size | Often 30-60% |
| Struct of arrays (SoA) | 1 per 16 floats per field | ~100% per field |

</Table>

<Code id="code-memory-and-stack-4" caption="Forcing memory alignment for SIMD and cache-line optimization.">

```c
// ── C: force alignment for SIMD ──
float data[256] __attribute__((aligned(64)));   // 64-byte aligned (cache line)
float avx_data[256] __attribute__((aligned(32))); // 32-byte aligned (AVX)

// ── C11 standard alignment ──
#include <stdalign.h>
alignas(64) float data[256];

// ── C++17: aligned allocation ──
auto* ptr = std::aligned_alloc(64, 256 * sizeof(float));

// ── Python/NumPy: check alignment ──
import numpy as np
a = np.empty(256, dtype=np.float32)
print(a.ctypes.data % 64 == 0)  # True (NumPy aligns to 64 bytes)

// ── PyTorch: tensors are 64-byte aligned by default ──
import torch
t = torch.empty(256)
print(t.data_ptr() % 64 == 0)  # True
```

</Code>

<Remark id="rmk-aos-vs-soa">
**Array of Structs (AoS) vs Struct of Arrays (SoA).** This is the most important data layout decision for performance:

```c
// AoS: poor for SIMD, poor cache utilization if only accessing one field
struct Particle { float x, y, z, mass; };
Particle particles[1000];
// Accessing all x values: particles[0].x, particles[1].x, ...
// Memory layout: x0 y0 z0 m0 x1 y1 z1 m1 ...
// Stride-4 access pattern -> 25% cache utilization

// SoA: excellent for SIMD, excellent cache utilization per field
struct Particles {
    float x[1000], y[1000], z[1000], mass[1000];
};
// Accessing all x values: sequential, one cache line per 16 floats
// Memory layout: x0 x1 x2 ... x999 y0 y1 y2 ...
```

PyTorch tensors use SoA-style contiguous storage, which is why contiguous tensors are faster than non-contiguous views.
</Remark>

<Remark id="rmk-cache-line-false-sharing">
**False sharing.** When two threads write to different variables that happen to share the same cache line, the CPU's cache coherence protocol forces the line to bounce between cores. This can reduce multithreaded performance by 10-100x:

```c
// BAD: counters[0] and counters[1] share a cache line
int counters[NUM_THREADS];  // 4 bytes apart -> same cache line
// Each thread writes counters[thread_id] -> false sharing

// GOOD: pad to cache line boundaries
struct alignas(64) PaddedCounter { int value; };
PaddedCounter counters[NUM_THREADS];  // 64 bytes apart -> separate cache lines
```
</Remark>
