---
sidebar_position: 4
---

# Data Loading

## Dataset

A `Dataset` maps an index to a sample:

<Code id="code-data-loading-1" caption="A `Dataset` maps an index to a sample.">

```python
from torch.utils.data import Dataset, DataLoader

class TextDataset(Dataset):
    def __init__(self, texts, labels, tokenizer, max_len=512):
        self.texts = texts
        self.labels = labels
        self.tokenizer = tokenizer
        self.max_len = max_len

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, idx):
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
```

</Code>

## DataLoader

`DataLoader` handles batching, shuffling, and parallel loading:

<Code id="code-data-loading-2" caption="`DataLoader` handles batching, shuffling, and parallel loading.">

```python
loader = DataLoader(
    dataset,
    batch_size=32,
    shuffle=True,          # Shuffle each epoch
    num_workers=4,         # Parallel data loading processes
    pin_memory=True,       # Pin memory for faster GPU transfer
    drop_last=True,        # Drop incomplete last batch
    prefetch_factor=2,     # Prefetch 2 batches per worker
)

for batch in loader:
    input_ids = batch['input_ids'].cuda(non_blocking=True)
    labels = batch['label'].cuda(non_blocking=True)
    output = model(input_ids)
```

</Code>

<Remark id="rmk-data-loading-1">
**Tip:** Use `pin_memory=True` with `.cuda(non_blocking=True)` to overlap data transfer with computation. This can give a 10-20% speedup.
</Remark>

## IterableDataset

For streaming data that does not fit in memory:

<Code id="code-data-loading-3" caption="For streaming data that does not fit in memory.">

```python
class StreamingDataset(torch.utils.data.IterableDataset):
    def __init__(self, file_paths):
        self.file_paths = file_paths

    def __iter__(self):
        worker_info = torch.utils.data.get_worker_info()
        if worker_info is None:
            files = self.file_paths
        else:
            # Split files across workers
            per_worker = len(self.file_paths) // worker_info.num_workers
            start = worker_info.id * per_worker
            files = self.file_paths[start:start + per_worker]

        for path in files:
            with open(path, 'r') as f:
                for line in f:
                    yield process_line(line)
```

</Code>

<Remark id="rmk-data-loading-2">
**Warning:** With `IterableDataset` and `num_workers > 0`, each worker gets a copy of the dataset. Without manual sharding (as shown above), data is duplicated.
</Remark>

## Custom collate_fn

Control how samples are batched:

<Code id="code-data-loading-4" caption="Control how samples are batched.">

```python
def collate_fn(batch):
    """Pad sequences to the longest in the batch (dynamic padding)."""
    input_ids = [item['input_ids'] for item in batch]
    labels = torch.stack([item['label'] for item in batch])

    # Pad to max length in this batch (not global max)
    input_ids = torch.nn.utils.rnn.pad_sequence(
        input_ids, batch_first=True, padding_value=0
    )
    attention_mask = (input_ids != 0).long()

    return {
        'input_ids': input_ids,
        'attention_mask': attention_mask,
        'label': labels,
    }

loader = DataLoader(dataset, batch_size=32, collate_fn=collate_fn)
```

</Code>

## Distributed Data Loading

<Code id="code-data-loading-5" caption="Code example.">

```python
from torch.utils.data.distributed import DistributedSampler

sampler = DistributedSampler(
    dataset,
    num_replicas=world_size,
    rank=rank,
    shuffle=True,
)

loader = DataLoader(
    dataset,
    batch_size=32,
    sampler=sampler,      # Replaces shuffle=True
    num_workers=4,
    pin_memory=True,
)

# Must set epoch for proper shuffling
for epoch in range(num_epochs):
    sampler.set_epoch(epoch)
    for batch in loader:
        ...
```

</Code>

<Remark id="rmk-data-loading-3">
**Tip:** When using `DistributedSampler`, do not set `shuffle=True` in the DataLoader. The sampler handles shuffling and ensures each GPU sees a different subset of the data.
</Remark>
