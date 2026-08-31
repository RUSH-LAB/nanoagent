---
sidebar_position: 5
---

# Training Loop

The training loop is where everything comes together: data loading, forward pass, loss computation, backward pass, and optimizer step. This chapter presents a production-quality training loop with mixed precision, gradient clipping, learning rate scheduling, and checkpointing, and explains *why* each component is there.

## Complete Training Loop

<Code id="code-training-loop-complete" caption="Production-quality training loop with mixed precision and all standard components.">

```python
import torch
import torch.nn as nn
from torch.amp import GradScaler, autocast

def train(model, train_loader, val_loader, epochs, lr=3e-4):
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = model.to(device)

    # Optimizer: AdamW is the standard for transformers
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=lr,
        weight_decay=0.01,       # L2 regularization (decoupled from LR)
        betas=(0.9, 0.999),      # Momentum and RMSProp coefficients
        eps=1e-8,                # Numerical stability
    )

    # Learning rate schedule: OneCycle (cosine warmup + cosine decay).
    # OneCycleLR ignores the optimizer's lr: it starts at max_lr/div_factor
    # (default max_lr/25), ramps UP to max_lr with a cosine curve, then anneals
    # down to max_lr/(div_factor*final_div_factor). The start/end LRs are set by
    # div_factor and final_div_factor, not by the optimizer's lr.
    total_steps = len(train_loader) * epochs
    warmup_steps = int(0.1 * total_steps)    # 10% warmup
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer,
        max_lr=lr,
        total_steps=total_steps,
        pct_start=warmup_steps / total_steps,
        anneal_strategy='cos',
    )

    # Mixed precision: GradScaler for FP16 (not needed for BF16)
    use_bf16 = torch.cuda.is_bf16_supported()
    amp_dtype = torch.bfloat16 if use_bf16 else torch.float16
    scaler = GradScaler(enabled=not use_bf16)  # Only needed for FP16

    criterion = nn.CrossEntropyLoss()
    best_val_loss = float('inf')
    global_step = 0

    for epoch in range(epochs):
        # ===== Training Phase =====
        model.train()
        total_loss = 0
        num_batches = 0

        for batch_idx, (data, target) in enumerate(train_loader):
            data = data.to(device, non_blocking=True)
            target = target.to(device, non_blocking=True)

            # 1. Zero gradients
            optimizer.zero_grad(set_to_none=True)  # set_to_none=True saves memory

            # 2. Forward pass with mixed precision
            with autocast(device_type='cuda', dtype=amp_dtype):
                output = model(data)
                loss = criterion(output, target)

            # 3. Backward pass (scaled for FP16 stability)
            scaler.scale(loss).backward()

            # 4. Gradient clipping (unscale first, then clip, then step)
            scaler.unscale_(optimizer)
            grad_norm = torch.nn.utils.clip_grad_norm_(
                model.parameters(), max_norm=1.0
            )

            # 5. Optimizer step (scaler skips step if gradients contain Inf/NaN)
            scaler.step(optimizer)
            scaler.update()

            # 6. Learning rate step (per-iteration, not per-epoch)
            scheduler.step()

            # Logging
            total_loss += loss.item()
            num_batches += 1
            global_step += 1

            if global_step % 100 == 0:
                avg_loss = total_loss / num_batches
                current_lr = scheduler.get_last_lr()[0]
                print(f"Step {global_step} | Loss: {avg_loss:.4f} | "
                      f"Grad Norm: {grad_norm:.2f} | LR: {current_lr:.2e}")

        # ===== Validation Phase =====
        val_loss, val_acc = evaluate(model, val_loader, criterion, device, amp_dtype)

        print(f"\nEpoch {epoch+1}/{epochs} | "
              f"Train Loss: {total_loss/num_batches:.4f} | "
              f"Val Loss: {val_loss:.4f} | Val Acc: {val_acc:.2%}")

        # Save best model
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            save_checkpoint(model, optimizer, scheduler, epoch, 'best_model.pt')

    return model
```

</Code>

<Remark id="rmk-training-order">
**The order of operations matters.** Each step in the training loop has a specific reason:

```
zero_grad()     # Must be FIRST: clear stale gradients from previous step
forward()       # Compute predictions (inside autocast for mixed precision)
loss.backward() # Compute gradients (inside scaler.scale for FP16)
unscale_()      # Convert gradients back to FP32 (for gradient clipping)
clip_grad()     # Clip AFTER unscaling, BEFORE optimizer step
step()          # Update weights (scaler.step checks for Inf/NaN)
scaler.update() # Adjust loss scale for next iteration
scheduler.step() # Update learning rate
```

Changing the order (e.g., clipping before unscaling, or scheduling before stepping) will produce incorrect results.
</Remark>

## Evaluation

<Code id="code-evaluation" caption="Evaluation function with mixed precision and multiple metrics.">

```python
@torch.no_grad()
def evaluate(model, loader, criterion, device, amp_dtype=torch.bfloat16):
    """Evaluate model on a dataset. Returns (loss, accuracy)."""
    model.eval()  # CRITICAL: disables dropout and batch norm training mode
    total_loss = 0
    correct = 0
    total = 0

    for data, target in loader:
        data = data.to(device, non_blocking=True)
        target = target.to(device, non_blocking=True)

        with torch.autocast(device_type='cuda', dtype=amp_dtype):
            output = model(data)
            loss = criterion(output, target)

        total_loss += loss.item() * target.size(0)  # Weight by batch size
        pred = output.argmax(dim=1)
        correct += (pred == target).sum().item()
        total += target.size(0)

    model.train()  # Restore training mode

    return total_loss / total, correct / total
```

</Code>

<Remark id="rmk-eval-pitfalls">
**Common evaluation mistakes:**

| Mistake | Consequence | Fix |
|---------|------------|-----|
| Forgetting `model.eval()` | Dropout active, BN uses batch stats | Add `model.eval()` before validation |
| Forgetting `torch.no_grad()` | Wastes memory storing activations | Wrap eval in `@torch.no_grad()` |
| Averaging loss per batch (not per sample) | Wrong average if last batch is smaller | Weight by batch size: `loss * batch_size` |
| Not restoring `model.train()` after eval | Dropout stays off, BN uses running stats | Add `model.train()` after validation |
| Reporting train loss as validation loss | Misleading metrics | Use separate data loader |
</Remark>

## Mixed Precision Training

Mixed precision uses lower-precision floating point (FP16 or BF16) for most operations while keeping a master copy of weights in FP32 for numerical stability:

<Code id="code-mixed-precision" caption="Mixed precision training: BF16 (preferred) and FP16 (with GradScaler).">

```python
# ===== Option 1: BF16 (preferred on Ampere+ GPUs) =====
# No GradScaler needed (BF16 has same exponent range as FP32)
with torch.autocast(device_type='cuda', dtype=torch.bfloat16):
    output = model(data)
    loss = criterion(output, target)

loss.backward()          # Gradients computed in BF16
optimizer.step()         # Optimizer updates master FP32 weights


# ===== Option 2: FP16 (needed on V100) =====
# GradScaler prevents gradient underflow in FP16
scaler = torch.amp.GradScaler()

with torch.autocast(device_type='cuda', dtype=torch.float16):
    output = model(data)
    loss = criterion(output, target)

scaler.scale(loss).backward()    # Scale loss to prevent gradient underflow
scaler.unscale_(optimizer)       # Unscale for gradient clipping
torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
scaler.step(optimizer)           # Skip step if gradients contain Inf/NaN
scaler.update()                  # Adjust scale factor
```

</Code>

<Remark id="rmk-mixed-precision-what-runs-where">
**What runs in which precision.** `torch.autocast` does not convert everything to FP16/BF16. It maintains a list of operations and their preferred precision:

| Operation Type | Precision Under autocast | Why |
|---------------|-------------------------|-----|
| GEMM (linear, matmul, conv) | FP16/BF16 | Tensor Cores give 8-16x speedup |
| Elementwise (ReLU, GELU) | FP16/BF16 | Memory-bound, benefits from smaller tensors |
| Reduction (sum, mean, norm) | FP32 | Accumulation needs higher precision |
| Softmax | FP32 | Numerical stability (exp overflow) |
| Loss computation | FP32 | Log, exp need precision |
| Batch norm | FP32 | Running stats need precision |
| Layer norm | Depends | Some implementations use FP32 internally |

Autocast handles this automatically, so you do not need to manually cast tensors. It inserts casts at operation boundaries.
</Remark>

<Table id="tab-mixed-precision-savings" caption="Memory and speed savings from mixed precision.">

| Metric | FP32 | Mixed Precision (BF16/FP16) | Savings |
|--------|------|---------------------------|---------|
| Model weights memory | $4P$ bytes | $4P$ (master) + $2P$ (working) = $6P$ | None (need master copy) |
| Activation memory | $4A$ bytes | $2A$ bytes | 2x |
| Gradient memory | $4P$ bytes | $2P$ bytes | 2x |
| GEMM throughput | Peak FP32 | 8-16x faster (Tensor Cores) | 8-16x |
| Memory bandwidth | Baseline | ~2x (half the data to move) | 2x |
| **Net training speedup** | Baseline | **1.5-3x** | Depends on model |

</Table>

## Optimizers

<Table id="tab-optimizers" caption="Common optimizers: properties, typical use, and hyperparameters.">

| Optimizer | Key Property | Typical Use | Default Hyperparams |
|-----------|-------------|-------------|-------------------|
| SGD | Simple, well-understood | CNNs, when compute budget is large | `lr=0.1`, `momentum=0.9` |
| SGD + Nesterov | Better convergence than vanilla SGD | CNNs with cosine schedule | `lr=0.1`, `momentum=0.9`, `nesterov=True` |
| Adam | Adaptive per-parameter LR | General default | `lr=3e-4`, `betas=(0.9, 0.999)` |
| AdamW | Adam with decoupled weight decay | **Transformers (standard)** | `lr=3e-4`, `wd=0.01` |
| Adafactor | Memory-efficient Adam (no 2nd moment) | Very large models (memory-constrained) | `lr=1e-3` |
| LAMB | Layer-wise adaptive rates | Large-batch training | `lr=1e-3` |
| Lion | Sign-based optimizer | Recent alternative to Adam | `lr=3e-4`, `betas=(0.9, 0.99)` |

</Table>

<Remark id="rmk-optimizer-memory">
**Optimizer memory overhead.** The optimizer stores state for each parameter:

| Optimizer | State per Parameter | Total Memory (for $P$ params) |
|-----------|-------------------|------------------------------|
| SGD | None (or momentum buffer: $P$) | $0$ or $4P$ bytes |
| SGD + momentum | Momentum buffer | $4P$ bytes |
| Adam/AdamW | 1st moment ($m$) + 2nd moment ($v$) | $8P$ bytes |
| Adam + FP32 master weights | Master weights + $m$ + $v$ | $12P$ bytes |
| Adafactor | Row + column factors (no full 2nd moment) | $O(n+m)$ per $n \times m$ matrix (sublinear), summed over all matrices |

For a 7B parameter model in FP32: Adam requires 7B * 8 = 56 GB just for optimizer states. This is why large model training uses optimizer state sharding (ZeRO/FSDP) and lower-precision optimizers.
</Remark>

## Learning Rate Schedules

<Code id="code-lr-schedules" caption="Common learning rate schedules for transformer training.">

```python
# 1. Cosine annealing (most common for transformers)
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
    optimizer, T_max=total_epochs, eta_min=lr * 0.01
)

# 2. OneCycleLR (warmup + cosine in one)
scheduler = torch.optim.lr_scheduler.OneCycleLR(
    optimizer, max_lr=lr, total_steps=total_steps,
    pct_start=0.1,  # 10% warmup
    anneal_strategy='cos',
)

# 3. Linear warmup + cosine decay (LLM standard)
import math
from torch.optim.lr_scheduler import LambdaLR

def lr_lambda(step):
    if step < warmup_steps:
        return step / warmup_steps          # Linear warmup
    progress = (step - warmup_steps) / (total_steps - warmup_steps)
    return 0.5 * (1 + math.cos(math.pi * progress))  # Cosine decay

scheduler = LambdaLR(optimizer, lr_lambda)

# 4. Step decay (legacy, for CNNs)
scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=30, gamma=0.1)
```

</Code>

<Remark id="rmk-lr-warmup">
**Why warmup is necessary.** At initialization, the model produces random outputs and the loss landscape is highly curved. A large learning rate at this point can push parameters to extreme values, causing divergence or NaN. Warmup gradually increases the LR from near-zero to the target, allowing the model to settle into a reasonable region of parameter space first.

| Setting | Without Warmup | With Warmup |
|---------|---------------|-------------|
| Small LR (1e-5) | Usually works but slow | Not needed |
| Medium LR (3e-4) | Sometimes diverges | Stable |
| Large LR (1e-3) | Often diverges | Usually stable |
| Large batch training | Frequently diverges | Required |

**Common warmup lengths:** 1-10% of total training steps. LLM training typically uses 1-2% warmup with thousands of total steps.
</Remark>

<Example id="ex-lr-and-memory-trace">

Two short computations tie the schedule and optimizer-memory tables to concrete numbers. The first is fully worked; fill in the reasoning for the rest.

**Part A: trace the learning rate.** Take the linear-warmup + cosine-decay schedule (option 3) with `total_steps = 10000`, `warmup_steps = 1000`, and a peak learning rate of `3e-4`. The multiplier is `lr_lambda(step)` and the actual LR is `peak_lr * lr_lambda(step)`.

- Worked, step 500 (inside warmup): `lr_lambda = step / warmup_steps = 500 / 1000 = 0.5`, so `LR = 3e-4 * 0.5 = 1.5e-4`.
- Your turn, step 1000 (end of warmup): `lr_lambda = 1000 / 1000 = 1.0`, so `LR = 3e-4 * 1.0 = 3e-4` (the peak).
- Your turn, step 5500 (midway through decay): `progress = (5500 - 1000) / (10000 - 1000) = 4500 / 9000 = 0.5`, so `lr_lambda = 0.5 * (1 + cos(pi * 0.5)) = 0.5 * (1 + 0) = 0.5`, giving `LR = 3e-4 * 0.5 = 1.5e-4`.

The LR rises linearly to the peak at the end of warmup, then follows a cosine curve back down.

**Part B: optimizer-state memory.** Using the optimizer-memory table, compute the Adam state for a `1.5B` parameter model stored in FP32. Adam keeps a first moment and a second moment per parameter, each 4 bytes, so 8 bytes per parameter:

```python
P = 1.5e9
adam_state_bytes = P * 8          # 1.5e9 * 8 = 1.2e10 bytes
adam_state_gb = adam_state_bytes / 1e9   # 12 GB
```

That is 12 GB for the moment buffers alone, before counting the FP32 master weights ($4P = 6$ GB) or the gradients. The same logic at `7B` gives `7e9 * 8 = 56 GB`, which is why large-model training shards optimizer state across devices (ZeRO/FSDP).

</Example>

## Checkpointing

<Code id="code-checkpointing-full" caption="Full checkpoint save and load with all training state.">

```python
def save_checkpoint(model, optimizer, scheduler, epoch, path, **kwargs):
    """Save a full training checkpoint for resuming."""
    checkpoint = {
        'epoch': epoch,
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'scheduler_state_dict': scheduler.state_dict(),
        'rng_state': torch.random.get_rng_state(),
    }
    if torch.cuda.is_available():
        checkpoint['cuda_rng_state'] = torch.cuda.get_rng_state_all()
    checkpoint.update(kwargs)  # Additional metadata (loss, metrics, etc.)
    torch.save(checkpoint, path)

def load_checkpoint(model, optimizer, scheduler, path, device='cuda'):
    """Load a checkpoint and restore all training state."""
    checkpoint = torch.load(path, map_location=device, weights_only=False)
    model.load_state_dict(checkpoint['model_state_dict'])
    optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
    scheduler.load_state_dict(checkpoint['scheduler_state_dict'])

    # Restore RNG state for reproducibility
    if 'rng_state' in checkpoint:
        torch.random.set_rng_state(checkpoint['rng_state'])
    if 'cuda_rng_state' in checkpoint and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(checkpoint['cuda_rng_state'])

    return checkpoint['epoch']
```

</Code>

<Remark id="rmk-checkpoint-tips">
**Checkpointing best practices:**

1. **Save periodically** (every N steps, not just every epoch). If training crashes at epoch 9 of 10, you lose 90% of compute without mid-epoch checkpoints.

2. **Keep multiple checkpoints** (rotating buffer of last K checkpoints). A corrupted checkpoint with no backup is catastrophic.

3. **Include everything needed to resume.** Model weights alone are not enough for exact resumption. You need optimizer state (momentum buffers), scheduler state (LR position), and RNG states (for data ordering).

4. **Async saving** for large models. Checkpointing a 70B model takes 30+ seconds. Save asynchronously to avoid blocking training:
   ```python
   import threading
   thread = threading.Thread(target=torch.save, args=(checkpoint, path))
   thread.start()
   ```
</Remark>

## Gradient Clipping

<Code id="code-grad-clipping" caption="Gradient clipping methods and monitoring.">

```python
# Method 1: Clip by global norm (standard for transformers)
# Scales all gradients by the same factor if total norm exceeds max_norm
grad_norm = torch.nn.utils.clip_grad_norm_(
    model.parameters(),
    max_norm=1.0,
)
# Returns the total norm BEFORE clipping (log this!)

# Method 2: Clip by value (less common)
# Clamps each gradient element independently
torch.nn.utils.clip_grad_value_(model.parameters(), clip_value=0.5)

# Monitoring gradient norms (essential for debugging training)
if global_step % 10 == 0:
    # Per-layer gradient norms (find which layers have exploding gradients)
    for name, param in model.named_parameters():
        if param.grad is not None:
            print(f"{name}: grad_norm={param.grad.norm():.4f}")
```

</Code>

<Remark id="rmk-grad-clip-importance">
**Gradient clipping is not optional for transformers.** Without it, a single bad batch can produce a gradient spike that destabilizes the entire training run. Common settings:

| Model Type | `max_norm` | Notes |
|-----------|-----------|-------|
| GPT/LLaMA (LLMs) | 1.0 | Standard; occasionally lowered to 0.5 |
| BERT/RoBERTa | 1.0 | Standard |
| Vision Transformer | 1.0-5.0 | More tolerant |
| Diffusion models | 1.0 | Standard |
| RL (PPO, etc.) | 0.5-1.0 | More aggressive clipping |

**Monitor gradient norms.** Plotting the gradient norm over training reveals:
- **Spikes:** Potential instability. If spikes are frequent, reduce LR or increase clipping.
- **Gradual increase:** Normal early in training as the model learns.
- **Sudden collapse to 0:** Potential vanishing gradients. Check for dead ReLUs or exploded loss.
</Remark>

## Training Diagnostics

<Table id="tab-training-diagnostics" caption="What to monitor during training and what each metric tells you.">

| Metric | What to Monitor | Healthy Signal | Warning Sign |
|--------|----------------|---------------|-------------|
| Train loss | Should decrease | Smooth, monotonic decrease | Oscillation, plateau, spike, NaN |
| Val loss | Should decrease (slower than train) | Follows train loss with small gap | Increases while train loss decreases (overfitting) |
| Gradient norm | Should be stable | 0.1-10, occasional small spikes | Persistent spikes > 100, collapse to 0 |
| Learning rate | Should follow schedule | Warmup then decay | Stuck at wrong value (scheduler bug) |
| GPU utilization | Should be > 90% | Consistently high | Drops indicate data loading or sync issues |
| Memory usage | Should be stable | Constant after warmup | Monotonic increase (memory leak) |
| Throughput (samples/sec) | Should be stable | Consistent across steps | Drops indicate I/O or communication issues |

</Table>
