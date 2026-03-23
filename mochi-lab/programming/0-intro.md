# Welcome

Welcome to the programming journey. This textbook covers everything an ML engineer needs to build and ship models, from computing fundamentals to distributed training systems. The goal is not merely to teach you to *use* frameworks, but to understand what happens beneath the surface -- so that when something breaks, or when performance matters, you can reason from first principles.

## Who This Book Is For

This book is written for ML researchers and engineers who want to move beyond treating PyTorch as a black box. If you have ever wondered why `torch.compile` speeds up some models but not others, why your training is slower on 8 GPUs than you expected, or how a matrix multiplication actually executes on a Tensor Core, this book will give you the answers.

**Prerequisites.** Familiarity with Python and basic linear algebra. Prior experience with PyTorch is helpful but not required -- Chapter 2 builds it from scratch. No prior knowledge of CUDA, assembly, or systems programming is assumed.

## How to Read This Book

The chapters are designed to be read roughly in order, with each building on the previous. That said, the later chapters are largely self-contained and can be read independently if you have the relevant background.

| Chapter | What You Will Learn | When to Read |
|---------|-------------------|-------------|
| **[Introduction to Computing](intro-to-comp)** | How programs execute: CPU/GPU architecture, memory hierarchy, the abstraction stack, and high-performance computing | Start here if you want to understand the machine |
| **[Deep Learning with PyTorch](torch)** | Tensors, autograd, `nn.Module`, data loading, training loops, and debugging | Start here if you want to start building models immediately |
| **[CUDA and GPU Programming](cuda-and-gpu)** | Writing GPU kernels: CUDA, memory model, optimization, Triton, and custom ops | After Chapters 1-2, or when you need to write custom kernels |
| **[Assembly and Low-Level Programming](assembly)** | x86 basics, memory and stack, SIMD instructions | When you want to understand what the compiler produces |
| **[ML Systems](ml-systems)** | Distributed training, mixed precision, inference optimization, and profiling | When scaling training or deploying models |
| **[Supplementary Materials](supplement)** | Python tips, Linux/shell, and Git for ML | Reference material -- consult as needed |

## The Central Theme

A recurring theme throughout this book is the **tension between abstraction and performance**. High-level abstractions (Python, PyTorch, `torch.compile`) make you productive by hiding complexity. But performance-critical ML systems require understanding the layers beneath:

```
High-level:    torch.matmul(A, B)           -- easy to write
Mid-level:     cublasGemmEx(...)            -- explicit memory management
Low-level:     mad.f32 %f3, %f1, %f2, %f3  -- individual instructions
Silicon:       Tensor Core FMA              -- the actual computation
```

The best ML engineers can work at any level of this stack, choosing the right level of abstraction for each problem. This book teaches you to do exactly that.

## Conventions

- **Code examples** are in Python (PyTorch) unless otherwise noted. CUDA examples use C/C++ or Triton.
- **Performance numbers** are approximate and based on NVIDIA H100 / A100 GPUs and modern Intel/AMD CPUs as of 2025. Specific numbers will change with new hardware, but the relative relationships and principles are durable.
- **Diagrams** use ASCII art for portability. Read them alongside the text for the full picture.

## Getting Started

Start with [Introduction to Computing](intro-to-comp) to build your foundation, then work through PyTorch and CUDA before tackling ML systems. If you are already comfortable with computer architecture, jump directly to [Deep Learning with PyTorch](torch).
