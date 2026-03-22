---
sidebar_position: 1
---

# Python Tips for ML

## Generators and Memory Efficiency

Generators produce values lazily, avoiding loading everything into memory:

```python
# Bad: loads entire file into memory
def read_data(path):
    with open(path) as f:
        return [process(line) for line in f]  # List in memory

# Good: yields one item at a time
def read_data(path):
    with open(path) as f:
        for line in f:
            yield process(line)  # Generator, O(1) memory

# Use itertools for memory-efficient operations
import itertools
first_100 = itertools.islice(read_data("huge_file.jsonl"), 100)
batched = itertools.batched(read_data("data.jsonl"), 32)  # Python 3.12+
```

## Context Managers

Ensure cleanup happens even when exceptions occur:

```python
import contextlib
import time

@contextlib.contextmanager
def timer(name=""):
    start = time.perf_counter()
    yield
    elapsed = time.perf_counter() - start
    print(f"{name}: {elapsed:.3f}s")

with timer("training"):
    train(model, loader)

# Useful for GPU memory management
@contextlib.contextmanager
def cuda_memory_tracking():
    torch.cuda.reset_peak_memory_stats()
    yield
    peak = torch.cuda.max_memory_allocated() / 1e9
    print(f"Peak GPU memory: {peak:.2f} GB")
```

## Dataclasses

Replace ad-hoc dictionaries and NamedTuples with structured configuration:

```python
from dataclasses import dataclass, field

@dataclass
class TrainConfig:
    model_name: str = "llama-7b"
    lr: float = 3e-4
    batch_size: int = 32
    epochs: int = 10
    weight_decay: float = 0.01
    warmup_steps: int = 100
    grad_clip: float = 1.0
    devices: list[int] = field(default_factory=lambda: [0, 1, 2, 3])

    @property
    def effective_batch_size(self):
        return self.batch_size * len(self.devices)

config = TrainConfig(lr=1e-4, epochs=20)
print(config)  # Readable repr for free
```

**Tip:** Use `@dataclass(frozen=True)` for immutable configs that can be used as dictionary keys or set elements.

## Type Hints

Type hints catch bugs before runtime and improve IDE support:

```python
from typing import Optional
import torch
from torch import Tensor

def train_step(
    model: torch.nn.Module,
    batch: dict[str, Tensor],
    optimizer: torch.optim.Optimizer,
    grad_clip: Optional[float] = 1.0,
) -> float:
    optimizer.zero_grad()
    loss: Tensor = model(**batch).loss
    loss.backward()
    if grad_clip is not None:
        torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
    optimizer.step()
    return loss.item()
```

```bash
# Type check with mypy
pip install mypy
mypy train.py --ignore-missing-imports
```

## Performance Tips

```python
# 1. Use dict/set for lookups (O(1) vs O(n) for lists)
valid_ids = set(range(1000))    # O(1) lookup
if item_id in valid_ids: ...    # Fast

# 2. Use list comprehensions over loops
# Slow
result = []
for x in data:
    result.append(x ** 2)
# Fast (C-level loop)
result = [x ** 2 for x in data]

# 3. Avoid repeated attribute lookups
# Slow
for i in range(1000):
    self.model.encoder.layer[i].forward(x)
# Fast
forward = self.model.encoder.layer[0].forward
for i in range(1000):
    forward(x)

# 4. Use __slots__ for memory-efficient classes
class Point:
    __slots__ = ('x', 'y')
    def __init__(self, x, y):
        self.x = x
        self.y = y
# Uses ~40% less memory than a regular class
```
