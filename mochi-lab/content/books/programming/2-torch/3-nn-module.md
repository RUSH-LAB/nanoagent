---
sidebar_position: 3
---

# nn.Module

`nn.Module` is the base class for all neural network components in PyTorch. Every layer, every model, and every building block inherits from it. Understanding `nn.Module` deeply (how parameters are registered, how the module tree works, and how to use hooks) is essential for building, debugging, and extending models.

## Module Anatomy

Every PyTorch model inherits from `nn.Module`. You must implement two methods: `__init__` (define layers) and `forward` (define computation):

<Code id="code-nn-module-basic" caption="Basic nn.Module structure: __init__ defines layers, forward defines computation.">

```python
import torch
import torch.nn as nn

class MLP(nn.Module):
    def __init__(self, input_dim, hidden_dim, output_dim):
        super().__init__()               # MUST call super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(hidden_dim, output_dim)

    def forward(self, x):
        x = self.fc1(x)                 # Linear: x @ W.T + b
        x = self.relu(x)                # Activation
        x = self.fc2(x)                 # Output projection
        return x

model = MLP(784, 256, 10)
output = model(torch.randn(32, 784))    # Calls __call__, which calls forward()
print(output.shape)                       # torch.Size([32, 10])
```

</Code>

<Remark id="rmk-call-not-forward">
**Always use `model(x)`, never `model.forward(x)`.** The `__call__` method does more than just call `forward()`:

1. Runs all registered **forward pre-hooks** (e.g., for input validation)
2. Calls `forward()`
3. Runs all registered **forward hooks** (e.g., for feature extraction)
4. Handles autograd setup

Calling `forward()` directly bypasses hooks and can cause subtle bugs, especially with third-party libraries that register hooks.
</Remark>

<Example id="ex-mlp-shapes-and-params">

Let us trace one forward pass through `MLP(784, 256, 10)` on a batch of 32 inputs, following both the tensor shapes and the parameter count.

The input is `x` with shape `[32, 784]` (batch of 32, each a flattened 28x28 image). Each `nn.Linear(in, out)` computes `x @ W.T + b` where `W` has shape `[out, in]` and `b` has shape `[out]`, so it maps the last dimension from `in` to `out` and leaves the batch dimension untouched.

```python
# Shapes through the network:
x = torch.randn(32, 784)            # [32, 784]
h = self.fc1(x)                     # [32, 256]   fc1: 784 -> 256
h = self.relu(h)                    # [32, 256]   ReLU is shape-preserving
out = self.fc2(h)                   # [32,  10]   fc2: 256 -> 10
```

Now count the parameters. A `nn.Linear(in, out)` holds `out * in` weights plus `out` biases:

- `fc1`: `256 * 784` weights `+ 256` biases `= 200704 + 256 = 200960`
- `fc2`: `10 * 256` weights `+ 10` biases `= 2560 + 10 = 2570`
- Total: `200960 + 2570 = 203530` parameters

The `relu` layer has no parameters, so it does not contribute. You can confirm the total with the parameter-counting idiom from the [Useful Module Methods](#useful-module-methods) section:

```python
sum(p.numel() for p in model.parameters())  # 203530
```

</Example>

## Parameter Registration

Training a model means updating its weights, but the optimizer can only update tensors it knows about, and `.to(device)` can only move tensors the module is aware of. The problem registration solves is bookkeeping: how does PyTorch discover which tensors belong to a model, which should receive gradients, and which should travel with the model across devices and into checkpoints? The answer is that `nn.Module` intercepts attribute assignment and records anything that looks like a parameter, buffer, or sub-module.

Parameters are automatically tracked when assigned as attributes of a module. This is how PyTorch knows which tensors to optimize:

<Code id="code-parameter-registration" caption="Parameters, buffers, and plain tensors: what gets tracked.">

```python
class MyModel(nn.Module):
    def __init__(self):
        super().__init__()

        # 1. nn.Module attributes: parameters are auto-registered
        self.linear = nn.Linear(10, 5)   # Registers .weight and .bias

        # 2. nn.Parameter: explicitly create a trainable parameter
        self.custom_weight = nn.Parameter(torch.randn(5, 5))

        # 3. register_buffer: saved with model but NOT trained
        self.register_buffer('running_mean', torch.zeros(5))
        self.register_buffer('step_count', torch.tensor(0, dtype=torch.long))

        # 4. Plain tensor: NOT saved, NOT moved with .to(device)
        self.scratch = torch.zeros(5)    # Not tracked; can cause a device mismatch after .to()

# What gets tracked:
model = MyModel()
for name, param in model.named_parameters():
    print(f"Parameter: {name}, shape={param.shape}, requires_grad={param.requires_grad}")
# Parameter: linear.weight, shape=torch.Size([5, 10]), requires_grad=True
# Parameter: linear.bias, shape=torch.Size([5]), requires_grad=True
# Parameter: custom_weight, shape=torch.Size([5, 5]), requires_grad=True

for name, buf in model.named_buffers():
    print(f"Buffer: {name}, shape={buf.shape}")
# Buffer: running_mean, shape=torch.Size([5])
# Buffer: step_count, shape=torch.Size([])
```

</Code>

<Table id="tab-parameter-types" caption="What gets tracked, saved, and moved for different tensor types in nn.Module.">

| Type | Tracked by `parameters()` | In `state_dict()` | Moved by `.to()` | Trained by optimizer |
|------|--------------------------|-------------------|-------------------|---------------------|
| `nn.Parameter` | Yes | Yes | Yes | Yes |
| `register_buffer(name, tensor)` | No | Yes | Yes | No |
| `register_buffer(name, tensor, persistent=False)` | No | No | Yes | No |
| Plain `self.x = tensor` | No | No | No | No |

</Table>

<Remark id="rmk-buffers-usage">
**When to use buffers vs parameters:**

| Use Case | Type | Example |
|----------|------|---------|
| Trainable weights | `nn.Parameter` | Weight matrices, embeddings |
| Running statistics | `register_buffer` | BatchNorm mean/var, EMA weights |
| Constant tensors | `register_buffer` | Positional encodings, masks |
| Non-persistent constants | `register_buffer(..., persistent=False)` | Precomputed lookup tables |
| Temporary computation | Plain tensor | Scratch space (not recommended) |

**Never use plain tensors as model state.** They will not be saved, will not move to GPU with `.to('cuda')`, and will silently cause device mismatch errors.
</Remark>

## ModuleList and ModuleDict

Registration works when you assign a sub-module to a named attribute, but real architectures often need a variable number of layers (an `N`-layer Transformer) or a set of layers chosen by name (per-task heads). Storing these in an ordinary Python `list` or `dict` defeats registration: the modules become invisible to `parameters()` and `.to(device)`. `nn.ModuleList` and `nn.ModuleDict` are container modules that keep list and dict ergonomics while still registering every element.

When you need to store a variable number of sub-modules:

<Code id="code-module-containers" caption="ModuleList and ModuleDict for dynamic module collections.">

```python
class TransformerEncoder(nn.Module):
    def __init__(self, num_layers, d_model, n_heads):
        super().__init__()
        # ModuleList: indexed like a Python list, but properly registered
        self.layers = nn.ModuleList([
            TransformerBlock(d_model, n_heads)
            for _ in range(num_layers)
        ])
        self.norm = nn.LayerNorm(d_model)

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return self.norm(x)

# ModuleDict: named sub-modules for conditional architectures
class MultiTaskModel(nn.Module):
    def __init__(self, shared_dim, task_dims):
        super().__init__()
        self.encoder = nn.Linear(784, shared_dim)
        self.heads = nn.ModuleDict({
            task: nn.Linear(shared_dim, dim)
            for task, dim in task_dims.items()
        })

    def forward(self, x, task):
        x = self.encoder(x)
        return self.heads[task](x)

# WRONG: Python list does not register modules
class BadModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = [nn.Linear(10, 10) for _ in range(3)]  # NOT registered!
        # model.parameters() will be empty!
        # model.to('cuda') will NOT move these layers!
```

</Code>

## nn.Sequential

Writing a full `nn.Module` subclass with `__init__` and `forward` is overkill when the computation is just "apply these layers in order." For a plain stack with no branching, skip connections, or conditionals, `nn.Sequential` lets you skip the boilerplate: it chains its child modules and runs them front to back, which keeps short pipelines readable.

For simple feed-forward architectures without branching:

<Code id="code-sequential" caption="nn.Sequential for simple linear architectures.">

```python
from collections import OrderedDict

# Simple sequential model
model = nn.Sequential(
    nn.Linear(784, 256),
    nn.ReLU(),
    nn.Dropout(0.1),
    nn.Linear(256, 128),
    nn.ReLU(),
    nn.Linear(128, 10),
)

# Named sequential (better for debugging)
model = nn.Sequential(OrderedDict([
    ('encoder', nn.Linear(784, 256)),
    ('activation', nn.ReLU()),
    ('classifier', nn.Linear(256, 10)),
]))
print(model.encoder)  # Access by name

# When to use Sequential vs custom Module:
# Sequential: no skip connections, no multiple inputs/outputs, no conditionals
# Custom Module: anything with non-trivial control flow
```

</Code>

## Building Blocks: Residual Connections

Skip connections solve the vanishing gradient problem that plagued deep networks: by adding the input directly to the output of a sublayer, gradients can flow backward through the identity path without shrinking, which lets you stack dozens or hundreds of layers. This pattern underpins ResNets, Transformers, and nearly every state-of-the-art architecture since 2015.

The most important architectural pattern in modern deep learning:

<Code id="code-resblock" caption="Residual block: the fundamental building block of modern architectures.">

```python
class ResBlock(nn.Module):
    """Pre-norm residual block (used in modern Transformers)."""
    def __init__(self, dim, expansion=4):
        super().__init__()
        self.norm = nn.LayerNorm(dim)
        self.ff = nn.Sequential(
            nn.Linear(dim, dim * expansion),
            nn.GELU(),
            nn.Linear(dim * expansion, dim),
        )

    def forward(self, x):
        # Pre-norm: normalize before the sublayer
        return x + self.ff(self.norm(x))
        # The residual connection (x + ...) ensures:
        # 1. Gradients flow directly through the skip path
        # 2. Deep networks can train without vanishing gradients
        # 3. Each layer learns a residual "correction" rather than a full mapping

class TransformerBlock(nn.Module):
    """Full Transformer block with self-attention and FFN."""
    def __init__(self, d_model, n_heads, dropout=0.0):
        super().__init__()
        self.norm1 = nn.LayerNorm(d_model)
        self.attn = nn.MultiheadAttention(d_model, n_heads, batch_first=True)
        self.norm2 = nn.LayerNorm(d_model)
        self.ff = nn.Sequential(
            nn.Linear(d_model, 4 * d_model),
            nn.GELU(),
            nn.Linear(4 * d_model, d_model),
        )
        self.dropout = nn.Dropout(dropout)

    def forward(self, x, mask=None):
        # Self-attention with residual
        h = self.norm1(x)
        h, _ = self.attn(h, h, h, attn_mask=mask)
        x = x + self.dropout(h)

        # FFN with residual
        x = x + self.dropout(self.ff(self.norm2(x)))
        return x
```

</Code>

## Saving and Loading

Training runs are long and fragile: jobs get preempted, machines crash, and you want to resume exactly where you left off rather than start over. Checkpointing solves this by serializing model state to disk so you can reload it later, whether to deploy the trained weights or to continue training. The key decision is what to save. Saving only the `state_dict` (the tensor values) keeps the file portable across code changes, while a full checkpoint additionally captures optimizer, scheduler, and RNG state so a resumed run continues seamlessly.

<Code id="code-save-load" caption="Saving and loading model state: the right way and common pitfalls.">

```python
# CORRECT: Save state_dict (just the parameters and buffers)
torch.save(model.state_dict(), 'model.pt')

# Load: create model first, then load state
model = MLP(784, 256, 10)
model.load_state_dict(torch.load('model.pt', weights_only=True))
model.eval()

# FULL CHECKPOINT: model + optimizer + scheduler + epoch + RNG state
checkpoint = {
    'epoch': epoch,
    'model_state_dict': model.state_dict(),
    'optimizer_state_dict': optimizer.state_dict(),
    'scheduler_state_dict': scheduler.state_dict(),
    'loss': best_loss,
    'rng_state': torch.random.get_rng_state(),
    'cuda_rng_state': torch.cuda.get_rng_state_all(),
}
torch.save(checkpoint, 'checkpoint.pt')

# Load checkpoint
# NOTE: In PyTorch 2.6+, weights_only defaults to True. A full checkpoint
# carrying optimizer/scheduler/RNG state often fails under weights_only=True
# because those state dicts hold non-tensor globals that must be allowlisted.
# Allowlist them with torch.serialization.add_safe_globals([...]) or the
# torch.serialization.safe_globals([...]) context, or, for a checkpoint from a
# trusted source, pass weights_only=False.
checkpoint = torch.load('checkpoint.pt', weights_only=False)  # trusted source
model.load_state_dict(checkpoint['model_state_dict'])
optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
scheduler.load_state_dict(checkpoint['scheduler_state_dict'])
start_epoch = checkpoint['epoch'] + 1
```

</Code>

<Remark id="rmk-save-load-tips">
**Save/load best practices:**

1. **Always use `weights_only=True`** when loading from untrusted sources. Without it, `torch.load` uses pickle, which can execute arbitrary code.

2. **Save state_dict, not the model object.** `torch.save(model, ...)` pickles the entire class definition, which breaks when you rename files, move classes, or update code. `state_dict()` saves only the tensor values.

3. **Handle `strict=False` for partial loading.** When loading a pretrained model with different architecture:
   ```python
   # Load only matching keys, ignore extras
   state = torch.load('pretrained.pt', weights_only=True)
   model.load_state_dict(state, strict=False)
   ```

4. **Map location for cross-device loading:**
   ```python
   # Saved on GPU, loading on CPU
   state = torch.load('model.pt', map_location='cpu', weights_only=True)

   # Saved on cuda:0, loading on cuda:1
   state = torch.load('model.pt', map_location={'cuda:0': 'cuda:1'}, weights_only=True)
   ```
</Remark>

## Hooks: Inspecting and Modifying Forward/Backward

Hooks let you inspect or modify intermediate values without changing the model code:

<Code id="code-hooks" caption="Forward and backward hooks for debugging and feature extraction.">

```python
# Forward hook: called after forward() of a module
activations = {}
def save_activation(name):
    def hook(module, input, output):
        activations[name] = output.detach()
    return hook

# Register hooks on specific layers
model.encoder.register_forward_hook(save_activation('encoder'))
model.classifier.register_forward_hook(save_activation('classifier'))

# Run forward pass (hooks fire automatically)
output = model(input)
print(activations['encoder'].shape)     # Intermediate features

# Backward hook: inspect gradients flowing through a layer
def gradient_hook(module, grad_input, grad_output):
    print(f"{module.__class__.__name__}: grad_output norm = {grad_output[0].norm():.4f}")

# NOTE: named_modules() includes the top-level module and containers (e.g., Sequential),
# which may produce empty or noisy grad_output tuples. Filter to leaf modules
# (those with no children) so each hook fires on an actual computation.
for name, module in model.named_modules():
    if len(list(module.children())) == 0:   # leaf module only
        module.register_full_backward_hook(gradient_hook)

# Remove hooks when done (hooks persist and can cause memory leaks)
handle = model.layer.register_forward_hook(my_hook)
handle.remove()  # Clean up
```

</Code>

## Useful Module Methods

<Code id="code-module-methods" caption="Essential nn.Module methods for inspection and manipulation.">

```python
# Inspection
list(model.parameters())          # All parameters (flat list)
list(model.named_parameters())    # (name, param) pairs
list(model.children())            # Direct child modules only
list(model.modules())             # ALL modules recursively (including self)
list(model.named_modules())       # (name, module) pairs recursively

# Mode switching
model.train()                     # Enable dropout, batch norm training mode
model.eval()                      # Disable dropout, batch norm eval mode
# IMPORTANT: model.eval() does NOT disable gradient computation
# Use torch.no_grad() or torch.inference_mode() for that

# Device and dtype
model.to('cuda')                  # Move all parameters and buffers to GPU
model.to(torch.bfloat16)          # Convert all parameters to bfloat16
model.half()                      # Shortcut for .to(torch.float16)
model.cuda()                      # Shortcut for .to('cuda')

# Gradient control
model.zero_grad()                 # Zero all parameter gradients
model.requires_grad_(False)       # Freeze all parameters (no gradient computation)

# Parameter counting
total = sum(p.numel() for p in model.parameters())
trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
print(f"Total: {total:,} | Trainable: {trainable:,}")

# Print model architecture
print(model)                      # Shows module tree with shapes
```

</Code>

<Remark id="rmk-train-eval-common-bug">
**The most common `train()`/`eval()` bug:** Forgetting to call `model.eval()` before validation causes batch norm to use mini-batch statistics (noisy) instead of running statistics, and dropout to randomly zero activations. This can make validation metrics appear much worse than they should be. Always:

```python
model.eval()                        # Set eval mode BEFORE validation
with torch.no_grad():               # Disable gradient computation
    for batch in val_loader:
        output = model(batch)
        ...
model.train()                       # Set back to train mode AFTER validation
```
</Remark>

## Freezing and Fine-tuning

<Code id="code-freezing" caption="Freezing layers for transfer learning and fine-tuning.">

```python
# Freeze the entire model
for param in model.parameters():
    param.requires_grad = False

# Unfreeze only the classifier head
for param in model.classifier.parameters():
    param.requires_grad = True

# Only pass trainable parameters to optimizer
optimizer = torch.optim.Adam(
    filter(lambda p: p.requires_grad, model.parameters()),
    lr=1e-4,
)

# Layer-wise learning rates (common for fine-tuning)
optimizer = torch.optim.Adam([
    {'params': model.encoder.parameters(), 'lr': 1e-5},    # Small LR for pretrained
    {'params': model.classifier.parameters(), 'lr': 1e-3}, # Larger LR for new head
])
```

</Code>
