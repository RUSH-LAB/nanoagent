---
sidebar_position: 2
---

# Mixed Precision Training

## Number Formats

| Format | Bits | Exponent | Mantissa | Range | Use case |
|--------|------|----------|----------|-------|----------|
| FP32 | 32 | 8 | 23 | $10^{\pm38}$ | Default precision |
| FP16 | 16 | 5 | 10 | $10^{\pm5}$ | Mixed precision (older GPUs) |
| BF16 | 16 | 8 | 7 | $10^{\pm38}$ | Mixed precision (Ampere+) |
| FP8 E4M3 | 8 | 4 | 3 | $\pm240$ | Forward pass (Hopper+) |
| FP8 E5M2 | 8 | 5 | 2 | $\pm57344$ | Backward pass (Hopper+) |

**Tip:** BF16 is preferred over FP16 for training because it has the same exponent range as FP32. FP16 requires loss scaling to avoid gradient underflow; BF16 does not.

## torch.amp (Automatic Mixed Precision)

```python
from torch.amp import autocast, GradScaler

# BF16 (preferred on Ampere+, no scaler needed)
for data, target in loader:
    optimizer.zero_grad()
    with autocast(device_type='cuda', dtype=torch.bfloat16):
        output = model(data)
        loss = criterion(output, target)
    loss.backward()
    optimizer.step()

# FP16 (requires GradScaler for loss scaling)
scaler = GradScaler()
for data, target in loader:
    optimizer.zero_grad()
    with autocast(device_type='cuda', dtype=torch.float16):
        output = model(data)
        loss = criterion(output, target)
    scaler.scale(loss).backward()
    scaler.unscale_(optimizer)
    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
    scaler.step(optimizer)
    scaler.update()
```

## Loss Scaling (FP16 Only)

FP16 has limited range. Small gradients ($<6 \times 10^{-8}$) underflow to zero. **Loss scaling** multiplies the loss by a large factor before backward, then divides the gradients after:

```
Forward:    FP16 (fast, less memory)
Loss:       Multiply by scale factor (e.g., 1024)
Backward:   FP16 gradients are larger, don't underflow
Unscale:    Divide gradients by scale factor
Update:     FP32 master weights (full precision accumulation)
```

The `GradScaler` automatically adjusts the scale factor:
- If no overflow/NaN: increase scale (more aggressive)
- If overflow/NaN: decrease scale, skip the update step

## What Runs in Which Precision

```python
# autocast automatically selects precision per operation:
# FP16/BF16: matmul, conv, linear, attention (compute-bound)
# FP32: softmax, layer norm, loss functions (precision-sensitive)
# FP32: optimizer state and weight updates (accumulation)
```

| Operation | Precision | Why |
|-----------|-----------|-----|
| Linear (matmul) | FP16/BF16 | Compute-bound, Tensor Cores |
| Convolution | FP16/BF16 | Compute-bound, Tensor Cores |
| BatchNorm/LayerNorm | FP32 | Reduction, needs precision |
| Softmax | FP32 | Exponentiation, overflow risk |
| Loss function | FP32 | Log, exp operations |
| Optimizer state | FP32 | Accumulation precision |
| Master weights | FP32 | Small updates would be lost in FP16 |

## Performance Impact

```python
# Speedup depends on operation type:
# Compute-bound ops (matmul): ~2x faster (Tensor Cores)
# Memory-bound ops (activation): ~2x faster (half the bytes)
# Precision-sensitive ops: no speedup (still FP32)

# Memory reduction:
# Model parameters: 2x less (FP32 -> FP16 activations)
# Activation memory: 2x less
# Gradient memory: 2x less
# Optimizer state: unchanged (still FP32)
# Net: ~1.5x less total GPU memory
```

**Tip:** Mixed precision training should be the default for any GPU training. It gives 1.5-2x speedup with virtually no accuracy loss. Use BF16 when available (Ampere+), FP16 with GradScaler on older hardware.
