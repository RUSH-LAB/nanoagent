---
sidebar_position: 3
---

# SIMD

Before GPUs dominated machine learning, CPUs ran all the math. What made CPUs fast enough for linear algebra was not clock speed -- it was **SIMD** (Single Instruction, Multiple Data), the ability to process multiple data elements with a single instruction. Understanding SIMD explains why aligned memory is faster, why contiguous arrays outperform random access, why quantization to INT8 speeds up CPU inference, and how CPU BLAS libraries achieve near-peak throughput. SIMD is also the CPU analog of GPU SIMT -- the same fundamental idea (data parallelism) expressed at a different scale.

## What Is SIMD?

SIMD extends the CPU with wide **vector registers** that hold multiple data elements. A single instruction operates on all elements simultaneously:

<Table id="tab-simd-generations" caption="x86 SIMD instruction set evolution, from 1999 to present.">

| ISA | Year | Register Width | Registers | Floats/Op | Doubles/Op | Key Addition |
|-----|------|---------------|-----------|-----------|------------|-------------|
| SSE | 1999 | 128-bit (XMM) | XMM0-XMM15 | 4 | 2 | Floating-point SIMD |
| SSE2 | 2001 | 128-bit | XMM0-XMM15 | 4 | 2 | Double precision, integer SIMD |
| AVX | 2011 | 256-bit (YMM) | YMM0-YMM15 | 8 | 4 | 3-operand form (non-destructive) |
| AVX2 | 2013 | 256-bit | YMM0-YMM15 | 8 | 4 | Integer 256-bit, FMA, gather |
| AVX-512 | 2017 | 512-bit (ZMM) | ZMM0-ZMM31 | 16 | 8 | Masking, scatter, 32 registers |

</Table>

<Code id="code-simd-1" caption="Scalar vs SIMD computation: processing 1 element vs 8 elements per instruction.">

```c
#include <immintrin.h>

int n = 1024;
float a[1024], b[1024], c[1024];

// ── Scalar: 1 element per instruction ──
for (int i = 0; i < n; i++) {
    c[i] = a[i] + b[i];           // 1 add per cycle
}
// Total: ~1024 add instructions

// ── SIMD (AVX): 8 elements per instruction ──
for (int i = 0; i < n; i += 8) {
    __m256 va = _mm256_load_ps(&a[i]);   // Load 8 floats (32 bytes, aligned)
    __m256 vb = _mm256_load_ps(&b[i]);   // Load 8 floats
    __m256 vc = _mm256_add_ps(va, vb);   // 8 parallel adds
    _mm256_store_ps(&c[i], vc);          // Store 8 floats
}
// Total: ~128 add instructions (8x fewer)
```

</Code>

<Remark id="rmk-simd-throughput">
**Theoretical throughput.** A modern CPU core with AVX-512 can execute 2 FMA (fused multiply-add) instructions per cycle, each operating on 16 FP32 values. That is $2 \times 16 \times 2 = 64$ FP32 FLOPS per cycle (FMA counts as 2 FLOPS). At 3 GHz, one core delivers 192 GFLOPS -- comparable to a low-end GPU. But unlike a GPU, a CPU has only 8-64 cores, so aggregate throughput is much lower.
</Remark>

## Common AVX Intrinsics

Intrinsics are C functions that map 1:1 to SIMD instructions. The naming convention is `_mm<width>_<op>_<type>`:

<Table id="tab-intrinsic-naming" caption="Intrinsic naming convention: _mm<width>_<operation>_<type>.">

| Component | Values | Meaning |
|-----------|--------|---------|
| Width | (none), `256`, `512` | 128-bit, 256-bit, 512-bit |
| Operation | `add`, `mul`, `fmadd`, `load`, `store`, etc. | The operation |
| Type | `ps` (packed single), `pd` (packed double), `epi32` (packed int32), `si256` (256-bit integer) | Data type |

</Table>

<Code id="code-simd-2" caption="Essential AVX/AVX2 intrinsics for ML-relevant computations.">

```c
#include <immintrin.h>

// ── Load and store ──
__m256 v = _mm256_load_ps(ptr);          // Load 8 floats (ptr must be 32-byte aligned)
__m256 v = _mm256_loadu_ps(ptr);         // Load 8 floats (unaligned, ~5% slower)
_mm256_store_ps(ptr, v);                 // Store 8 floats (aligned)
_mm256_storeu_ps(ptr, v);               // Store 8 floats (unaligned)

// ── Arithmetic ──
__m256 sum  = _mm256_add_ps(a, b);       // a + b (8 floats)
__m256 diff = _mm256_sub_ps(a, b);       // a - b
__m256 prod = _mm256_mul_ps(a, b);       // a * b
__m256 fma  = _mm256_fmadd_ps(a, b, c);  // a*b + c (fused, same latency as mul)

// ── Comparison and selection ──
__m256 mask = _mm256_cmp_ps(a, b, _CMP_GT_OQ);  // a > b ? all-1s : all-0s
__m256 result = _mm256_blendv_ps(b, a, mask);    // mask ? a : b (branchless select)

// ── Reduction (horizontal) ──
__m256 mx = _mm256_max_ps(a, b);         // Element-wise max
// Full horizontal sum requires multiple shuffles (no single instruction)

// ── Broadcast and set ──
__m256 v = _mm256_set1_ps(3.14f);        // All 8 elements = 3.14
__m256 v = _mm256_setzero_ps();          // All zeros
__m256 v = _mm256_broadcast_ss(&scalar); // Broadcast single float to all lanes
```

</Code>

<Code id="code-simd-fma-dot" caption="A complete SIMD dot product using FMA instructions.">

```c
float simd_dot(const float* a, const float* b, int n) {
    __m256 sum0 = _mm256_setzero_ps();
    __m256 sum1 = _mm256_setzero_ps();  // Two accumulators to hide FMA latency

    int i;
    for (i = 0; i + 15 < n; i += 16) {
        __m256 a0 = _mm256_loadu_ps(a + i);
        __m256 b0 = _mm256_loadu_ps(b + i);
        sum0 = _mm256_fmadd_ps(a0, b0, sum0);   // sum0 += a0 * b0

        __m256 a1 = _mm256_loadu_ps(a + i + 8);
        __m256 b1 = _mm256_loadu_ps(b + i + 8);
        sum1 = _mm256_fmadd_ps(a1, b1, sum1);   // sum1 += a1 * b1
    }

    sum0 = _mm256_add_ps(sum0, sum1);  // Combine accumulators

    // Horizontal sum: reduce 8 floats to 1
    __m128 hi = _mm256_extractf128_ps(sum0, 1);
    __m128 lo = _mm256_castps256_ps128(sum0);
    __m128 s = _mm_add_ps(lo, hi);         // 4 floats
    s = _mm_hadd_ps(s, s);                 // 2 floats
    s = _mm_hadd_ps(s, s);                 // 1 float
    float result = _mm_cvtss_f32(s);

    // Handle remaining elements (scalar cleanup)
    for (; i < n; i++) result += a[i] * b[i];
    return result;
}
```

</Code>

<Remark id="rmk-multiple-accumulators">
**Why use multiple accumulators?** FMA has a latency of 4-5 cycles but a throughput of 2 per cycle. A single accumulator creates a dependency chain: each FMA must wait for the previous one to finish. Using 2-4 independent accumulators lets the CPU pipeline execute multiple FMAs in flight, achieving near-peak throughput.
</Remark>

## Auto-Vectorization

Modern compilers can automatically generate SIMD code from scalar loops. This is the preferred approach -- let the compiler handle the intrinsics:

<Code id="code-simd-3" caption="Writing C code that the compiler can auto-vectorize.">

```c
// The compiler will vectorize this with -O2 -mavx2
void add_arrays(float* restrict a, const float* restrict b,
                const float* restrict c, int n) {
    for (int i = 0; i < n; i++) {
        a[i] = b[i] + c[i];
    }
}
// 'restrict' tells the compiler: a, b, c do not overlap in memory
// Without restrict, the compiler may not vectorize (aliasing could cause bugs)
```

</Code>

Check if vectorization happened:

<Code id="code-simd-4" caption="Compiler flags to report vectorization decisions.">

```bash
# GCC: show vectorization report
gcc -O2 -mavx2 -ftree-vectorize -fopt-info-vec-optimized source.c
# Output: "loop vectorized using 32 byte vectors"

gcc -O2 -mavx2 -fopt-info-vec-missed source.c
# Output: explains WHY a loop was NOT vectorized

# Clang: show vectorization report
clang -O2 -mavx2 -Rpass=loop-vectorize source.c
clang -O2 -mavx2 -Rpass-missed=loop-vectorize source.c

# Compile for current CPU (enables all supported ISA extensions)
gcc -O3 -march=native source.c
```

</Code>

<Table id="tab-simd-1" caption="Common auto-vectorization blockers and their fixes.">

| Blocker | Example | Why It Blocks | Fix |
|---------|---------|--------------|-----|
| Pointer aliasing | `a` and `c` might overlap | Compiler cannot reorder loads/stores | Use `restrict` keyword |
| Loop-carried dependency | `a[i] = a[i-1] + 1` | Each iteration depends on the previous | Restructure algorithm (e.g., prefix sum) |
| Function calls in loop | `a[i] = sin(b[i])` | Compiler cannot inline/vectorize arbitrary functions | Use vectorized math library (`-lmvec`, Intel SVML) |
| Complex control flow | `if (b[i] > 0) ...` in loop | Branches prevent uniform SIMD execution | Use branchless/mask operations, `_mm256_blendv_ps` |
| Non-unit stride | `a[i*3]` | Non-contiguous access cannot be vectorized efficiently | Restructure to unit stride access |
| Unknown trip count | `while (p != end)` | Compiler cannot plan vector iterations | Use counted loop with known bounds |

</Table>

<Remark id="rmk-auto-vec-tips">
**Practical tips for auto-vectorization:**
1. **Always use `-O2` or higher.** Vectorization is disabled at `-O0` and `-O1`.
2. **Use `restrict` on all pointer parameters** that do not alias.
3. **Prefer simple counted loops** (`for (int i = 0; i < n; i++)`) over complex iteration patterns.
4. **Avoid early exits** (`break`, `return`) inside loops.
5. **Use `-march=native`** to enable the widest SIMD available on your CPU.
6. **Check the vectorization report** before writing manual intrinsics -- the compiler may already be doing what you want.
</Remark>

## SIMD and SIMT: CPU vs GPU Parallelism

SIMD (CPU) and SIMT (GPU) both exploit data parallelism, but at different scales and with different tradeoffs:

<Table id="tab-simd-vs-simt" caption="Comparison of CPU SIMD and GPU SIMT execution models.">

| Property | CPU SIMD (AVX-512) | GPU SIMT (CUDA) |
|----------|-------------------|-----------------|
| Width | 8-16 elements per instruction | 32 threads per warp |
| Parallelism model | One instruction stream, wide operands | 32 program counters, lockstep execution |
| Divergence | Not possible (same instruction for all lanes) | Possible but expensive (serialized branches) |
| Memory access | Uniform load/store, hardware prefetch | Coalesced access required for efficiency |
| Programming | Intrinsics, auto-vectorization, or compiler | Write per-thread scalar code |
| Latency hiding | Out-of-order execution, prefetch | Massive thread count (warp switching) |
| Register file | 16-32 vector registers per core | 65536 registers per SM (shared across warps) |
| Typical scale | 8-64 cores, each with SIMD | 100+ SMs, each running 1000+ threads |

</Table>

<Remark id="rmk-simd-simt-mental-model">
**The unifying mental model.** Both SIMD and SIMT express the same idea: take a computation that applies independently to many data elements, and execute it on all elements simultaneously using wide hardware. On a CPU, you pack 8-16 values into a vector register and operate on them with one instruction. On a GPU, you launch thousands of threads that each operate on one element, and the hardware groups them into warps of 32 that execute in lockstep. The key constraint is the same: **divergence** (different elements needing different operations) kills performance on both architectures.
</Remark>

## SIMD in ML Libraries

You rarely need to write SIMD intrinsics for ML work. The BLAS and runtime libraries handle this internally:

<Table id="tab-simd-ml-libs" caption="How ML frameworks leverage SIMD on CPUs.">

| Library | CPU Backend | SIMD Used | What It Accelerates |
|---------|------------|-----------|-------------------|
| NumPy | OpenBLAS or MKL | AVX2/AVX-512 | Matrix multiply, elementwise ops |
| PyTorch (CPU) | MKL/MKL-DNN (oneDNN) | AVX2/AVX-512 | Convolutions, GEMM, batch norm |
| ONNX Runtime | CPU EP | AVX-512, VNNI | INT8/FP16 inference |
| llama.cpp | Custom kernels | AVX2/AVX-512, NEON | Quantized LLM inference |
| TensorFlow | Eigen, oneDNN | AVX2/AVX-512 | All CPU ops |

</Table>

<Code id="code-simd-quantization" caption="Why quantization benefits more from wider SIMD: more elements per register.">

```
Data type     Bytes   Elements per AVX-512 register   Relative throughput
---------     -----   ----------------------------   -------------------
FP64          8       8                               1x
FP32          4       16                              2x
FP16/BF16     2       32                              4x
INT8          1       64                              8x
INT4          0.5     128                             16x (with packing)
```

</Code>

<Remark id="rmk-simd-why-matters">
**Why understanding SIMD matters even if you never write intrinsics.** SIMD explains four things that every ML engineer encounters:

1. **Aligned memory is faster** -- SIMD loads from aligned addresses avoid crossing cache line boundaries and use faster instructions (`vmovaps` vs `vmovups`).
2. **Contiguous arrays beat random access** -- SIMD instructions operate on consecutive elements; scatter/gather from random addresses is 5-10x slower.
3. **CPU quantization works** -- INT8 inference fits 4x more elements per SIMD register than FP32, providing roughly 4x speedup for memory-bound operations (and the actual VNNI instruction computes INT8 dot products directly).
4. **Power-of-2 sizes are faster** -- SIMD widths are powers of 2, so arrays with lengths that are multiples of 16 (AVX-512) or 8 (AVX2) avoid the scalar cleanup loop that handles remaining elements.
</Remark>
