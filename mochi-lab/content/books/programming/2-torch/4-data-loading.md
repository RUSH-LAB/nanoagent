---
sidebar_position: 4
---

# Data Loading

Data loading is the most underestimated component of ML training. A poorly designed data pipeline can make your GPU sit idle while waiting for the next batch, wasting expensive compute. This section covers the PyTorch data loading system (`Dataset`, `DataLoader`, and their many configuration options) with emphasis on the performance implications of each choice.

## Dataset

A `Dataset` maps an integer index to a sample. It defines *what* data you have and how to access it:

<Code id="code-dataset-map" caption="Map-style Dataset: index to sample mapping.">

```python
from torch.utils.data import Dataset, DataLoader
import torch

class TextDataset(Dataset):
    def __init__(self, texts, labels, tokenizer, max_len=512):
        self.texts = texts
        self.labels = labels
        self.tokenizer = tokenizer
        self.max_len = max_len

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, idx):
        # Called once per sample: this is where preprocessing happens
        tokens = self.tokenizer(
            self.texts[idx],
            max_length=self.max_len,
            padding='max_length',
            truncation=True,
            return_tensors='pt',
        )
        return {
            'input_ids': tokens['input_ids'].squeeze(0),
            'attention_mask': tokens['attention_mask'].squeeze(0),
            'label': torch.tensor(self.labels[idx], dtype=torch.long),
        }

# Image dataset example
from PIL import Image
from torchvision import transforms

class ImageDataset(Dataset):
    def __init__(self, image_paths, labels, transform=None):
        self.image_paths = image_paths
        self.labels = labels
        self.transform = transform or transforms.Compose([
            transforms.Resize(256),
            transforms.CenterCrop(224),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406],
                                 std=[0.229, 0.224, 0.225]),
        ])

    def __len__(self):
        return len(self.image_paths)

    def __getitem__(self, idx):
        image = Image.open(self.image_paths[idx]).convert('RGB')
        image = self.transform(image)
        return image, self.labels[idx]
```

</Code>

<Remark id="rmk-dataset-performance">
**Performance considerations for `__getitem__`:**

| Issue | Symptom | Fix |
|-------|---------|-----|
| Heavy preprocessing in `__getitem__` | CPU-bound, GPU idle | Preprocess and save to disk; load preprocessed data |
| Reading many small files | I/O-bound (SSD seeks) | Pack into fewer large files (WebDataset, TFRecord, Arrow/Parquet) |
| PIL/OpenCV image decoding | CPU-bound | Use NVIDIA DALI for GPU-accelerated decoding |
| Tokenization per sample | CPU-bound for long sequences | Pre-tokenize and save; use memory-mapped files |
| Large Python objects in `__init__` | High memory per worker | Use memory-mapped arrays (`np.memmap`) or Arrow tables |

**Rule of thumb:** If `__getitem__` takes more than 1 ms, it is likely the bottleneck. Profile with `time.perf_counter()` or PyTorch profiler.
</Remark>

## DataLoader

`DataLoader` wraps a `Dataset` and handles batching, shuffling, parallel loading, and memory transfer:

<Code id="code-dataloader" caption="DataLoader configuration: all the important parameters explained.">

```python
loader = DataLoader(
    dataset,
    batch_size=32,           # Samples per batch
    shuffle=True,            # Randomize order each epoch (for training)
    num_workers=4,           # Number of parallel data loading processes
    pin_memory=True,         # Use page-locked memory for faster GPU transfer
    drop_last=True,          # Drop last incomplete batch (important for DDP)
    prefetch_factor=2,       # Each worker prefetches this many batches (only valid when num_workers > 0)
    persistent_workers=True, # Keep workers alive between epochs (avoids fork overhead)
    collate_fn=None,         # Custom function to merge samples into a batch
)

# Training loop
for batch in loader:
    # batch is on CPU: move to GPU with non_blocking for async transfer
    input_ids = batch['input_ids'].cuda(non_blocking=True)
    labels = batch['label'].cuda(non_blocking=True)
    output = model(input_ids)
```

</Code>

<Table id="tab-dataloader-params" caption="DataLoader parameters: defaults, recommendations, and tradeoffs.">

| Parameter | Default | Recommendation | Effect |
|-----------|---------|---------------|--------|
| `batch_size` | 1 | Task-dependent (8-256 typical) | Larger = better GPU utilization, but more memory |
| `num_workers` | 0 | 4-8 per GPU | More = faster loading, but more CPU/RAM |
| `pin_memory` | False | **True** (always for GPU training) | Often 10-30% faster CPU-to-GPU transfer depending on batch size and transfer pattern |
| `prefetch_factor` | `None` (effective 2 when num_workers > 0) | 2-4 | Higher = smoother pipeline, but more memory. Setting it with num_workers=0 raises an error |
| `persistent_workers` | False | **True** (if num_workers > 0) | Avoids worker restart overhead between epochs |
| `shuffle` | False | **True** for training, **False** for eval | Randomization for SGD; deterministic for eval |
| `drop_last` | False | **True** for DDP training | Ensures all ranks get same-sized batches |
| `collate_fn` | Default | Custom for variable-length sequences | Controls how samples are merged |

</Table>

<Remark id="rmk-num-workers">
**Choosing `num_workers`.** The optimal number of workers depends on your data pipeline:

```python
# Quick benchmark to find optimal num_workers
import time

for num_workers in [0, 1, 2, 4, 8, 16]:
    loader = DataLoader(dataset, batch_size=32, num_workers=num_workers, pin_memory=True)
    start = time.perf_counter()
    for i, batch in enumerate(loader):
        if i >= 50:
            break
    elapsed = time.perf_counter() - start
    print(f"num_workers={num_workers}: {elapsed:.2f}s for 50 batches")
```

**Common guidelines:**
- Start with `num_workers = 4 * num_gpus`
- If CPU utilization is low and GPU is idle between batches, increase workers
- If you run out of RAM, reduce workers (each worker gets a copy of the dataset)
- `num_workers=0` means loading happens in the main process (useful for debugging)
- On Windows, `num_workers > 0` requires `if __name__ == '__main__':` guard
</Remark>

<Remark id="rmk-pin-memory-explained">
**How `pin_memory` works.** Normal CPU memory can be swapped to disk by the OS (virtual memory paging). CUDA's DMA engine cannot access swapped memory, so without `pin_memory`, the transfer path is:

```
Without pin_memory:  Regular RAM → Pinned staging buffer → GPU HBM  (2 copies)
With pin_memory:     Pinned RAM → GPU HBM                           (1 copy)
```

The extra copy can add significant overhead (often 10-30% depending on workload). Always use `pin_memory=True` when training on GPU.

`non_blocking=True` on `.cuda()` makes the transfer asynchronous: the CPU starts the DMA transfer and immediately continues to the next operation, overlapping data transfer with GPU computation.
</Remark>

## IterableDataset

For streaming data that does not fit in memory, or data that arrives sequentially (logs, real-time feeds):

<Code id="code-iterable-dataset" caption="IterableDataset for streaming and large-scale data.">

```python
import glob
import json
import torch
from torch.utils.data import IterableDataset, DataLoader

class StreamingDataset(IterableDataset):
    def __init__(self, file_paths):
        super().__init__()
        self.file_paths = file_paths

    def __iter__(self):
        # IMPORTANT: shard across workers to avoid duplicate data
        worker_info = torch.utils.data.get_worker_info()
        if worker_info is None:
            # Single-process loading
            files = self.file_paths
        else:
            # Multi-process: each worker processes a subset of files
            # Note: if len(file_paths) < num_workers, use round-robin instead:
            # files = self.file_paths[worker_info.id::worker_info.num_workers]
            per_worker = len(self.file_paths) // worker_info.num_workers
            worker_id = worker_info.id
            start = worker_id * per_worker
            end = start + per_worker if worker_id < worker_info.num_workers - 1 \
                  else len(self.file_paths)
            files = self.file_paths[start:end]

        for path in files:
            with open(path, 'r') as f:
                for line in f:
                    yield json.loads(line)  # Yield one parsed sample at a time

# Usage
dataset = StreamingDataset(glob.glob('/data/train/*.jsonl'))
loader = DataLoader(dataset, batch_size=32, num_workers=4)
```

</Code>

<Remark id="rmk-iterable-pitfalls">
**IterableDataset pitfalls:**

1. **No `__len__`:** IterableDatasets have no length, so progress bars and epoch-based scheduling do not work without manual tracking.

2. **Worker duplication:** Without manual sharding (as shown above), each worker iterates over the *entire* dataset, producing duplicate samples. This is the most common IterableDataset bug.

3. **No random access:** You cannot index into an IterableDataset. Shuffling must be done at the file level or with a shuffle buffer:
   ```python
   # Shuffle buffer: maintain a buffer and randomly sample from it
   buffer = []
   for sample in stream:
       buffer.append(sample)
       if len(buffer) >= buffer_size:
           idx = random.randint(0, len(buffer) - 1)
           yield buffer.pop(idx)
   ```

4. **Distributed training:** With DDP, you must shard across *both* workers and ranks. Use `torch.distributed.get_rank()` and `get_world_size()` for rank-level sharding.
</Remark>

## Custom collate_fn

The collate function controls how individual samples are merged into a batch. The default collate stacks tensors and creates batched containers. You need a custom collate for variable-length sequences:

<Code id="code-collate-fn" caption="Custom collate functions for variable-length data.">

```python
def dynamic_padding_collate(batch):
    """Pad sequences to the longest in the BATCH (not global max).
    This saves computation vs. padding to a fixed max length."""
    input_ids = [item['input_ids'] for item in batch]
    labels = torch.stack([item['label'] for item in batch])

    # Pad to max length in this specific batch
    max_len = max(ids.size(0) for ids in input_ids)
    padded_ids = torch.zeros(len(input_ids), max_len, dtype=torch.long)
    attention_mask = torch.zeros(len(input_ids), max_len, dtype=torch.long)

    for i, ids in enumerate(input_ids):
        padded_ids[i, :ids.size(0)] = ids
        attention_mask[i, :ids.size(0)] = 1

    return {
        'input_ids': padded_ids,
        'attention_mask': attention_mask,
        'label': labels,
    }

# Alternative: use torch's pad_sequence utility
from torch.nn.utils.rnn import pad_sequence

def collate_with_pad_sequence(batch):
    input_ids = [item['input_ids'] for item in batch]
    labels = torch.stack([item['label'] for item in batch])
    input_ids = pad_sequence(input_ids, batch_first=True, padding_value=0)
    attention_mask = (input_ids != 0).long()
    return {'input_ids': input_ids, 'attention_mask': attention_mask, 'label': labels}

loader = DataLoader(dataset, batch_size=32, collate_fn=dynamic_padding_collate)
```

</Code>

<Remark id="rmk-bucketing">
**Bucketing for even more efficiency.** Dynamic padding within a batch still wastes compute when sequence lengths vary widely (e.g., padding a 10-token sequence to match a 500-token sequence). **Bucketing** groups similar-length sequences together:

```python
# Sort dataset by length, then create batches from similar-length sequences
from torch.utils.data import Sampler

class BucketSampler(Sampler):
    def __init__(self, lengths, batch_size, shuffle=True):
        self.sorted_indices = sorted(range(len(lengths)), key=lambda i: lengths[i])
        self.batch_size = batch_size
        self.shuffle = shuffle

    def __iter__(self):
        # Create batches of similar-length sequences
        batches = [self.sorted_indices[i:i+self.batch_size]
                   for i in range(0, len(self.sorted_indices), self.batch_size)]
        if self.shuffle:
            random.shuffle(batches)  # Shuffle batch ORDER, not within-batch order
        for batch in batches:
            # Note: 'yield from' produces flat indices; DataLoader re-batches them.
            # Bucket boundaries only hold when len(dataset) divides evenly by batch_size.
            # For guaranteed bucket-aligned batches, implement as a batch_sampler instead.
            yield from batch

    def __len__(self):
        return len(self.sorted_indices)
```

This can cut wasted padding substantially for NLP workloads with variable-length inputs, typically by roughly a third to a half, though the exact figure depends entirely on the length distribution. The example below works through one such distribution.
</Remark>

<Example id="ex-padding-savings">

**Counting padded tokens under three padding strategies.** Take six sequences with token lengths `10, 40, 60, 90, 480, 500` (total real content `10 + 40 + 60 + 90 + 480 + 500 = 1180` tokens), batched two at a time, with a fixed maximum length of `512`. The compute cost of a transformer batch scales with the total number of *padded* tokens, so we count those for each strategy.

*Step 1: fixed-max padding.* Every sequence is padded to `512`, regardless of its content:

$$T_{\text{fixed}} = 6 \times 512 = 3072 \text{ tokens}.$$

*Step 2: dynamic padding with random batching.* Each batch is padded to the longest sequence *in that batch*. With a random pairing such as `(10, 500)`, `(40, 480)`, `(60, 90)`, the per-batch maxima are `500, 480, 90`:

$$T_{\text{dynamic}} = 2(500) + 2(480) + 2(90) = 1000 + 960 + 180 = 2140 \text{ tokens}.$$

*Step 3: bucketed padding.* Sort by length first (`10, 40, 60, 90, 480, 500`), then batch adjacent sequences: `(10, 40)`, `(60, 90)`, `(480, 500)`, giving maxima `40, 90, 500`:

$$T_{\text{bucket}} = 2(40) + 2(90) + 2(500) = 80 + 180 + 1000 = 1260 \text{ tokens}.$$

*Step 4: the savings.* Bucketing cuts the padded-token count relative to dynamic random batching by

$$\frac{T_{\text{dynamic}} - T_{\text{bucket}}}{T_{\text{dynamic}}} = \frac{2140 - 1260}{2140} \approx 0.41,$$

a 41% reduction, which lands squarely in the typical third-to-half range quoted above. Relative to fixed-max padding the saving is even larger (`(3072 - 1260) / 3072 ≈ 59%`), but fixed-max is rarely the realistic baseline once dynamic padding is in place.

</Example>

## Distributed Data Loading

In distributed training (DDP), each GPU must process a different subset of the data:

<Code id="code-distributed-loading" caption="Distributed data loading with DistributedSampler.">

```python
from torch.utils.data.distributed import DistributedSampler

# Create sampler that shards data across ranks
sampler = DistributedSampler(
    dataset,
    num_replicas=world_size,   # Total number of GPUs
    rank=rank,                  # This GPU's rank
    shuffle=True,               # Shuffle within each rank's shard
    drop_last=True,             # Ensure all ranks get same number of batches
)

loader = DataLoader(
    dataset,
    batch_size=32,
    sampler=sampler,            # Replaces shuffle=True (sampler handles shuffling)
    num_workers=4,
    pin_memory=True,
    drop_last=True,             # Also drop_last in DataLoader for safety
    persistent_workers=True,
)

# CRITICAL: set epoch on sampler for proper shuffling
# Without this, each epoch sees the same data order!
for epoch in range(num_epochs):
    sampler.set_epoch(epoch)    # Changes the random seed for shuffling
    for batch in loader:
        input = batch.cuda(non_blocking=True)
        ...
```

</Code>

<Remark id="rmk-distributed-pitfalls">
**Distributed data loading pitfalls:**

1. **Forgetting `sampler.set_epoch(epoch)`:** Without this, every epoch uses the same shuffle order, reducing effective data diversity.

2. **Using `shuffle=True` with `DistributedSampler`:** The sampler handles shuffling. Setting `shuffle=True` in `DataLoader` alongside a sampler raises an error.

3. **Unequal last batch:** If the dataset size is not divisible by `world_size * batch_size`, some ranks may get fewer samples. This causes a hang because AllReduce requires all ranks to participate. Solution: `drop_last=True` in both sampler and DataLoader.

4. **Data augmentation reproducibility:** With `num_workers > 0`, each worker has its own random state. Use a `worker_init_fn` to seed workers deterministically:
   ```python
   def worker_init_fn(worker_id):
       seed = torch.initial_seed() % 2**32
       np.random.seed(seed + worker_id)
       random.seed(seed + worker_id)

   loader = DataLoader(dataset, ..., worker_init_fn=worker_init_fn)
   ```
</Remark>

## Data Loading Performance Checklist

<Table id="tab-data-checklist" caption="Data loading performance checklist.">

| Check | Why | How to Verify |
|-------|-----|--------------|
| `pin_memory=True` | Faster CPU-to-GPU transfer | Benchmark with/without |
| `.cuda(non_blocking=True)` | Async transfer, overlaps with compute | Profile timeline |
| `num_workers >= 4` | Parallel data preprocessing | GPU utilization > 90%? |
| `persistent_workers=True` | Avoid worker restart overhead | Measure epoch transition time |
| Preprocessed data on fast storage | Avoid CPU preprocessing bottleneck | Check worker CPU utilization |
| Dynamic padding (not fixed max) | Reduce wasted computation | Compare batch processing time |
| Bucketed sampling | Group similar-length sequences | Compare padding ratio |
| Pre-tokenized data | Avoid tokenizer overhead | Profile `__getitem__` |
| Memory-mapped files | Reduce RAM usage with many workers | Monitor RSS per worker |

</Table>
