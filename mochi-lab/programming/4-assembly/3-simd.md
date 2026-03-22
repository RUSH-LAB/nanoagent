---
sidebar_position: 3
---

# SIMD

## What Is SIMD?

**SIMD** (Single Instruction, Multiple Data) processes multiple data elements with one instruction. Modern x86 CPUs have vector registers that can hold multiple floats:

```
SSE:  128-bit registers (XMM0-XMM15) -> 4 floats or 2 doubles
AVX:  256-bit registers (YMM0-YMM15) -> 8 floats or 4 doubles
AVX-512: 512-bit registers (ZMM0-ZMM31) -> 16 floats or 8 doubles
```

```c
// Scalar: process 1 element per instruction
for (int i = 0; i < n; i++) {
    c[i] = a[i] + b[i];  // 1 add per cycle
}

// SIMD (AVX): process 8 elements per instruction
for (int i = 0; i < n; i += 8) {
    __m256 va = _mm256_load_ps(&a[i]);
    __m256 vb = _mm256_load_ps(&b[i]);
    __m256 vc = _mm256_add_ps(va, vb);    // 8 adds per cycle
    _mm256_store_ps(&c[i], vc);
}
```

## Common AVX Intrinsics

```c
#include <immintrin.h>

// Load and store
__m256 v = _mm256_load_ps(ptr);      // Load 8 floats (aligned)
__m256 v = _mm256_loadu_ps(ptr);     // Load 8 floats (unaligned)
_mm256_store_ps(ptr, v);             // Store 8 floats (aligned)

// Arithmetic
__m256 sum = _mm256_add_ps(a, b);    // a + b (8 floats)
__m256 prod = _mm256_mul_ps(a, b);   // a * b
__m256 fma = _mm256_fmadd_ps(a, b, c); // a*b + c (fused, 1 cycle)

// Horizontal operations
__m256 max = _mm256_max_ps(a, b);    // Element-wise max

// Broadcast
__m256 v = _mm256_set1_ps(3.14f);    // All 8 elements = 3.14
```

## Auto-Vectorization

Modern compilers can automatically generate SIMD code:

```c
// The compiler will vectorize this with -O2 -mavx2
void add_arrays(float* restrict a, float* restrict b,
                float* restrict c, int n) {
    for (int i = 0; i < n; i++) {
        c[i] = a[i] + b[i];
    }
}
```

Check if vectorization happened:

```bash
# GCC: show vectorization report
gcc -O2 -mavx2 -ftree-vectorize -fopt-info-vec source.c

# Clang
clang -O2 -mavx2 -Rpass=loop-vectorize source.c
```

Things that prevent auto-vectorization:

| Blocker | Example | Fix |
|---------|---------|-----|
| Pointer aliasing | `a` and `c` might overlap | Use `restrict` keyword |
| Data dependencies | `a[i] = a[i-1] + 1` | Restructure algorithm |
| Function calls | `a[i] = sin(b[i])` | Use vectorized math library |
| Complex control flow | `if (b[i] > 0)` in loop | Use branchless/mask operations |

## Connection to GPU SIMT

SIMD and SIMT are related but different:

| Property | CPU SIMD (AVX) | GPU SIMT (CUDA) |
|----------|---------------|-----------------|
| Width | 8-16 floats | 32 threads (warp) |
| Control | Single instruction stream | Each thread has a program counter |
| Divergence | Not possible (same instruction) | Possible but expensive |
| Memory | Uniform load/store | Coalesced access patterns |
| Programming | Intrinsics or auto-vectorization | Write per-thread code |

**Tip:** The conceptual model is the same: process multiple data elements simultaneously. On CPUs, you think in terms of vector registers; on GPUs, you think in terms of warps. Both require aligned, contiguous memory access for peak performance.

## SIMD in ML Libraries

Most ML math libraries use SIMD internally:

```
NumPy    -> MKL/OpenBLAS    -> AVX/AVX-512 for CPU BLAS
PyTorch  -> MKL/cuBLAS      -> AVX (CPU) / CUDA cores (GPU)
ONNX RT  -> CPU EP          -> AVX-512 for inference
```

**Tip:** You rarely need to write SIMD intrinsics for ML work. But understanding SIMD explains why (1) aligned memory is faster, (2) operations on contiguous arrays are faster than random access, and (3) CPU inference benefits from quantization to INT8 (more elements per SIMD register).
