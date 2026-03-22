---
sidebar_position: 1
---

# x86 Basics

## Registers

x86-64 has 16 general-purpose 64-bit registers:

```
Register    Purpose (System V AMD64 ABI)
--------    ----------------------------
RAX         Return value, accumulator
RBX         Callee-saved
RCX         4th argument
RDX         3rd argument, return value (128-bit)
RSI         2nd argument
RDI         1st argument
RSP         Stack pointer (always valid)
RBP         Base pointer (callee-saved)
R8-R9       5th-6th arguments
R10-R11     Caller-saved temporaries
R12-R15     Callee-saved
```

Each register has sub-registers: `RAX` (64-bit), `EAX` (lower 32), `AX` (lower 16), `AL` (lower 8).

## Common Instructions

```asm
; Arithmetic
add rax, rbx       ; rax += rbx
sub rax, 42        ; rax -= 42
imul rax, rbx      ; rax *= rbx (signed)
inc rcx            ; rcx++

; Data movement
mov rax, rbx       ; rax = rbx
mov rax, [rbx]     ; rax = memory at address rbx
mov [rbx], rax     ; memory at rbx = rax
lea rax, [rbx+rcx*4+8]  ; rax = rbx + rcx*4 + 8 (address calc, no memory access)

; Control flow
cmp rax, rbx       ; set flags based on rax - rbx
je label           ; jump if equal (ZF=1)
jne label          ; jump if not equal
jl label           ; jump if less (signed)
call function      ; push return addr, jump to function
ret                ; pop return addr, jump back
```

## Reading Compiler Output

Use Compiler Explorer (godbolt.org) or `objdump` to see what the compiler generates:

```bash
# Compile with debug symbols and no optimization
gcc -S -O0 -o output.s source.c

# With optimization (what actually runs)
gcc -S -O2 -o output.s source.c

# Disassemble a binary
objdump -d -M intel program | less
```

```c
// C code
int add(int a, int b) {
    return a + b;
}
```

```asm
; Generated assembly (-O2)
add:
    lea eax, [rdi+rsi]    ; rax = rdi + rsi (first two args)
    ret
```

**Tip:** The compiler is very good at optimization. Before writing assembly, check if `-O2` or `-O3` already produces optimal code. Focus on writing C/C++ that the compiler can optimize (avoid aliasing, use `restrict`, mark functions `inline`).

## Calling Convention (System V AMD64)

```
Arguments:  RDI, RSI, RDX, RCX, R8, R9 (integers/pointers)
            XMM0-XMM7 (floating point)
Return:     RAX (integer), XMM0 (float)
Caller-saved: RAX, RCX, RDX, RSI, RDI, R8-R11, XMM0-XMM15
Callee-saved: RBX, RBP, R12-R15
Stack:      16-byte aligned before CALL instruction
```

```c
// This function call:
result = foo(1, 2, 3, 4, 5, 6, 7);

// Becomes:
// RDI=1, RSI=2, RDX=3, RCX=4, R8=5, R9=6
// 7 pushed onto stack (7th arg and beyond go on stack)
// CALL foo
// Result in RAX
```

**Tip:** Understanding calling conventions helps you read stack traces, debug segfaults, and understand ABI compatibility issues between C and Python extensions.
