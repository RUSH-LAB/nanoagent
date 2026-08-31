---
sidebar_position: 5
---

# Custom PyTorch Ops

When PyTorch's built-in operations are not sufficient (because you need a fused kernel, a novel algorithm, or integration with an external library), you can write custom operations in C++, CUDA, or Triton and register them as first-class PyTorch operators. This chapter covers the three main approaches: C++ extensions, CUDA extensions, and the modern `torch.library` API that integrates with `torch.compile`.

## Choosing Your Approach

<Table id="tab-custom-ops-approaches" caption="Approaches to custom PyTorch ops, from highest to lowest level.">

| Approach | Language | Integrates with `torch.compile` | Difficulty | When to Use |
|----------|---------|-------------------------------|-----------|-------------|
| `torch.compile` + Triton | Python/Triton | Automatic | Low | Most fusion tasks |
| `torch.autograd.Function` | Python | With `@torch.library.custom_op` | Low | Custom backward pass |
| `torch.library` (PyTorch 2.4+) | Python + C++/CUDA | Yes (with `register_fake`) | Medium | Production custom ops |
| `torch.utils.cpp_extension` | C++/CUDA | Manual | Medium-High | Direct C++/CUDA kernels |
| Pre-compiled shared library | C++/CUDA | Manual | High | Existing C++ codebases |

</Table>

## C++ Extension (torch.utils.cpp_extension)

Create a custom op in C++ that integrates with PyTorch's autograd:

<Code id="code-custom-ops-1" caption="Create a custom op in C++ that integrates with PyTorch's autograd.">

```cpp
// my_ops.cpp
#include <torch/extension.h>

torch::Tensor my_relu(torch::Tensor input) {
    return torch::clamp_min(input, 0);
}

// Expose to Python
PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("my_relu", &my_relu, "Custom ReLU");
}
```

</Code>

<Code id="code-custom-ops-2" caption="JIT-compiling and loading a C++ extension from Python.">

```python
# Build and use
from torch.utils.cpp_extension import load

my_ops = load(
    name='my_ops',
    sources=['my_ops.cpp'],
    verbose=True,
)

x = torch.randn(10, requires_grad=True)
y = my_ops.my_relu(x)
```

</Code>

## CUDA Extension

Add a CUDA kernel to your C++ extension:

<Code id="code-custom-ops-3" caption="Add a CUDA kernel to your C++ extension.">

```cuda
// my_kernel.cu
#include <torch/extension.h>
#include <cuda_runtime.h>

__global__ void silu_kernel(float* input, float* output, int n) {
    int idx = threadIdx.x + blockIdx.x * blockDim.x;
    if (idx < n) {
        float x = input[idx];
        output[idx] = x / (1.0f + expf(-x));  // SiLU = x * sigmoid(x)
    }
}

torch::Tensor silu_cuda(torch::Tensor input) {
    auto output = torch::empty_like(input);
    int n = input.numel();
    int threads = 256;
    int blocks = (n + threads - 1) / threads;

    silu_kernel<<<blocks, threads>>>(
        input.data_ptr<float>(),
        output.data_ptr<float>(),
        n
    );

    return output;
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("silu_cuda", &silu_cuda, "SiLU activation (CUDA)");
}
```

</Code>

<Code id="code-custom-ops-4" caption="Loading and using a CUDA extension from Python.">

```python
from torch.utils.cpp_extension import load

my_cuda_ops = load(
    name='my_cuda_ops',
    sources=['my_kernel.cu'],
    verbose=True,
)

x = torch.randn(1024, device='cuda')
y = my_cuda_ops.silu_cuda(x)
```

</Code>

## torch.library (PyTorch 2.4+)

The modern way to define custom ops that work with `torch.compile`:

<Code id="code-custom-ops-5" caption="The modern way to define custom ops that work with `torch.compile`.">

```python
import torch
from torch.library import custom_op

@custom_op("mylib::my_add", mutates_args=())
def my_add(x: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
    return x + y

@my_add.register_fake
def my_add_fake(x, y):
    """Tell torch.compile the output shape/dtype."""
    return torch.empty_like(x)

# Now works with torch.compile
@torch.compile
def f(x, y):
    return torch.ops.mylib.my_add(x, y)
```

</Code>

## Autograd Integration

Register backward for custom ops:

<Code id="code-custom-ops-6" caption="Register backward for custom ops.">

```python
class SiLU(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        sigmoid_x = torch.sigmoid(x)
        ctx.save_for_backward(x, sigmoid_x)
        return x * sigmoid_x

    @staticmethod
    def backward(ctx, grad_output):
        x, sigmoid_x = ctx.saved_tensors
        return grad_output * (sigmoid_x * (1 + x * (1 - sigmoid_x)))

# Use with CUDA kernel for forward, autograd for backward
class FastSiLU(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        output = my_cuda_ops.silu_cuda(x)
        ctx.save_for_backward(x)
        return output

    @staticmethod
    def backward(ctx, grad_output):
        x, = ctx.saved_tensors
        sigmoid_x = torch.sigmoid(x)
        return grad_output * (sigmoid_x * (1 + x * (1 - sigmoid_x)))
```

</Code>

<Remark id="rmk-custom-ops-1">
**The 80/20 rule for custom ops.** Use C++/CUDA for the performance-critical forward pass and rely on PyTorch's autograd for the backward pass unless the backward is also a bottleneck. This typically gives you most of the performance benefit for a fraction of the implementation effort.

**When you need a custom backward:**
- The standard autograd backward is numerically unstable (e.g., custom softmax with log-sum-exp trick)
- The backward requires fewer FLOPs than autograd computes (e.g., checkpointing, recomputation trade-offs)
- The forward and backward share computation that should not be duplicated

**Testing custom ops:** Always verify numerical correctness with `torch.autograd.gradcheck`:
```python
from torch.autograd import gradcheck
# Note: gradcheck requires float64, but the CUDA kernel shown above only
# supports float32. For production, either test the pure-PyTorch SiLU class
# or extend your kernel to handle multiple dtypes with AT_DISPATCH macros.
x = torch.randn(5, dtype=torch.float64, requires_grad=True, device='cuda')
assert gradcheck(SiLU.apply, (x,), eps=1e-6, atol=1e-4)
```
</Remark>

## Building and Distributing

<Code id="code-custom-ops-build" caption="Building custom ops with setup.py for distribution.">

```python
# setup.py (for distributing as an installable package)
from setuptools import setup
from torch.utils.cpp_extension import BuildExtension, CUDAExtension

setup(
    name='my_custom_ops',
    ext_modules=[
        CUDAExtension(
            name='my_custom_ops._C',
            sources=[
                'csrc/my_ops.cpp',       # C++ bindings
                'csrc/my_kernel.cu',     # CUDA kernels
            ],
            extra_compile_args={
                'cxx': ['-O3'],
                'nvcc': ['-O3', '--use_fast_math',
                         '-gencode=arch=compute_80,code=sm_80',   # A100
                         '-gencode=arch=compute_90,code=sm_90'],  # H100
            },
        ),
    ],
    cmdclass={'build_ext': BuildExtension},
)

# Install: pip install -e .
# Use:    import my_custom_ops._C as ops
```

</Code>

<Remark id="rmk-custom-ops-tips">
**Practical tips for custom ops:**

1. **Start with `load()` for development,** switch to `setup.py` for distribution. JIT compilation with `load()` recompiles on every Python process start (~10-30 seconds).

2. **Handle multiple dtypes.** Real models use FP32, FP16, and BF16. Use `AT_DISPATCH_FLOATING_TYPES_AND2(at::kHalf, at::kBFloat16, ...)` to generate kernels for all of these types (the plain `AT_DISPATCH_FLOATING_TYPES_AND_HALF` macro omits BFloat16):
   ```cpp
   AT_DISPATCH_FLOATING_TYPES_AND2(at::kHalf, at::kBFloat16,
       input.scalar_type(), "my_kernel", [&] {
           my_kernel<scalar_t><<<blocks, threads>>>(
               input.data_ptr<scalar_t>(), output.data_ptr<scalar_t>(), n);
       });
   ```

3. **Test with `torch.compile`.** If your op will be used inside compiled code, register a `FakeTensor` implementation (via `register_fake`) so the compiler knows the output shape and dtype without running the actual kernel.

4. **Profile before and after.** Measure with `torch.utils.benchmark.Timer` to verify your custom op is actually faster than the PyTorch equivalent.
</Remark>
