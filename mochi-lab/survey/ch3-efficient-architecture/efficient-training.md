---
sidebar_position: 8
title: "Efficient Training"
---

## Efficient Training

Training large neural networks is among the most computationally expensive endeavors in computing. Training GPT-4 reportedly required approximately 10^25 FLOPs; a single training run of a frontier LLM consumes as much electricity as hundreds of American households use in a year. This section surveys techniques that reduce the cost of training -- measured in compute, memory, time, or energy -- without degrading the final model quality.

### Mixed Precision Training

**Micikevicius et al. (2018)** [@micikevicius2018mixed] established the foundation of mixed precision training, demonstrating that neural networks can be trained with a combination of lower-precision (FP16) and full-precision (FP32) arithmetic without sacrificing accuracy. The technique uses FP16 for the computationally expensive forward and backward passes (matrix multiplications) while maintaining a master copy of weights in FP32 for the update step. A loss scaling factor is applied to prevent gradient underflow in FP16.

Mixed precision training roughly halves memory usage (FP16 weights and activations) and doubles throughput on hardware with FP16 tensor cores, providing one of the highest impact-to-complexity ratios of any efficiency technique. **BFloat16 (BF16)** has since become the preferred training precision for large models, offering the same exponent range as FP32 (8 bits, vs. FP16's 5 bits) at the cost of reduced mantissa precision. BF16's larger dynamic range eliminates the need for loss scaling in most cases, simplifying the training pipeline while maintaining the speed and memory benefits of half precision.

**FP8 training** is an emerging frontier: Micikevicius et al. (2022) [@micikevicius2022fp8] demonstrated that training with 8-bit floating point is feasible for large language models with appropriate scaling techniques, potentially doubling throughput again relative to BF16 on hardware that supports it (e.g., NVIDIA H100 with FP8 tensor cores).

### Gradient Checkpointing (Activation Recomputation)

**Chen et al. (2016)** [@chen2016training] proposed gradient checkpointing, which trades compute for memory by discarding intermediate activations during the forward pass and recomputing them during the backward pass. In a network with L layers, standard training stores all L layers' activations (O(L) memory), while gradient checkpointing stores only sqrt(L) checkpoints and recomputes the intermediate activations between them, reducing memory to O(sqrt(L)) at the cost of roughly 33% additional compute (one extra forward pass through each segment).

Selective gradient checkpointing, implemented in frameworks like PyTorch and JAX, allows fine-grained control over which layers to checkpoint, enabling users to balance memory savings against compute cost based on their specific constraints. In practice, gradient checkpointing is nearly universal for training large models, as the 33% compute overhead is far cheaper than the cost of additional GPU memory.

### ZeRO and Fully Sharded Data Parallel

**ZeRO (Zero Redundancy Optimizer)** (Rajbhandari et al., 2020) [@rajbhandari2020zero] fundamentally changed how large models are trained by eliminating redundant memory consumption in data-parallel training. In standard data parallelism, each worker maintains a full copy of the model parameters, gradients, and optimizer states (e.g., Adam's first and second moments) -- a 3x overhead beyond the model parameters themselves. For a 7B parameter model in mixed precision, this amounts to roughly 112 GB per worker (7B params * 16 bytes per param for fp32 optimizer states and gradients).

ZeRO partitions this state across data-parallel workers in three stages:
- **ZeRO-1:** Partitions optimizer states (reduces memory by ~4x)
- **ZeRO-2:** Partitions optimizer states + gradients (reduces memory by ~8x)
- **ZeRO-3:** Partitions optimizer states + gradients + parameters (reduces memory by proportional to the number of workers, enabling models larger than any single GPU's memory)

ZeRO is implemented in the **DeepSpeed** library (Microsoft) [@rajbhandari2020zero], which has become one of the two dominant frameworks (alongside PyTorch FSDP) for large-scale model training. DeepSpeed also provides ZeRO-Offload (offloading optimizer states to CPU memory), ZeRO-Infinity (extending offloading to NVMe storage), and sparse attention kernels for efficient long-context training.

**PyTorch FSDP (Fully Sharded Data Parallel)** [@zhao2023pytorch] implements ZeRO-3-style sharding in the PyTorch ecosystem, becoming the standard tool for large-scale training in the research community. FSDP dynamically gathers parameters before each forward/backward operation and reshards them immediately after, overlapping communication with computation. The choice between DeepSpeed and FSDP is largely one of ecosystem preference, as both implement similar sharding strategies with comparable performance.

### Tensor Parallelism

**Megatron-LM** (Shoeybi et al., 2020) [@shoeybi2020megatronlm] introduced efficient tensor parallelism for Transformer models, splitting individual layers (attention heads and FFN columns) across multiple GPUs within a node. The key insight is that attention and FFN layers have natural split points that require only a single all-reduce communication per layer (for the forward pass) and one all-reduce per layer (for the backward pass). Tensor parallelism is most effective within a single node where high-bandwidth NVLink interconnects minimize communication overhead.

### Pipeline Parallelism

**GPipe** (Huang et al., 2019) [@huang2019gpipe] introduced pipeline parallelism, which partitions a model across devices layer-wise and uses **micro-batching** to keep all devices utilized. A mini-batch is split into multiple micro-batches that flow through the pipeline stages sequentially, with each device processing different micro-batches simultaneously. The "pipeline bubble" -- time when some stages are idle because the pipeline is filling or draining -- is the main overhead, and is minimized by using many micro-batches (at the cost of higher memory usage for storing intermediate activations).

**PipeDream** (Narayanan et al., 2019) [@narayanan2019pipedream] proposed 1F1B (one forward, one backward) scheduling, which interleaves forward and backward micro-batches to reduce the pipeline bubble and limit memory usage. This scheduling has been adopted by virtually all subsequent pipeline parallelism implementations.

**Narayanan et al. (2021)** [@narayanan2021efficient] unified tensor, pipeline, and data parallelism into the **"3D parallelism"** strategy used to train frontier models. The typical configuration assigns tensor parallelism within a node (high-bandwidth communication), pipeline parallelism across nodes within a cluster (moderate bandwidth), and data parallelism across clusters (low bandwidth), matching parallelism granularity to the communication topology.

### Data Efficiency

Beyond hardware and parallelism, training efficiency can be improved by making better use of data:

**Curriculum learning** (Bengio et al., 2009) [@bengio2009curriculum] trains models on examples ordered by difficulty, from easy to hard. While the benefits for large-scale pre-training are debated, curriculum learning has shown clear benefits for fine-tuning and for training on noisy data where easy-to-hard ordering helps the model learn robust features before encountering difficult or noisy examples.

**Data pruning and filtering** -- selecting the most informative training examples rather than training on all available data -- can achieve the same final quality with fewer training steps. SemDeDup [@abbas2023semdedup] uses semantic similarity to deduplicate training data, removing near-duplicates that contribute minimally to learning. D4 [@tirumala2024d4] uses density-based data selection to identify and prioritize high-quality training examples.

**Chinchilla-optimal training** [@hoffmann2022training] itself is an efficiency technique: by allocating compute according to scaling laws (matching model size and data size), the same final quality can be achieved with significantly less total compute than the prevailing over-parameterized approach. The Chinchilla insight -- that most models were under-trained relative to their size -- shifted billions of dollars of compute allocation.
