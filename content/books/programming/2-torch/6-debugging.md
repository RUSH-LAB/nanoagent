---
sidebar_position: 6
---

# Debugging

Debugging deep learning code is uniquely challenging. Unlike traditional software bugs that produce immediate errors, ML bugs often manifest as *silently wrong results*: the model trains, produces numbers, but those numbers are incorrect. Training might converge to a suboptimal loss, or the model might fail to generalize. This chapter covers the most common bugs, systematic debugging strategies, and the tools PyTorch provides for diagnosing issues.

## The Debugging Hierarchy

When something goes wrong with training, work through this checklist in order:

<Table id="tab-debugging-hierarchy" caption="Debugging checklist: work through in order from most to least common.">

| Priority | Category | Examples | How to Detect |
|----------|---------|---------|--------------|
| 1 | **Shape errors** | Wrong broadcasting, incorrect transpose | Assertions, explicit shape checks |
| 2 | **Device errors** | CPU/GPU mismatch | RuntimeError messages |
| 3 | **Data bugs** | Wrong labels, incorrect normalization, data leakage | Inspect random samples, check label distribution |
| 4 | **Numerical issues** | NaN/Inf, gradient explosion/vanishing | Monitor loss, grad norms, detect_anomaly() |
| 5 | **Hyperparameter issues** | LR too high/low, wrong schedule | Loss curves, learning rate sweeps |
| 6 | **Architecture bugs** | Wrong activation, missing layer, incorrect connection | Overfit a single batch first |
| 7 | **Training bugs** | Not zeroing grads, eval() not called, wrong loss | Code review, unit tests |

</Table>

## Anomaly Detection

PyTorch can track where NaN/Inf values originate by recording the operation that produced each tensor:

<Code id="code-anomaly-detection" caption="PyTorch anomaly detection pinpoints the exact operation that produces NaN.">

```python
# Enable anomaly detection (adds significant overhead, debug only)
torch.autograd.set_detect_anomaly(True)

# As a context manager (scoped to specific code)
with torch.autograd.detect_anomaly():
    output = model(input)
    loss = criterion(output, target)
    loss.backward()
    # If any operation produces NaN, PyTorch will raise an error
    # with the EXACT operation name and a traceback to where it was created

# Example error output:
# RuntimeError: Function 'LogSoftmaxBackward0' returned nan values in its 0th output.
# The above operation was created at:
#   File "model.py", line 42, in forward
#     return F.log_softmax(logits, dim=-1)
```

</Code>

<Remark id="rmk-anomaly-overhead">
**Anomaly detection overhead.** When enabled, PyTorch stores the Python stack trace for every operation, which:
- **Slows training by 2-5x** (extra memory allocation and bookkeeping)
- **Increases memory usage** (stack traces for every tensor)

Use it only to locate the source of NaN/Inf. Once found, disable it and fix the underlying issue. Do not leave it enabled in production training.
</Remark>

## Shape Debugging

Shape mismatches are the most common bug in deep learning code. They often produce incorrect results *without raising an error* (due to broadcasting):

<Code id="code-shape-debugging" caption="Systematic shape debugging with assertions and helper functions.">

```python
class MyAttention(nn.Module):
    def __init__(self, d_model, n_heads):
        super().__init__()
        assert d_model % n_heads == 0, f"d_model ({d_model}) must be divisible by n_heads ({n_heads})"
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.q_proj = nn.Linear(d_model, d_model)
        self.k_proj = nn.Linear(d_model, d_model)
        self.v_proj = nn.Linear(d_model, d_model)

    def forward(self, x):
        B, T, D = x.shape
        assert D == self.d_model, f"Expected d_model={self.d_model}, got {D}"

        q = self.q_proj(x)
        k = self.k_proj(x)
        v = self.v_proj(x)

        # Reshape for multi-head attention
        # (B, T, D) -> (B, T, H, D/H) -> (B, H, T, D/H)
        q = q.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)

        assert q.shape == (B, self.n_heads, T, self.head_dim), \
            f"q shape mismatch: expected {(B, self.n_heads, T, self.head_dim)}, got {q.shape}"

        attn = torch.matmul(q, k.transpose(-2, -1)) / (self.head_dim ** 0.5)
        assert attn.shape == (B, self.n_heads, T, T), \
            f"attn shape mismatch: expected {(B, self.n_heads, T, T)}, got {attn.shape}"

        return attn
```

</Code>

<Code id="code-debug-helpers" caption="Helper functions for debugging tensor values and shapes.">

```python
def debug_tensor(name, tensor):
    """Print comprehensive tensor diagnostics."""
    stats = {
        'shape': tensor.shape,
        'dtype': tensor.dtype,
        'device': tensor.device,
        'min': tensor.min().item(),
        'max': tensor.max().item(),
        'mean': tensor.float().mean().item(),
        'std': tensor.float().std().item(),
        'nan': tensor.isnan().sum().item(),
        'inf': tensor.isinf().sum().item(),
        'requires_grad': tensor.requires_grad,
    }
    parts = [f"{name}:"]
    parts.append(f"  shape={stats['shape']}, dtype={stats['dtype']}, device={stats['device']}")
    parts.append(f"  range=[{stats['min']:.4f}, {stats['max']:.4f}], "
                 f"mean={stats['mean']:.4f}, std={stats['std']:.4f}")
    if stats['nan'] > 0 or stats['inf'] > 0:
        parts.append(f"  WARNING: {stats['nan']} NaN, {stats['inf']} Inf values!")
    print('\n'.join(parts))

# Usage in forward pass
def forward(self, x):
    debug_tensor("input", x)
    x = self.encoder(x)
    debug_tensor("after_encoder", x)
    x = self.classifier(x)
    debug_tensor("logits", x)
    return x
```

</Code>

## NaN Detection and Prevention

<Code id="code-nan-detection" caption="Systematic NaN detection in the training loop.">

```python
def check_for_nan(model, loss, step):
    """Check for NaN in loss, parameters, and gradients."""
    issues = []

    if torch.isnan(loss):
        issues.append(f"NaN loss at step {step}")

    if torch.isinf(loss):
        issues.append(f"Inf loss at step {step} (value: {loss.item()})")

    for name, param in model.named_parameters():
        if torch.isnan(param).any():
            issues.append(f"NaN in parameter: {name}")
        if param.grad is not None:
            if torch.isnan(param.grad).any():
                issues.append(f"NaN in gradient: {name}")
            if torch.isinf(param.grad).any():
                issues.append(f"Inf in gradient: {name} (norm: {param.grad.norm():.2e})")

    if issues:
        for issue in issues:
            print(f"  [NaN CHECK] {issue}")
        raise ValueError(f"Numerical issues detected at step {step}")

# Integrate into training loop
for step, (data, target) in enumerate(loader):
    optimizer.zero_grad()
    output = model(data)
    loss = criterion(output, target)

    # Check BEFORE backward (catches forward-pass NaN)
    if step % 10 == 0:
        check_for_nan(model, loss, step)

    loss.backward()

    # Check AFTER backward (catches backward-pass NaN)
    if step % 10 == 0:
        for name, param in model.named_parameters():
            if param.grad is not None and torch.isnan(param.grad).any():
                print(f"NaN gradient in {name} at step {step}")
```

</Code>

<Table id="tab-nan-causes" caption="Common causes of NaN/Inf and their fixes.">

| Cause | How It Happens | Symptom | Fix |
|-------|---------------|---------|-----|
| LR too high | Large weight update overshoots | Loss spikes then NaN | Reduce LR; add warmup |
| Division by zero | `1/x` where `x` can be 0 | NaN in specific layer | Add epsilon: `x / (y + 1e-8)` |
| Log of zero/negative | `log(prob)` where `prob <= 0` | NaN in loss | Clamp: `torch.log(x.clamp(min=1e-8))` |
| Exp overflow | `exp(x)` where `x > 88` (FP32) | Inf then NaN | Use log-space: `log_softmax` instead of `softmax + log` |
| FP16 overflow | Gradients > 65504 | NaN with mixed precision | Use BF16, or increase GradScaler initial scale |
| FP16 underflow | Gradients below the smallest normal ($\approx 6 \times 10^{-5}$) lose precision in the subnormal range; full flush-to-zero near $6 \times 10^{-8}$ | Gradients become 0, loss plateaus | Use BF16, or GradScaler |
| Unstable normalization | LayerNorm/BatchNorm with zero variance | NaN after norm layer | Increase epsilon in norm layers |
| Attention score overflow | $QK^T/\sqrt{d}$ produces large values | NaN after softmax | Use scaled dot-product attention, or clamp scores |
| Incorrect loss function | Using loss that expects different input | Persistent NaN | Verify loss function API (log-probs vs logits) |

</Table>

<Remark id="rmk-nan-prevention">
**Defensive coding patterns for numerical stability:**

```python
# BAD: log can produce -inf or NaN
loss = -torch.log(probs)

# GOOD: clamp to prevent log(0)
loss = -torch.log(probs.clamp(min=1e-8))

# BETTER: use log_softmax (numerically stable log + softmax)
loss = F.cross_entropy(logits, targets)  # Uses log_softmax internally

# BAD: softmax then log (two passes, less stable)
probs = F.softmax(logits, dim=-1)
loss = -torch.log(probs[range(B), targets])

# GOOD: log_softmax (one pass, numerically stable)
log_probs = F.log_softmax(logits, dim=-1)
loss = -log_probs[range(B), targets].mean()

# BAD: division can produce Inf
normalized = x / x.norm()

# GOOD: add epsilon to denominator
normalized = x / (x.norm() + 1e-8)

# BEST: use built-in normalized function
normalized = F.normalize(x, dim=-1)  # Handles zero-norm internally
```
</Remark>

<Example id="ex-nan-end-to-end" name="Tracing a NaN from symptom to fix">

**Symptom.** A transformer trains fine for a few hundred steps, then the loss prints `nan` and never recovers. There is no Python exception: the model keeps running, but every subsequent loss is `nan`.

*Step 1: localize the operation.* Wrap one step in anomaly detection so PyTorch reports the exact backward op and the line where the offending tensor was created:

```python
with torch.autograd.detect_anomaly():
    output = model(input)
    loss = criterion(output, target)
    loss.backward()
```

The error points at `LogBackward0` created inside a custom loss that computes `-torch.log(probs)`.

<details>
<summary>Step 2: what is the underlying cause?</summary>

The custom loss takes `log` of a probability that can reach exactly `0` (for example, after an aggressive softmax saturates one logit). `log(0)` is `-inf`, and `-inf` propagated through the backward pass becomes `nan` in the gradients, which then corrupts the weights so that *every* later step produces `nan`. The forward loss looked finite at first only because the probability had not yet collapsed to zero.

</details>

<details>
<summary>Step 3: what is the fix?</summary>

Replace the manual `log` of a probability with a numerically stable formulation. Either clamp the argument, or better, fuse the log into the softmax with `log_softmax` / `cross_entropy`:

```python
# Before: -torch.log(probs)  can hit log(0) = -inf
# After:  let PyTorch fuse log and softmax for stability
loss = F.cross_entropy(logits, targets)
```

After the change, rerun the overfit-one-batch test (below) to confirm the loss now descends smoothly instead of diverging to `nan`.

</details>

This is the canonical loop: anomaly detection turns a silent `nan` into a named operation and source line (the *diagnosis*), the NaN-causes table maps that operation to a root cause, and the defensive-coding patterns supply the *fix*.

</Example>

## Memory Debugging

<Code id="code-memory-debugging" caption="GPU memory debugging: tracking allocation, finding leaks.">

```python
import torch

# Basic memory reporting
def print_memory():
    print(f"Allocated: {torch.cuda.memory_allocated() / 1e9:.2f} GB")
    print(f"Reserved:  {torch.cuda.memory_reserved() / 1e9:.2f} GB")
    print(f"Max Alloc: {torch.cuda.max_memory_allocated() / 1e9:.2f} GB")

# Track peak memory for a code block
torch.cuda.reset_peak_memory_stats()
# ... your code ...
peak = torch.cuda.max_memory_allocated() / 1e9
print(f"Peak memory: {peak:.2f} GB")

# Memory snapshot (PyTorch 2.1+) to visualize memory over time
torch.cuda.memory._record_memory_history(max_entries=100000)
# ... run training steps ...
torch.cuda.memory._dump_snapshot("memory_snapshot.pickle")
torch.cuda.memory._record_memory_history(enabled=None)  # Stop recording
# Visualize at: https://pytorch.org/memory_viz
```

</Code>

<Table id="tab-memory-budget" caption="Where GPU memory goes during training.">

| Component | Memory | Formula | Typical for 7B Model |
|-----------|--------|---------|---------------------|
| Model parameters | $4P$ bytes (FP32) or $2P$ (BF16) | (see formula) | 14 GB (BF16) |
| Gradients | $4P$ bytes (FP32) or $2P$ (BF16) | Same as params | 14 GB (BF16) |
| Optimizer state (Adam) | $8P$ bytes (m + v, FP32) | 2x parameters | 56 GB |
| Activations (for backward) | Depends on batch size and model | $O(B \times L \times D^2)$ | 10-50 GB |
| **Total** | (sum of rows) | ~$16P$ + activations | **94+ GB** |

</Table>

<Remark id="rmk-memory-budget-assumptions">
**Assumptions behind the budget.** The table above assumes a pure-FP32 setup, where parameters and gradients are stored in FP32 ($4P$ each) and Adam keeps two FP32 moments ($8P$). In a mixed-precision setup the layout shifts: parameters and gradients are held in BF16 ($2P$ each), but the optimizer keeps an FP32 master copy of the weights ($4P$) alongside the two FP32 moments ($8P$). The BF16 rows in the last column reflect this mixed-precision layout, so a complete mixed-precision budget adds the master copy: for a 7B model that is roughly $4P \approx 28$ GB on top of the 14 + 14 + 56 GB already listed. Either way the per-parameter cost lands near $16P$ to $20P$ before activations.
</Remark>

<Remark id="rmk-memory-leaks">
**Common memory leaks and their fixes:**

```python
# LEAK 1: Storing loss tensors (keeps entire computation graph in GPU memory)
losses = []
for batch in loader:
    loss = model(batch)
    losses.append(loss)            # BAD: keeps graph alive
    # FIX: losses.append(loss.item())  # .item() extracts Python scalar

# LEAK 2: Not clearing CUDA cache after large allocations
big_tensor = torch.randn(10000, 10000, device='cuda')
del big_tensor
# Memory is returned to PyTorch's cache but NOT to the OS
torch.cuda.empty_cache()  # Returns memory to CUDA driver (rarely needed)

# LEAK 3: Holding references to intermediate tensors
class BadModel(nn.Module):
    def forward(self, x):
        self.last_hidden = self.encoder(x)  # BAD: stored as attribute
        return self.decoder(self.last_hidden)
# FIX: Don't store intermediates, or detach them:
# self.last_hidden = self.encoder(x).detach()

# LEAK 4: Forgetting to delete tensors in evaluation
@torch.no_grad()
def evaluate(model, loader):
    all_preds = []
    for batch in loader:
        output = model(batch.cuda())
        all_preds.append(output.cpu())  # Move to CPU to free GPU memory
    return torch.cat(all_preds)
```
</Remark>

## The "Overfit One Batch" Test

The single most useful debugging technique: verify that your model can perfectly fit a single batch of training data.

<Code id="code-overfit-one-batch" caption="Overfit one batch: the first test for any new model.">

```python
def overfit_one_batch(model, dataset, device='cuda', steps=1000, lr=1e-3):
    """Verify model can memorize a single batch.
    If this fails, the model or training code has a bug."""

    model = model.to(device).train()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    # Get one batch
    loader = DataLoader(dataset, batch_size=32, shuffle=False)
    data, target = next(iter(loader))
    data, target = data.to(device), target.to(device)

    for step in range(steps):
        optimizer.zero_grad()
        output = model(data)
        loss = criterion(output, target)
        loss.backward()
        optimizer.step()

        if step % 100 == 0:
            acc = (output.argmax(1) == target).float().mean()
            print(f"Step {step}: loss={loss.item():.4f}, acc={acc:.2%}")

    # Should reach near-zero loss and ~100% accuracy
    final_acc = (model(data).argmax(1) == target).float().mean()
    assert final_acc > 0.99, f"Failed to overfit one batch! Final acc: {final_acc:.2%}"
    print("PASSED: model can overfit one batch")

# Run this BEFORE full training to catch bugs early
overfit_one_batch(model, train_dataset)
```

</Code>

<Remark id="rmk-overfit-failures">
**If overfit-one-batch fails, the bug is in your model or training code**, not in your data or hyperparameters. Common causes:

| Symptom | Likely Cause |
|---------|-------------|
| Loss does not decrease at all | Gradients not flowing (detach, wrong loss, frozen params) |
| Loss decreases but accuracy stays at random | Wrong loss function for the task |
| Loss goes to NaN immediately | Numerical issue (see NaN table above) |
| Loss decreases very slowly | LR too low, or model too small for the task |
| Loss oscillates wildly | LR too high |
| Accuracy saturates below 100% | Architecture cannot represent the mapping (too few params, wrong activation) |
</Remark>

## Reproducibility

<Code id="code-reproducibility" caption="Making training deterministic for debugging and reproducibility.">

```python
import torch
import numpy as np
import random

def set_seed(seed=42):
    """Set all random seeds for reproducibility."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)

    # Make CuDNN deterministic (may reduce performance)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False

    # Enable deterministic algorithms (PyTorch 2.0+)
    torch.use_deterministic_algorithms(True)
    # Note: some operations do not have deterministic implementations
    # and will raise an error. Set CUBLAS_WORKSPACE_CONFIG=:4096:8

set_seed(42)
```

</Code>

<Remark id="rmk-reproducibility-caveats">
**Full reproducibility requires controlling all sources of randomness:**

| Source | How to Control | Performance Impact |
|--------|---------------|-------------------|
| Python `random` | `random.seed(seed)` | None |
| NumPy | `np.random.seed(seed)` | None |
| PyTorch CPU | `torch.manual_seed(seed)` | None |
| PyTorch GPU | `torch.cuda.manual_seed_all(seed)` | None |
| CuDNN autotuner | `torch.backends.cudnn.benchmark = False` | Up to 2x slower (first few iterations) |
| CuDNN algorithms | `torch.backends.cudnn.deterministic = True` | Slight slowdown |
| Nondeterministic ops | `torch.use_deterministic_algorithms(True)` | Some ops slower or error |
| Data loading order | `DataLoader(shuffle=False)` or seeded `generator` | None |
| Multi-worker loading | `worker_init_fn` with deterministic seeds | None |
| Dropout | Controlled by PyTorch seed | None |
| Data augmentation | Controlled by NumPy/random seed | None |

**In practice:** Full determinism is useful for debugging but unnecessary (and slower) for production training. Use it to verify that a code change does not break training, then disable for actual runs.
</Remark>

## Debugging Checklist

<Table id="tab-debugging-checklist" caption="Systematic debugging checklist for ML training.">

| Step | Action | Catches |
|------|--------|---------|
| 1 | Overfit one batch | Model/code bugs, wrong loss function |
| 2 | Check input data (visualize samples, verify labels) | Data pipeline bugs, wrong preprocessing |
| 3 | Verify shapes at each layer | Broadcasting bugs, wrong dimensions |
| 4 | Monitor loss, gradient norms, LR per step | Training instability, bad hyperparams |
| 5 | Compare against a known baseline | Architecture bugs, missing components |
| 6 | Train on a small subset first | Verify learning before spending compute |
| 7 | Check train vs val gap | Overfitting or underfitting |
| 8 | Profile with PyTorch profiler | Performance bottlenecks |

</Table>
