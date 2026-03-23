---
sidebar_position: 6
---

# Debugging

## Anomaly Detection

PyTorch can track where NaN/Inf values originate:

<Code id="code-debugging-1" caption="PyTorch can track where NaN/Inf values originate.">

```python
# Enable anomaly detection (slow, use only for debugging)
torch.autograd.set_detect_anomaly(True)

# Or as a context manager
with torch.autograd.detect_anomaly():
    output = model(input)
    loss = criterion(output, target)
    loss.backward()  # Will show the EXACT operation that produced NaN
```

</Code>

<Remark id="rmk-debugging-1">
**Warning:** Anomaly detection adds significant overhead (2-3x slower). Only enable it when debugging.
</Remark>

## Shape Debugging

The most common bugs in deep learning are shape mismatches:

<Code id="code-debugging-2" caption="The most common bugs in deep learning are shape mismatches.">

```python
# Add shape assertions throughout your model
class MyModel(nn.Module):
    def forward(self, x):
        B, T, D = x.shape
        assert D == self.d_model, f"Expected d_model={self.d_model}, got {D}"

        q = self.q_proj(x)  # (B, T, D)
        k = self.k_proj(x)  # (B, T, D)

        # Reshape for multi-head attention
        q = q.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        assert q.shape == (B, self.n_heads, T, self.head_dim)

        attn = torch.matmul(q, k.transpose(-2, -1))
        assert attn.shape == (B, self.n_heads, T, T)
        return attn
```

</Code>

<Code id="code-debugging-3" caption="```.">

```python
# Quick shape debugging with named print
def debug_shape(name, tensor):
    print(f"{name}: shape={tensor.shape}, dtype={tensor.dtype}, "
          f"device={tensor.device}, range=[{tensor.min():.3f}, {tensor.max():.3f}]")
```

</Code>

## NaN Detection

<Code id="code-debugging-4" caption="Code example.">

```python
def check_for_nan(model, loss, step):
    """Check for NaN in loss and parameters."""
    if torch.isnan(loss):
        print(f"NaN loss at step {step}")
        for name, param in model.named_parameters():
            if param.grad is not None and torch.isnan(param.grad).any():
                print(f"  NaN gradient in {name}")
            if torch.isnan(param).any():
                print(f"  NaN parameter in {name}")
        raise ValueError("NaN detected")

# Use in training loop
for step, (data, target) in enumerate(loader):
    loss = model(data, target)
    check_for_nan(model, loss, step)
    loss.backward()
```

</Code>

Common causes of NaN:

<Table id="tab-debugging-1" caption="Common causes of NaN.">

| Cause | Symptom | Fix |
|-------|---------|-----|
| Learning rate too high | Loss explodes then NaN | Reduce LR, add warmup |
| Division by zero | NaN in specific layer | Add epsilon: `x / (y + 1e-8)` |
| Log of zero | NaN in loss | Clamp: `torch.log(x.clamp(min=1e-8))` |
| Overflow in FP16 | NaN with mixed precision | Use BF16 or increase loss scale |

</Table>

## Memory Profiling

<Code id="code-debugging-5" caption="Code example.">

```python
# Check GPU memory usage
print(f"Allocated: {torch.cuda.memory_allocated() / 1e9:.2f} GB")
print(f"Reserved:  {torch.cuda.memory_reserved() / 1e9:.2f} GB")
print(f"Max allocated: {torch.cuda.max_memory_allocated() / 1e9:.2f} GB")

# Find memory leaks
torch.cuda.reset_peak_memory_stats()
# ... run your code ...
print(f"Peak memory: {torch.cuda.max_memory_allocated() / 1e9:.2f} GB")

# Memory snapshot (PyTorch 2.1+)
torch.cuda.memory._record_memory_history()
# ... run code ...
torch.cuda.memory._dump_snapshot("memory_snapshot.pickle")
# Visualize at: https://pytorch.org/memory_viz
```

</Code>

<Code id="code-debugging-6" caption="```.">

```python
# Common memory issues and fixes:

# Issue: storing tensors in a list keeps them in GPU memory
losses = []
for batch in loader:
    loss = model(batch)
    losses.append(loss)        # Keeps entire computation graph!
    # Fix: losses.append(loss.item())  # Scalar, no graph

# Issue: not freeing intermediate tensors
x = model.encoder(input)      # Large tensor on GPU
output = model.decoder(x)
# Fix: del x; torch.cuda.empty_cache()  # Only if needed
```

</Code>

<Remark id="rmk-debugging-2">
**Tip:** The biggest memory consumers are usually (1) activations saved for backward, (2) optimizer states (Adam uses 2x model size), and (3) gradients. Use `torch.utils.checkpoint` (gradient checkpointing) to trade compute for memory.
</Remark>
