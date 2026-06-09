---
sidebar_position: 2
---

# Mixed Precision Training

Modern GPUs have specialized hardware (Tensor Cores) that compute matrix multiplications 2-8x faster in reduced precision (FP16, BF16, FP8) than in FP32. Mixed precision training exploits this by running the forward and backward passes in reduced precision while keeping a master copy of the weights in FP32 for accurate gradient accumulation. This gives 1.5-2x speedup and nearly 2x memory savings with virtually no accuracy loss. Mixed precision should be the default for all GPU training.

## Number Formats

The precision of a floating-point number is determined by its bit allocation between exponent (range) and mantissa (precision):

<Table id="tab-mixed-precision-formats" caption="Floating-point formats used in ML training and inference.">

| Format | Bits | Exponent | Mantissa | Dynamic Range | Precision (decimal digits) | Primary Use |
|--------|------|----------|----------|--------------|---------------------------|-------------|
| FP32 | 32 | 8 | 23 | $\pm 3.4 \times 10^{38}$ | ~7.2 | Master weights, optimizer states |
| TF32 | 19 | 8 | 10 | $\pm 3.4 \times 10^{38}$ | ~3.3 | Automatic on Ampere+ for matmul |
| FP16 | 16 | 5 | 10 | $\pm 6.5 \times 10^{4}$ | ~3.3 | Mixed precision (older GPUs) |
| BF16 | 16 | 8 | 7 | $\pm 3.4 \times 10^{38}$ | ~2.4 | Mixed precision (Ampere+) |
| FP8 E4M3 | 8 | 4 | 3 | $\pm 448$ | ~1.2 | Forward pass (Hopper+) |
| FP8 E5M2 | 8 | 5 | 2 | $\pm 57344$ | ~0.9 | Backward pass (Hopper+) |

</Table>

<Remark id="rmk-bf16-vs-fp16">
**BF16 vs FP16: why BF16 is preferred for training.** BF16 has the same 8-bit exponent as FP32, giving it the same dynamic range ($10^{\pm 38}$). This means gradients that are representable in FP32 are almost always representable in BF16 (with less precision, but without underflow). FP16 has only a 5-bit exponent, so gradients smaller than $6 \times 10^{-8}$ underflow to zero, which is common in deep networks with many layers. FP16 requires loss scaling to work around this; BF16 does not.

```
FP32:   S EEEEEEEE MMMMMMMMMMMMMMMMMMMMMMM   (1 + 8 + 23 = 32 bits)
BF16:   S EEEEEEEE MMMMMMM                    (1 + 8 + 7  = 16 bits)
FP16:   S EEEEE    MMMMMMMMMM                 (1 + 5 + 10 = 16 bits)
         ^^^^^^^^                              ^^^^^^^^^^
         Same exponent as FP32                 More mantissa bits than BF16
```
</Remark>

## torch.amp (Automatic Mixed Precision)

PyTorch's `autocast` context manager automatically selects the precision for each operation. Operations that benefit from Tensor Cores (matmul, conv) run in reduced precision; operations that need accuracy (softmax, layernorm, loss) run in FP32:

<Code id="code-mixed-precision-bf16" caption="BF16 mixed precision training (preferred on Ampere+ GPUs). No GradScaler needed.">

```python
from torch.amp import autocast

# BF16 (preferred on Ampere+, no loss scaling needed)
for data, target in loader:
    optimizer.zero_grad()
    with autocast(device_type='cuda', dtype=torch.bfloat16):
        output = model(data)
        loss = criterion(output, target)
    # Backward runs outside autocast but uses BF16 for gradients
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
    optimizer.step()
```

</Code>

<Code id="code-mixed-precision-fp16" caption="FP16 mixed precision training with GradScaler for loss scaling.">

```python
from torch.amp import autocast, GradScaler

# FP16 (requires GradScaler for loss scaling)
scaler = GradScaler()
for data, target in loader:
    optimizer.zero_grad()
    with autocast(device_type='cuda', dtype=torch.float16):
        output = model(data)
        loss = criterion(output, target)

    scaler.scale(loss).backward()        # Scale loss to prevent gradient underflow
    scaler.unscale_(optimizer)           # Unscale gradients for clipping
    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
    scaler.step(optimizer)               # Step only if no inf/nan gradients
    scaler.update()                      # Adjust scale factor
```

</Code>

## Loss Scaling (FP16 Only)

FP16 has limited dynamic range. Small gradients ($< 6 \times 10^{-8}$) underflow to zero, causing training to stall or diverge. **Loss scaling** multiplies the loss by a large factor before backward, effectively shifting the gradient distribution into FP16's representable range:

<Code id="code-loss-scaling-flow" caption="The mixed precision training data flow showing where each precision is used.">

```
Forward pass:
    Weights (FP32 master) ──cast──> FP16/BF16
    Input (FP16/BF16) ──matmul──> Activations (FP16/BF16)     [Tensor Cores]
    Activations ──softmax/norm──> Output (FP32)                [precision-sensitive]
    Output ──loss──> Loss (FP32)

Loss scaling (FP16 only):
    Loss (FP32) ──multiply by scale──> Scaled loss (FP32)

Backward pass:
    Scaled loss ──backward──> Scaled gradients (FP16)          [Tensor Cores]

Unscale and update:
    Scaled gradients ──divide by scale──> Gradients (FP32)
    If inf/nan detected: skip update, reduce scale factor
    If no overflow: update FP32 master weights, increase scale factor
```

</Code>

<Example id="ex-loss-scaling-underflow" caption="A gradient that underflows in FP16 survives after loss scaling.">

Consider a single gradient component with true value $g = 2^{-27} \approx 7.45 \times 10^{-9}$. The smallest positive value FP16 can represent (a subnormal) is $2^{-24} \approx 5.96 \times 10^{-8}$, so $g$ rounds to $0$ when stored in FP16. The contribution is lost and the parameter never updates.

Now apply a loss scale of $s = 65536 = 2^{16}$. The backward pass computes the scaled gradient $s \cdot g = 2^{-27} \cdot 2^{16} = 2^{-11} \approx 4.88 \times 10^{-4}$, which is comfortably inside FP16's normal range and stored without loss. After the backward pass, the scaler divides the gradient by $s$ in FP32 before the optimizer step: $4.88 \times 10^{-4} / 65536 = 2^{-27}$, recovering the original value at full FP32 precision. The same scale factor lifts the entire gradient tensor into range, so small gradients that would have vanished now drive real weight updates.

</Example>

<Remark id="rmk-grad-scaler-dynamics">
**GradScaler dynamics.** The scaler starts with a large scale factor (default 65536) and adjusts dynamically:
- Every N steps without overflow: multiply scale by 2 (more aggressive, better precision preservation)
- On any step with overflow/NaN: divide scale by 2 and skip the weight update

This means the first few steps may have skipped updates while the scaler finds the right range. Monitor `scaler.get_scale()`: if it keeps decreasing, the model has numerical stability issues independent of precision.
</Remark>

## What Runs in Which Precision

`autocast` maintains an internal list of operations and their target precision. Understanding this prevents debugging surprises:

<Table id="tab-precision-per-op" caption="Which operations run in reduced precision and which stay in FP32.">

| Operation | Precision under autocast | Reason |
|-----------|------------------------|--------|
| `torch.mm`, `torch.matmul` | FP16/BF16 | Compute-bound, Tensor Cores give 2-8x speedup |
| `torch.nn.Linear` | FP16/BF16 | Internally a matmul |
| `torch.nn.Conv1d/2d/3d` | FP16/BF16 | Compute-bound, Tensor Cores |
| Multi-head attention | FP16/BF16 | Q@K^T and attn@V are matmuls |
| `torch.nn.LayerNorm` | FP32 | Reduction over features, variance needs precision |
| `torch.nn.BatchNorm` | FP32 | Running mean/variance accumulation |
| `torch.softmax` | FP32 | Exponentiation can overflow in FP16 |
| `torch.nn.CrossEntropyLoss` | FP32 | Log-sum-exp needs precision |
| `torch.log`, `torch.exp` | FP32 | Transcendental functions, overflow risk |
| Optimizer step | FP32 | Small updates ($\text{lr} \times \text{grad}$) would vanish in FP16 |
| Master weights | FP32 | Accumulation of many small updates needs full precision |

</Table>

<Remark id="rmk-tf32">
**TF32: the invisible mixed precision.** On Ampere+ GPUs, cuBLAS and cuDNN automatically use TF32 for FP32 matmul and convolution operations. TF32 uses FP32 range (8-bit exponent) but only 10-bit mantissa, giving 8x throughput on Tensor Cores compared to full FP32. This happens by default, so you do not need `autocast`. To disable it (for debugging): `torch.backends.cuda.matmul.allow_tf32 = False`.
</Remark>

## Performance and Memory Impact

<Table id="tab-mixed-precision-speedup" caption="Performance and memory impact of mixed precision on different operation types.">

| Metric | FP32 Baseline | Mixed Precision (BF16) | Improvement |
|--------|--------------|----------------------|-------------|
| **Compute-bound ops** (matmul, conv) | 1x | 2-8x (Tensor Cores) | Depends on GPU generation |
| **Memory-bound ops** (activation, elementwise) | 1x | ~2x (half the bytes transferred) | Memory bandwidth limited |
| **Parameter memory** | 4 bytes/param | 6 bytes/param (2-byte working copy + 4-byte FP32 master) | ~1.5x increase |
| **Activation memory** | 4 bytes/element | 2 bytes/element | 2x reduction |
| **Gradient memory** | 4 bytes/param | 2 bytes/param | 2x reduction |
| **Optimizer state** (AdamW) | 8 bytes/param (m + v) | 8 bytes/param (still FP32) | No change |
| **Net training throughput** | 1x | 1.5-2x | Typical end-to-end |
| **Net GPU memory** | 1x | ~0.6-0.7x | Allows larger batch or model |

</Table>

<Table id="tab-tensor-core-throughput" caption="Tensor Core throughput by GPU generation and precision (dense, no sparsity).">

| GPU | FP32 (TFLOPS) | TF32 (TFLOPS) | FP16/BF16 (TFLOPS) | FP8 (TFLOPS) | INT8 (TOPS) |
|-----|--------------|---------------|-------------------|-------------|-------------|
| V100 | 15.7 | N/A | 125 | N/A | N/A |
| A100 | 19.5 | 156 | 312 | N/A | 624 |
| H100 | 66.9 | 495 | 990 | 1979 | 1979 |

</Table>

<Remark id="rmk-mixed-precision-default">
**Mixed precision should be the default.** There is almost no reason to train in pure FP32 on modern GPUs. The only exceptions are:
1. **Debugging numerical issues**: temporarily disable to isolate precision-related bugs
2. **Very small models** where Tensor Core overhead dominates the small matrix multiplications
3. **Specific operations** that are known to be numerically sensitive (usually handled by autocast's FP32 fallback list)

For new training code, start with BF16 on Ampere+ GPUs, or FP16 with GradScaler on older hardware.
</Remark>

## FP8 Training (Hopper+)

NVIDIA H100 GPUs introduce FP8 Tensor Cores with 2x throughput over FP16. FP8 training uses two formats:

<Code id="code-fp8-training" caption="FP8 mixed precision with per-tensor scaling (Transformer Engine).">

```python
# FP8 training with NVIDIA Transformer Engine
import transformer_engine.pytorch as te

# Replace nn.Linear with te.Linear for FP8 support
model = MyModel()
# te.Linear automatically handles FP8 casting with per-tensor scaling
model.ffn = te.Linear(hidden_dim, 4 * hidden_dim)

# Training loop uses fp8_autocast
with te.fp8_autocast(enabled=True):
    output = model(input)
    loss = criterion(output, target)
loss.backward()
optimizer.step()

# FP8 uses per-tensor scaling factors (not loss scaling):
# E4M3 (4-bit exponent, 3-bit mantissa): forward activations and weights
#   Higher precision (3 mantissa bits = 8 steps per binade), smaller range (+-448)
# E5M2 (5-bit exponent, 2-bit mantissa): gradients in backward
#   Lower precision (2 mantissa bits = 4 steps per binade), larger range (+-57344)
```

</Code>
