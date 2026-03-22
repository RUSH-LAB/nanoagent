---
sidebar_position: 3
---

# nn.Module

## Module Anatomy

Every PyTorch model inherits from `nn.Module`. The two methods you must implement:

```python
import torch
import torch.nn as nn

class MLP(nn.Module):
    def __init__(self, input_dim, hidden_dim, output_dim):
        super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(hidden_dim, output_dim)

    def forward(self, x):
        x = self.fc1(x)
        x = self.relu(x)
        x = self.fc2(x)
        return x

model = MLP(784, 256, 10)
output = model(torch.randn(32, 784))  # Calls forward()
print(output.shape)  # torch.Size([32, 10])
```

**Tip:** Never call `model.forward(x)` directly. Always use `model(x)`, which calls `forward()` through `__call__` and runs registered hooks.

## Parameter Registration

Parameters are automatically registered when assigned as attributes:

```python
class MyModel(nn.Module):
    def __init__(self):
        super().__init__()
        # Automatically registered as parameters
        self.linear = nn.Linear(10, 5)  # .weight and .bias

        # Manual parameter registration
        self.custom_weight = nn.Parameter(torch.randn(5, 5))

        # NOT a parameter (not trained)
        self.register_buffer('running_mean', torch.zeros(5))

# List all parameters
for name, param in model.named_parameters():
    print(f"{name}: {param.shape}")
# fc1.weight: torch.Size([256, 784])
# fc1.bias: torch.Size([256])
# fc2.weight: torch.Size([10, 256])
# fc2.bias: torch.Size([10])
```

**Tip:** Use `register_buffer` for tensors that should be saved with the model but not trained (e.g., running statistics, positional encodings). Buffers move with `.to(device)` and are included in `state_dict`.

## nn.Sequential vs Custom Modules

```python
# Simple sequential model
model = nn.Sequential(
    nn.Linear(784, 256),
    nn.ReLU(),
    nn.Linear(256, 10),
)

# When you need branching, skip connections, or multiple inputs:
class ResBlock(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.fc1 = nn.Linear(dim, dim)
        self.fc2 = nn.Linear(dim, dim)
        self.norm = nn.LayerNorm(dim)

    def forward(self, x):
        residual = x
        x = self.norm(x)
        x = torch.relu(self.fc1(x))
        x = self.fc2(x)
        return x + residual  # Skip connection
```

## Saving and Loading

```python
# Save model state
torch.save(model.state_dict(), 'model.pt')

# Load model state
model = MLP(784, 256, 10)
model.load_state_dict(torch.load('model.pt', weights_only=True))
model.eval()  # Set to evaluation mode

# Save entire model (not recommended for production)
torch.save(model, 'model_full.pt')

# Save checkpoint (model + optimizer + epoch)
checkpoint = {
    'epoch': epoch,
    'model_state_dict': model.state_dict(),
    'optimizer_state_dict': optimizer.state_dict(),
    'loss': loss,
}
torch.save(checkpoint, 'checkpoint.pt')
```

**Warning:** Always use `weights_only=True` when loading from untrusted sources. Without it, `torch.load` uses pickle, which can execute arbitrary code.

## Useful Module Methods

```python
model.parameters()         # Iterator over all parameters
model.named_parameters()   # Iterator over (name, param) pairs
model.children()           # Iterator over direct child modules
model.modules()            # Iterator over ALL modules (recursive)
model.train()              # Set training mode (enables dropout, etc.)
model.eval()               # Set evaluation mode
model.to('cuda')           # Move all parameters/buffers to device
model.half()               # Convert all parameters to float16
model.zero_grad()          # Zero all parameter gradients
```

```python
# Count parameters
total = sum(p.numel() for p in model.parameters())
trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
print(f"Total: {total:,}, Trainable: {trainable:,}")
```
