---
sidebar_position: 5
---

# Training Loop

## Complete Training Loop

<Code id="code-training-loop-1" caption="Code example.">

```python
import torch
import torch.nn as nn
from torch.cuda.amp import GradScaler, autocast

def train(model, train_loader, val_loader, epochs, lr=3e-4):
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = model.to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    scaler = GradScaler()
    criterion = nn.CrossEntropyLoss()

    best_val_loss = float('inf')

    for epoch in range(epochs):
        # Training phase
        model.train()
        total_loss = 0

        for batch_idx, (data, target) in enumerate(train_loader):
            data, target = data.to(device), target.to(device)

            optimizer.zero_grad()

            # Mixed precision forward pass
            with autocast(device_type='cuda'):
                output = model(data)
                loss = criterion(output, target)

            # Scaled backward pass
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            scaler.step(optimizer)
            scaler.update()

            total_loss += loss.item()

        scheduler.step()
        avg_train_loss = total_loss / len(train_loader)

        # Validation phase
        val_loss = evaluate(model, val_loader, criterion, device)

        print(f"Epoch {epoch+1}/{epochs} | "
              f"Train Loss: {avg_train_loss:.4f} | "
              f"Val Loss: {val_loss:.4f} | "
              f"LR: {scheduler.get_last_lr()[0]:.2e}")

        # Save best model
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save(model.state_dict(), 'best_model.pt')

    return model
```

</Code>

## Evaluation

<Code id="code-training-loop-2" caption="Code example.">

```python
@torch.no_grad()
def evaluate(model, loader, criterion, device):
    model.eval()
    total_loss = 0
    correct = 0
    total = 0

    for data, target in loader:
        data, target = data.to(device), target.to(device)

        with torch.autocast(device_type='cuda'):
            output = model(data)
            loss = criterion(output, target)

        total_loss += loss.item()
        pred = output.argmax(dim=1)
        correct += (pred == target).sum().item()
        total += target.size(0)

    return total_loss / len(loader)
```

</Code>

## Mixed Precision Training

<Code id="code-training-loop-3" caption="Code example.">

```python
# The key components:
# 1. autocast: runs forward pass in float16/bfloat16
# 2. GradScaler: scales loss to prevent gradient underflow in float16

# For bfloat16 (preferred on Ampere+ GPUs), no scaler needed:
with torch.autocast(device_type='cuda', dtype=torch.bfloat16):
    output = model(data)
    loss = criterion(output, target)

loss.backward()    # No scaler needed with bfloat16
optimizer.step()
```

</Code>

<Remark id="rmk-training-loop-1">
**Tip:** On Ampere GPUs (A100, RTX 3090) and newer, use `dtype=torch.bfloat16` without GradScaler. BF16 does not require loss scaling because its exponent range matches FP32.
</Remark>

## Checkpointing

<Code id="code-training-loop-4" caption="Code example.">

```python
def save_checkpoint(model, optimizer, scheduler, epoch, path):
    torch.save({
        'epoch': epoch,
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'scheduler_state_dict': scheduler.state_dict(),
    }, path)

def load_checkpoint(model, optimizer, scheduler, path):
    checkpoint = torch.load(path, weights_only=True)
    model.load_state_dict(checkpoint['model_state_dict'])
    optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
    scheduler.load_state_dict(checkpoint['scheduler_state_dict'])
    return checkpoint['epoch']
```

</Code>

## Gradient Clipping

<Code id="code-training-loop-5" caption="Code example.">

```python
# Clip by norm (most common for transformers)
torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)

# Clip by value
torch.nn.utils.clip_grad_value_(model.parameters(), clip_value=0.5)

# Check gradient norm before clipping
total_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
if total_norm > 1.0:
    print(f"Gradient norm: {total_norm:.2f} (clipped)")
```

</Code>

<Remark id="rmk-training-loop-2">
**Tip:** Always clip gradients when training transformers. A common configuration is `max_norm=1.0`. Log the gradient norm to detect training instability early.
</Remark>
