---
sidebar_position: 8
title: "Efficient Training"
---

## Efficient Training

### Mixed Precision Training

Micikevicius et al. (2018) [@micikevicius2018mixed] demonstrated that training in mixed precision (FP16 for forward/backward passes, FP32 for master weights) achieves identical accuracy while roughly halving memory usage and doubling throughput on hardware with FP16 tensor cores. BF16 (brain floating point) has since become the standard training precision for large models, offering better numerical stability than FP16 with similar efficiency.

### Gradient Checkpointing

Chen et al. (2016) [@chen2016training] proposed gradient checkpointing (also called activation recomputation), which trades compute for memory by recomputing activations during the backward pass rather than storing them. This enables training much larger models or with much longer sequences within fixed memory budgets, at the cost of roughly 33% additional compute.

### ZeRO and FSDP

Rajbhandari et al. (2020) [@rajbhandari2020zero] introduced ZeRO (Zero Redundancy Optimizer), which partitions optimizer states, gradients, and model parameters across data-parallel workers, eliminating redundant storage. ZeRO-3 partitions all three, enabling training of models much larger than any single GPU's memory. PyTorch FSDP (Fully Sharded Data Parallel) [@zhao2023pytorch] implements similar ideas in the PyTorch ecosystem and has become a standard tool for large-scale training.

### Pipeline Parallelism

Huang et al. (2019) [@huang2019gpipe] introduced GPipe, which partitions a model across devices layer-wise and uses micro-batching to keep all devices utilized. Pipeline parallelism, combined with tensor parallelism (splitting individual layers across devices) and data parallelism, forms the "3D parallelism" strategy used to train frontier models [@narayanan2021efficient].
