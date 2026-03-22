---
sidebar_position: 2
---

# Memory and Stack

## Stack Frames

Each function call creates a **stack frame**:

```
High addresses
+------------------+
| arg 7 (if any)   |  <- caller's stack
+------------------+
| return address   |  <- pushed by CALL
+------------------+
| saved RBP        |  <- callee pushes old RBP
+------------------+  <- RBP points here
| local var 1      |
| local var 2      |
| ...              |
+------------------+  <- RSP points here (top of stack)
Low addresses
```

```asm
; Function prologue
push rbp           ; Save caller's base pointer
mov rbp, rsp       ; Set up our base pointer
sub rsp, 32        ; Allocate 32 bytes for locals

; Function body
mov [rbp-8], rdi   ; Store first arg in local variable

; Function epilogue
mov rsp, rbp       ; Deallocate locals
pop rbp            ; Restore caller's base pointer
ret                ; Return to caller
```

**Tip:** When debugging segfaults in C/C++ extensions, `gdb`'s `backtrace` command walks the stack frames to show you the call chain that led to the crash.

## Heap Allocation

```c
// Stack allocation: fast, automatic, limited size (~8 MB default)
int array[1000];              // On the stack

// Heap allocation: slower, manual, unlimited (up to RAM)
int* array = malloc(1000 * sizeof(int));  // On the heap
free(array);                  // Must free manually

// PyTorch tensors use heap allocation via the CUDA/CPU allocator
// torch::empty({1000}) -> calls cudaMalloc or malloc internally
```

| Property | Stack | Heap |
|----------|-------|------|
| Speed | ~1 ns (just move RSP) | ~100 ns (allocator overhead) |
| Size | ~8 MB (thread stack) | Unlimited (up to RAM) |
| Lifetime | Function scope | Until explicitly freed |
| Fragmentation | None | Yes |

## Virtual Memory

Every process sees a flat 64-bit address space, mapped to physical memory by the OS:

```
0x0000000000000000  +-----------------+
                    | (unmapped)      |  <- NULL pointer dereference caught here
0x0000000000400000  +-----------------+
                    | Code (.text)    |
                    | Read-only data  |
                    | Globals (.data) |
                    | BSS (.bss)      |
                    +-----------------+
                    | Heap            |
                    |   grows down    |
                    |       v         |
                    |                 |
                    |       ^         |
                    |   grows up      |
                    | Stack           |
0x00007FFFFFFFFFFF  +-----------------+
```

**Tip:** When you see `cudaMalloc`, it allocates in the GPU's virtual address space, which is separate from the CPU's. `cudaMemcpy` copies between these two address spaces via PCIe or NVLink.

## Cache Lines and Alignment

Memory is fetched in **cache lines** of 64 bytes. Alignment matters:

```c
// Aligned access: one cache line fetch
float array[16];  // 16 * 4 = 64 bytes, fits in one cache line
float val = array[0];

// Misaligned struct: wastes space and cache bandwidth
struct Bad {
    char a;     // 1 byte + 7 padding
    double b;   // 8 bytes
    char c;     // 1 byte + 7 padding
};  // Total: 24 bytes

// Aligned struct: pack fields by size
struct Good {
    double b;   // 8 bytes
    char a;     // 1 byte
    char c;     // 1 byte + 6 padding
};  // Total: 16 bytes
```

```c
// Force alignment (useful for SIMD)
float data[256] __attribute__((aligned(32)));  // 32-byte aligned for AVX

// In Python/NumPy
import numpy as np
a = np.empty(256, dtype=np.float32)
print(a.ctypes.data % 32 == 0)  # Check 32-byte alignment
```

**Tip:** PyTorch tensors are typically 64-byte aligned, which is optimal for cache lines and SIMD. When writing custom C++ extensions, use `torch::empty` instead of `malloc` to get properly aligned memory.
