---
sidebar_position: 1
---

# x86 Basics

Understanding x86-64 assembly is not about writing kernels in assembly; it is about reading what the compiler produces. When a PyTorch operator is slow, when a C++ extension crashes with a segfault, or when you want to verify that the compiler vectorized your inner loop, the ability to read assembly transforms you from someone who guesses to someone who knows. This chapter covers the x86-64 register set, the most common instructions, calling conventions, and how to read compiler output.

## Registers

x86-64 has 16 general-purpose 64-bit registers. Each register serves a conventional role defined by the calling convention, but any register can hold any value:

<Table id="tab-x86-registers" caption="x86-64 general-purpose registers and their conventional roles (System V AMD64 ABI).">

| Register | ABI Role | Caller/Callee Saved | Notes |
|----------|---------|-------------------|-------|
| RAX | Return value | Caller-saved | Also used as accumulator |
| RBX | General purpose | Callee-saved | Preserved across function calls |
| RCX | 4th integer argument | Caller-saved | Also used for shift counts |
| RDX | 3rd integer argument | Caller-saved | Also upper 64 bits of 128-bit return |
| RSI | 2nd integer argument | Caller-saved | Source index for string ops |
| RDI | 1st integer argument | Caller-saved | Destination index for string ops |
| RSP | Stack pointer | Callee-saved | Must always point to valid stack |
| RBP | Base pointer | Callee-saved | Frame pointer (optional with `-fomit-frame-pointer`) |
| R8 | 5th integer argument | Caller-saved | |
| R9 | 6th integer argument | Caller-saved | |
| R10 | Temporary | Caller-saved | Static chain pointer in nested functions |
| R11 | Temporary | Caller-saved | |
| R12-R15 | General purpose | Callee-saved | Preserved across function calls |

</Table>

Each 64-bit register can be accessed at smaller widths:

<Code id="code-x86-reg-widths" caption="Register sub-widths: accessing the lower 32, 16, or 8 bits of a 64-bit register.">

```
RAX  [63..0]   full 64-bit register
EAX  [31..0]   lower 32 bits (writing EAX zero-extends to RAX)
AX   [15..0]   lower 16 bits (does NOT zero-extend)
AH   [15..8]   bits 15-8 (legacy, avoid in x86-64)
AL   [7..0]    lower 8 bits
```

</Code>

<Remark id="rmk-x86-zero-extend">
**The 32-bit write zero-extension rule.** Writing to a 32-bit register (e.g., `mov eax, 42`) automatically zero-extends the result into the full 64-bit register. This is why compilers often use `mov eax, 0` instead of `mov rax, 0`: it is one byte shorter in the encoding. Writing to 16-bit or 8-bit sub-registers does **not** zero-extend, which can cause subtle bugs with stale upper bits.
</Remark>

## Common Instructions

<Code id="code-x86-basics-1" caption="The most frequently encountered x86-64 instructions, grouped by category.">

```asm
; ── Data movement ──
mov rax, rbx            ; rax = rbx (register to register)
mov rax, [rbx]          ; rax = *(rbx) (load from memory)
mov [rbx], rax          ; *(rbx) = rax (store to memory)
mov rax, [rbx+rcx*8+16] ; rax = *(rbx + rcx*8 + 16) (scaled index)
movzx eax, byte [rsi]  ; zero-extend byte to 32 bits
movsxd rax, dword [rsi] ; sign-extend 32-bit to 64 bits

; ── Address calculation ──
lea rax, [rbx+rcx*4+8] ; rax = rbx + rcx*4 + 8 (NO memory access)
                         ; LEA is used for address arithmetic AND general math

; ── Arithmetic ──
add rax, rbx            ; rax += rbx
sub rax, 42             ; rax -= 42
imul rax, rbx           ; rax *= rbx (signed multiply)
imul rax, rbx, 10       ; rax = rbx * 10 (three-operand form)
inc rcx                 ; rcx++
neg rax                 ; rax = -rax
xor eax, eax            ; eax = 0 (fastest way to zero a register)

; ── Bitwise ──
and rax, 0xFF           ; mask lower byte
or rax, rbx             ; bitwise OR
shl rax, 3              ; left shift by 3 (multiply by 8)
shr rax, 1              ; logical right shift by 1 (unsigned divide by 2)
sar rax, 1              ; arithmetic right shift (signed divide by 2)

; ── Control flow ──
cmp rax, rbx            ; set flags based on rax - rbx (result discarded)
test rax, rax           ; set flags based on rax & rax (check if zero)
je label                ; jump if equal (ZF=1)
jne label               ; jump if not equal (ZF=0)
jl label                ; jump if less (signed)
jb label                ; jump if below (unsigned)
jg label                ; jump if greater (signed)
call function           ; push return address, jump to function
ret                     ; pop return address, jump back
```

</Code>

<Table id="tab-x86-addressing" caption="x86-64 addressing modes with examples and use cases.">

| Mode | Syntax | Example | Common Use |
|------|--------|---------|------------|
| Register | `reg` | `mov rax, rbx` | Variable in register |
| Immediate | `imm` | `mov rax, 42` | Constants |
| Direct | `[addr]` | `mov rax, [0x601000]` | Global variables |
| Register indirect | `[reg]` | `mov rax, [rbx]` | Pointer dereference |
| Base + displacement | `[reg+disp]` | `mov rax, [rbp-8]` | Local variables on stack |
| Base + index | `[reg+reg]` | `mov rax, [rbx+rcx]` | Array with byte-sized elements |
| Scaled index | `[reg+reg*s+disp]` | `mov rax, [rbx+rcx*8+16]` | Array of structs, matrix rows |

</Table>

<Remark id="rmk-lea-trick">
**LEA as a multi-purpose arithmetic instruction.** `lea rax, [rbx+rcx*4+8]` computes an address but does not access memory. Compilers use it for general integer arithmetic because it can compute `a + b*scale + offset` in a single instruction without modifying flags. Common patterns:

```asm
lea rax, [rdi+rdi*2]    ; rax = rdi * 3
lea rax, [rdi*8]        ; rax = rdi * 8
lea rax, [rdi+rdi*4]    ; rax = rdi * 5
lea rax, [rdi+rsi]      ; rax = rdi + rsi (without clobbering either)
```
</Remark>

## Reading Compiler Output

Use Compiler Explorer (godbolt.org) or `objdump` to see what the compiler generates:

<Code id="code-x86-basics-2" caption="Tools for inspecting compiler-generated assembly.">

```bash
# Compile to assembly (AT&T syntax, default)
gcc -S -O2 -o output.s source.c

# Compile to assembly (Intel syntax, more readable)
gcc -S -O2 -masm=intel -o output.s source.c

# Disassemble a compiled binary
objdump -d -M intel program | less

# Show only a specific function
objdump -d -M intel program | awk '/^[0-9a-f]+ <my_func>:$/,/^$/'
```

</Code>

<Code id="code-x86-basics-3" caption="A simple C function and its optimized assembly output.">

```c
// C code
int add(int a, int b) {
    return a + b;
}
```

</Code>

<Code id="code-x86-basics-4" caption="The compiler uses LEA instead of ADD because LEA can write to a different destination register without clobbering either input.">

```asm
; Generated assembly (gcc -O2, Intel syntax)
add:
    lea eax, [rdi+rsi]    ; eax = edi + esi (arguments in RDI, RSI)
    ret                    ; return value in EAX
```

</Code>

<Code id="code-x86-reading-optimized" caption="A more realistic example: reading optimized code for a dot product.">

```c
// C code
float dot(const float* restrict a, const float* restrict b, int n) {
    float sum = 0.0f;
    for (int i = 0; i < n; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}
```

```asm
; Key portion of gcc -O3 -march=native -ffast-math output (simplified):
; With reassociation enabled, the compiler auto-vectorizes with AVX,
; processing 8 floats per iteration (-ffast-math also licenses vfmadd)
.L3:
    vmovups  ymm1, [rdi+rax]       ; load 8 floats from a
    vfmadd231ps ymm0, ymm1, [rsi+rax]  ; ymm0 += a[i:i+8] * b[i:i+8]
    add      rax, 32               ; advance by 8 floats (32 bytes)
    cmp      rax, rcx
    jne      .L3
; Followed by horizontal reduction of ymm0 to a single float
```

</Code>

<Remark id="rmk-x86-compiler-good">
**The compiler is very good at optimization.** Before writing assembly or intrinsics, check if `-O2` or `-O3` already produces optimal code. Focus on writing C/C++ that the compiler can optimize:
- Use `restrict` to promise no pointer aliasing
- Mark helper functions `static inline`
- Avoid indirect calls (virtual functions, function pointers) in hot loops
- Use `__builtin_expect` for branch hints in rare error paths
- Compile with `-march=native` to enable all instructions your CPU supports
</Remark>

## Calling Convention (System V AMD64)

The calling convention defines how functions pass arguments and return values. All x86-64 Linux, macOS, and FreeBSD systems use the System V AMD64 ABI:

<Code id="code-x86-basics-5" caption="System V AMD64 calling convention summary.">

```
Integer/pointer arguments (in order): RDI, RSI, RDX, RCX, R8, R9
Floating-point arguments (in order):  XMM0, XMM1, ..., XMM7
Return value:    RAX (integer/pointer), XMM0 (floating-point)
                 RDX:RAX for 128-bit integer returns

Caller-saved (volatile):     RAX, RCX, RDX, RSI, RDI, R8-R11, XMM0-XMM15
Callee-saved (non-volatile): RBX, RBP, R12-R15
Stack alignment:             16-byte aligned BEFORE the CALL instruction
Red zone:                    128 bytes below RSP (leaf functions can use without adjusting RSP)
```

</Code>

<Code id="code-x86-calling-example" caption="How a multi-argument function call translates to register assignments.">

```c
// This function call:
result = foo(1, 2, 3, 4, 5, 6, 7, 8.0);

// Becomes:
// RDI=1, RSI=2, RDX=3, RCX=4, R8=5, R9=6
// 7 pushed onto stack (7th integer arg and beyond go on stack)
// XMM0=8.0 (first floating-point argument)
// CALL foo
// Result in RAX (if integer) or XMM0 (if float)
```

</Code>

<Table id="tab-x86-windows-vs-sysv" caption="Key differences between System V AMD64 (Linux/macOS) and Microsoft x64 (Windows) calling conventions.">

| Property | System V AMD64 | Microsoft x64 |
|----------|---------------|---------------|
| Integer args | RDI, RSI, RDX, RCX, R8, R9 | RCX, RDX, R8, R9 |
| Float args | XMM0-XMM7 | XMM0-XMM3 |
| Shadow space | None (red zone instead) | 32 bytes reserved by caller |
| Callee-saved | RBX, RBP, R12-R15 | RBX, RBP, RDI, RSI, R12-R15 |

</Table>

<Remark id="rmk-x86-calling-conv-ml">
**Why calling conventions matter for ML engineers.** Understanding calling conventions helps you:
1. **Debug segfaults** in C++/CUDA extensions: `gdb` backtraces show register state at each frame
2. **Read profiler output**: `perf record` annotates assembly with the calling convention
3. **Understand ABI compatibility**: mixing C and C++ in PyTorch extensions requires matching calling conventions
4. **Debug Python-C boundary crashes**: `pybind11` translates Python calls to the C ABI; mismatches cause subtle corruption
</Remark>

## FLAGS Register

The FLAGS register records the result of the most recent arithmetic or comparison instruction. Conditional jumps read these flags:

<Table id="tab-x86-flags" caption="Important x86 condition flags and their meanings.">

| Flag | Name | Set When | Used By |
|------|------|----------|---------|
| ZF | Zero Flag | Result is zero | `je`/`jz` (jump if zero) |
| SF | Sign Flag | Result is negative | `js` (jump if sign) |
| CF | Carry Flag | Unsigned overflow | `jb`/`jc` (jump if carry) |
| OF | Overflow Flag | Signed overflow | `jo` (jump if overflow) |

</Table>

<Remark id="rmk-cmp-vs-test">
**CMP vs TEST.** Both set flags without storing a result:
- `cmp rax, rbx` computes `rax - rbx` and sets flags (use for magnitude comparisons)
- `test rax, rax` computes `rax & rax` and sets flags (use for zero/non-zero checks)

The compiler prefers `test rax, rax` over `cmp rax, 0` because the encoding is shorter.
</Remark>
