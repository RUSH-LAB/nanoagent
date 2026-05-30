---
sidebar_position: 1
---

# Python Tips for ML

Python is the lingua franca of machine learning, but it was not designed for high-performance computing. The gap between "Python that works" and "Python that works well for ML" comes down to a few key patterns: managing memory with generators and context managers, structuring configuration with dataclasses, catching bugs early with type hints, and avoiding the Python-level overhead that makes training scripts slower than they need to be. This chapter covers the patterns that ML engineers use daily.

## Generators and Memory Efficiency

Generators produce values lazily: they compute one item at a time and discard it before computing the next. For ML workloads that process large datasets, this is the difference between loading everything into memory and processing with constant memory:

<Code id="code-python-tips-1" caption="Generators provide O(1) memory for streaming data processing.">

```python
# BAD: materializes the entire file as a list in memory
def read_data(path):
    with open(path) as f:
        return [process(line) for line in f]  # 10M lines = 10M objects in memory

# GOOD: yields one item at a time (O(1) memory)
def read_data(path):
    with open(path) as f:
        for line in f:
            yield process(line)  # Only one object in memory at a time

# Use itertools for memory-efficient operations on generators
import itertools

first_100 = itertools.islice(read_data("huge_file.jsonl"), 100)
batched = itertools.batched(read_data("data.jsonl"), 32)  # Python 3.12+

# Chain multiple data sources without loading any into memory
all_data = itertools.chain(
    read_data("train_part1.jsonl"),
    read_data("train_part2.jsonl"),
    read_data("train_part3.jsonl"),
)

# Generator expressions (like list comprehensions, but lazy)
total = sum(len(line) for line in open("data.txt"))  # No list created
```

</Code>

<Table id="tab-lazy-vs-eager" caption="Lazy (generator) vs eager (list) evaluation tradeoffs.">

| Pattern | Memory | Speed | When to Use |
|---------|--------|-------|-------------|
| List comprehension `[x for x in data]` | O(n) | Slightly faster (optimized bytecode) | Small data, need random access or length |
| Generator expression `(x for x in data)` | O(1) | Slightly slower | Large data, single pass |
| `map(func, data)` | O(1) | Fast (C-level iterator) | Simple transformations |
| `itertools.chain(a, b)` | O(1) | Fast | Concatenate without copying |
| `list(generator)` | O(n) | Materializes | When you need the full list |

</Table>

## Context Managers

Context managers ensure cleanup happens even when exceptions occur. They are essential for resource management (files, GPU memory, timers, temporary state changes):

<Code id="code-python-tips-2" caption="Custom context managers for ML development.">

```python
import contextlib
import time
import torch

# ── Timer context manager ──
@contextlib.contextmanager
def timer(name=""):
    if torch.cuda.is_available():
        torch.cuda.synchronize()  # Ensure GPU ops are complete before timing
    start = time.perf_counter()
    yield
    if torch.cuda.is_available():
        torch.cuda.synchronize()  # Ensure GPU ops complete before stopping timer
    elapsed = time.perf_counter() - start
    print(f"{name}: {elapsed:.3f}s")

with timer("training epoch"):
    train(model, loader)

# ── GPU memory tracking ──
@contextlib.contextmanager
def track_gpu_memory(label=""):
    if not torch.cuda.is_available():
        yield  # No CUDA device: skip GPU memory tracking
        return
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    mem_before = torch.cuda.memory_allocated()
    yield
    torch.cuda.synchronize()
    mem_after = torch.cuda.memory_allocated()
    peak = torch.cuda.max_memory_allocated()
    print(f"[{label}] Current: {(mem_after - mem_before)/1e9:.2f} GB, "
          f"Peak: {peak/1e9:.2f} GB")

# ── Temporary eval mode ──
@contextlib.contextmanager
def eval_mode(model):
    """Temporarily set model to eval mode, restore original mode on exit."""
    was_training = model.training
    model.eval()
    with torch.no_grad():
        yield
    if was_training:
        model.train()

with eval_mode(model):
    val_loss = compute_validation_loss(model, val_loader)
```

</Code>

## Dataclasses for Configuration

Replace ad-hoc dictionaries, NamedTuples, and scattered keyword arguments with structured, typed configuration. Dataclasses provide free `__init__`, `__repr__`, `__eq__`, and can be validated:

<Code id="code-python-tips-3" caption="Using dataclasses for typed, validated ML configuration.">

```python
from dataclasses import dataclass, field
from pathlib import Path

@dataclass
class TrainConfig:
    # Model
    model_name: str = "llama-7b"
    hidden_dim: int = 4096
    num_layers: int = 32

    # Optimization
    lr: float = 3e-4
    weight_decay: float = 0.01
    warmup_steps: int = 100
    max_steps: int = 100_000
    grad_clip: float = 1.0

    # Training
    batch_size: int = 32
    epochs: int = 10
    devices: list[int] = field(default_factory=lambda: [0, 1, 2, 3])
    precision: str = "bf16"

    # Paths
    data_dir: Path = Path("data/")
    output_dir: Path = Path("outputs/")

    @property
    def effective_batch_size(self) -> int:
        return self.batch_size * len(self.devices)

    def __post_init__(self):
        """Validate configuration after initialization."""
        assert self.lr > 0, f"Learning rate must be positive, got {self.lr}"
        assert self.precision in ("fp32", "fp16", "bf16"), f"Unknown precision: {self.precision}"
        self.output_dir.mkdir(parents=True, exist_ok=True)

# Usage
config = TrainConfig(lr=1e-4, epochs=20)
print(config)  # Readable repr for free

# Frozen (immutable) variant for configs that should not change
@dataclass(frozen=True)
class ModelConfig:
    hidden_dim: int = 4096
    num_heads: int = 32
    num_layers: int = 32
    vocab_size: int = 32000
    # Can be used as dict key or in sets (hashable)
```

</Code>

<Remark id="rmk-config-patterns">
**Configuration anti-patterns to avoid:**
- **`**kwargs` chains**: Passing `**kwargs` through multiple function calls makes it impossible to know what arguments are available. Use dataclasses.
- **Global config dict**: A mutable global dictionary is hard to test and easy to accidentally modify. Use frozen dataclasses.
- **Argparse for everything**: Argparse is for CLI arguments, not internal configuration. Parse CLI into a dataclass, then pass the dataclass.
- **Nested dicts**: `config["model"]["hidden_dim"]` has no type checking and fails silently with typos. Use nested dataclasses: `config.model.hidden_dim`.
</Remark>

## Type Hints

Type hints catch bugs before runtime, improve IDE autocompletion, and serve as documentation. PyTorch code especially benefits because tensor shape mismatches are the most common bug:

<Code id="code-python-tips-4" caption="Type hints for PyTorch training code.">

```python
from collections.abc import Callable
from typing import Optional
import torch
from torch import Tensor, nn

def train_step(
    model: nn.Module,
    batch: dict[str, Tensor],
    optimizer: torch.optim.Optimizer,
    scaler: Optional[torch.amp.GradScaler] = None,
    grad_clip: float = 1.0,
) -> float:
    """Run a single training step. Returns the loss value."""
    optimizer.zero_grad()

    with torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16):
        loss: Tensor = model(**batch).loss

    if scaler is not None:
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        scaler.step(optimizer)
        scaler.update()
    else:
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        optimizer.step()

    return loss.item()

# Type aliases for readability
BatchType = dict[str, Tensor]
LossFunction = Callable[[Tensor, Tensor], Tensor]
```

</Code>

<Code id="code-python-tips-6" caption="Running type checkers on ML code.">

```bash
# mypy: strictest, catches the most bugs
pip install mypy
mypy train.py --ignore-missing-imports

# pyright: faster, better PyTorch support
pip install pyright
pyright train.py

# ruff: fast linter (not a type checker, but catches many errors)
pip install ruff
ruff check train.py
```

</Code>

## Performance Tips

Python's overhead matters in ML code. These patterns eliminate the most common Python-level bottlenecks:

<Code id="code-python-tips-5" caption="Python performance patterns for ML code.">

```python
# ── 1. Use set/dict for lookups (O(1) vs O(n) for lists) ──
valid_ids = set(range(100_000))     # O(1) lookup
if item_id in valid_ids: ...        # Fast

# BAD: O(n) linear search
valid_ids_list = list(range(100_000))
if item_id in valid_ids_list: ...   # Slow (100K comparisons worst case)

# ── 2. List comprehensions are faster than loops ──
# Slow (Python-level append, attribute lookup each iteration)
result = []
for x in data:
    result.append(x ** 2)

# Fast (optimized bytecode: LIST_APPEND opcode, no per-iteration attribute lookup)
result = [x ** 2 for x in data]

# ── 3. Cache attribute lookups in hot loops ──
# Slow (3 attribute lookups per iteration)
for i in range(1000):
    self.model.encoder.layer[i].forward(x)

# Fast (1 attribute lookup, cached)
forward = self.model.encoder.layer[0].forward
for i in range(1000):
    forward(x)

# ── 4. Use __slots__ for memory-efficient classes ──
class Point:
    __slots__ = ('x', 'y')
    def __init__(self, x: float, y: float):
        self.x = x
        self.y = y
# Can use substantially less memory than a regular class (no __dict__ per instance)

# ── 5. String formatting: f-strings are fastest ──
name, lr = "exp1", 3e-4
s = f"{name}: lr={lr:.2e}"          # Fast (compiled)
s = "{}: lr={:.2e}".format(name, lr)  # Slower
s = "%s: lr=%.2e" % (name, lr)       # Slowest

# ── 6. Avoid unnecessary copies ──
# BAD: creates a new list
sorted_data = sorted(data)

# GOOD: sorts in place (if you don't need the original)
data.sort()
```

</Code>

<Table id="tab-python-pitfalls" caption="Common Python performance pitfalls in ML code.">

| Pitfall | Why It's Slow | Fix |
|---------|-------------|-----|
| `tensor.item()` in training loop | GPU-CPU synchronization each call | Log every N steps, accumulate on GPU |
| `print(tensor)` during training | Forces GPU synchronization | Use logging with `if step % N == 0` |
| `for i in range(len(list)): list[i]` | Index lookup each iteration | `for item in list:` (direct iteration) |
| Global imports inside functions | `import` statement runs every call | Move imports to top of file |
| Creating tensors in a loop | Allocation overhead per iteration | Pre-allocate and fill |
| `dict.keys()` for membership test | Creates a view object | Use `key in dict` directly (O(1)) |
| `+` for string concatenation in loop | Creates new string each iteration | Use `"".join(parts)` or f-strings |

</Table>

## Debugging Python ML Code

<Code id="code-python-tips-7" caption="Essential debugging tools for ML Python code.">

```python
# ── breakpoint() (Python 3.7+, built-in debugger) ──
def train_step(model, batch):
    output = model(batch)
    breakpoint()  # Drops into pdb here; inspect output, batch, etc.
    loss = compute_loss(output)
    return loss
# In pdb: p output.shape, p loss.item(), n (next), c (continue), q (quit)

# ── Rich traceback (much better error messages) ──
# pip install rich
from rich.traceback import install
install(show_locals=True)  # Shows local variable values in tracebacks

# ── torch.autograd.set_detect_anomaly for NaN debugging ──
with torch.autograd.set_detect_anomaly(True):
    output = model(input)
    loss = criterion(output, target)
    loss.backward()  # If NaN/Inf occurs, prints the op that caused it

# ── Logging instead of print ──
import logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)
logger.info(f"Step {step}: loss={loss:.4f}, lr={scheduler.get_last_lr()[0]:.2e}")
```

</Code>
