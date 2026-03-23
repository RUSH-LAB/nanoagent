---
sidebar_position: 5
---

# Custom PyTorch Ops

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

<Code id="code-custom-ops-2" caption="```.">

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

<Code id="code-custom-ops-4" caption="```.">

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

## torch.library (PyTorch 2.1+)

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
**Tip:** Use C++/CUDA for performance-critical forward passes and rely on PyTorch's autograd for backward passes unless the backward is also a bottleneck. This gives you 80% of the performance benefit with 20% of the implementation effort.
</Remark>
