# Chapter 3: Efficient Architecture Design of AI

## 3.1 Introduction & Motivation

The scaling paradigm that has driven the deep learning revolution -- larger models, more data, more compute -- is approaching fundamental limits. Training frontier language models now costs tens of millions of dollars, consumes megawatt-hours of electricity, and requires months on thousands of accelerators [1, 2]. Inference costs scale with user demand, making deployment of large models prohibitively expensive for many applications. The environmental impact of this trajectory is increasingly scrutinized [3].

Efficiency in AI architecture design has thus become a first-class objective, no longer a secondary concern to be addressed after accuracy is maximized. The goal is to achieve the same or better performance with fewer FLOPs, less memory, lower latency, or reduced energy consumption. This encompasses a broad spectrum of approaches: from fundamental architectural innovations that reduce the computational complexity of attention mechanisms, to engineering techniques for efficient training and inference, to automated methods for discovering efficient architectures.

This chapter surveys the landscape of efficient architecture design, organized by technique family. We cover efficient attention mechanisms and sub-quadratic alternatives to the Transformer, Mixture-of-Experts models, neural architecture search, model compression, training efficiency, inference optimization, and the rapidly evolving family of state space models. The goal is to provide a comprehensive map of the field that connects theoretical advances to practical deployment considerations.

## 3.2 Problem Formulation

### FLOP-Accuracy Tradeoffs

The central problem in efficient architecture design is optimizing the Pareto frontier of computational cost versus task performance [4]. Given a computational budget B (measured in FLOPs, memory, latency, or energy), the goal is to find architecture A* and parameters theta* that maximize performance:

A*, theta* = argmax_{A, theta} Performance(A, theta) subject to Cost(A, theta) <= B

This formulation applies at multiple levels: architecture design (macro choices like layer types), training (how to use the compute budget most effectively), and inference (how to serve predictions cheaply).

### Scaling Laws

Kaplan et al. (2020) [1] and Hoffmann et al. (2022) [2] established scaling laws that relate model size, dataset size, and compute budget to performance. The Chinchilla scaling laws [2] showed that many models were over-parameterized relative to their training data, leading to a paradigm shift toward training smaller models on more data. Efficient architecture design can be viewed as changing the constants in these scaling laws -- achieving the same performance curve at lower absolute cost.

### Efficiency Metrics

Key metrics for evaluating efficiency include:
- **FLOPs per token** (training and inference)
- **Wall-clock time** (accounting for hardware utilization)
- **Memory footprint** (peak memory, KV-cache size)
- **Throughput** (tokens/second at given batch size)
- **Energy consumption** (kWh per training run or per inference query)

## 3.3 Taxonomy of Approaches

Efficient architecture methods can be organized into the following families:

1. **Efficient attention mechanisms:** Reducing the O(n^2) cost of self-attention
2. **Mixture of Experts (MoE):** Conditional computation that activates only a fraction of parameters
3. **Neural Architecture Search (NAS):** Automated discovery of efficient architectures
4. **Model compression:** Distillation, pruning, and quantization of trained models
5. **Efficient training:** Techniques for reducing training cost
6. **Inference optimization:** Techniques for faster and cheaper deployment
7. **Sub-quadratic architectures:** Fundamental alternatives to the Transformer

## 3.4 Efficient Attention

The self-attention mechanism in Transformers has O(n^2) time and memory complexity in sequence length n, creating a bottleneck for long sequences [5].

### 3.4.1 Sparse Attention

Sparse attention patterns reduce computation by attending to only a subset of positions. Child et al. (2019) [6] introduced Sparse Transformers with fixed stride and local attention patterns achieving O(n * sqrt(n)) complexity. BigBird (Zaheer et al., 2020) [7] combined random, window, and global attention patterns to achieve linear complexity while retaining theoretical expressiveness (Turing completeness). Longformer (Beltagy et al., 2020) [8] used a similar combination of local windowed attention and task-specific global attention for long document processing.

### 3.4.2 Linear Attention

Linear attention mechanisms replace the softmax attention kernel with linear dot-product operations, reducing complexity from O(n^2) to O(n). Katharopoulos et al. (2020) [9] showed that attention can be reformulated as a linear dot-product of kernel feature maps, enabling causal attention computation in O(n) time using the associative property of matrix multiplication. However, linear attention often suffers from reduced expressiveness compared to softmax attention [10].

### 3.4.3 FlashAttention

Dao et al. (2022, 2023) [11, 12] introduced FlashAttention, which does not change the mathematical computation but dramatically improves its hardware efficiency. FlashAttention uses tiling and kernel fusion to compute exact attention while minimizing reads/writes to GPU high-bandwidth memory (HBM). FlashAttention-2 [12] further optimized work partitioning across GPU thread blocks, achieving 2x speedup over FlashAttention. FlashAttention-3 (2024) [13] exploits asynchronous operations and tensor cores on Hopper GPUs.

FlashAttention has become the de facto standard for attention computation, demonstrating that IO-aware algorithm design can achieve speedups comparable to algorithmic complexity improvements. It enables training with much longer sequences (up to 64k+ tokens) without approximation.

### 3.4.4 Multi-Query and Grouped-Query Attention

Shazeer (2019) [14] proposed Multi-Query Attention (MQA), where all attention heads share a single set of key-value projections while maintaining separate query projections. This dramatically reduces the KV-cache size during inference (important for high-throughput serving) with minimal quality loss. Ainslie et al. (2023) [15] proposed Grouped-Query Attention (GQA) as an interpolation between multi-head and multi-query attention, grouping heads to share KV projections. GQA is used in Llama 2 and many subsequent models as a practical balance between quality and inference efficiency.

## 3.5 Mixture of Experts

Mixture-of-Experts (MoE) models activate only a subset of parameters for each input, enabling much larger total model capacity without proportional compute increases [16].

### 3.5.1 GShard and Sparsely-Gated MoE

Shazeer et al. (2017) [16] revived the MoE concept for deep learning with the Sparsely-Gated Mixture-of-Experts layer, demonstrating 1000x capacity increases with modest compute overhead. Lepikhin et al. (2021) [17] scaled this with GShard, training a 600B-parameter MoE model for machine translation across 2048 TPU cores with automatic parallelism.

### 3.5.2 Switch Transformer

Fedus et al. (2022) [18] simplified MoE routing to a Switch layer that routes each token to exactly one expert (top-1 routing). This simplification improved training stability and enabled scaling to trillion-parameter models. Switch Transformers achieved 4-7x pre-training speedups over dense T5 models at equivalent compute budgets.

### 3.5.3 ST-MoE

Zoph et al. (2022) [19] conducted a comprehensive study of MoE design choices in ST-MoE (Sparse Transformer with MoE). They identified critical design decisions including router z-loss for training stability, auxiliary load-balancing losses, and the importance of capacity factor tuning. ST-MoE established best practices for MoE training that subsequent work builds upon.

### 3.5.4 Mixtral

Jiang et al. (2024) [20] released Mixtral 8x7B, a sparse MoE model that routes each token to 2 of 8 expert FFN modules. Despite having 47B total parameters, Mixtral uses only 13B parameters per forward pass, matching or exceeding Llama 2 70B performance while being 6x faster at inference. Mixtral demonstrated that MoE is viable for open-source deployment, not just research.

### 3.5.5 DeepSeek-MoE

Dai et al. (2024) [21] introduced DeepSeek-MoE, which uses fine-grained expert segmentation and shared expert isolation. Instead of a few large experts, DeepSeek-MoE uses many small experts (e.g., 64 experts with top-6 routing), with some experts designated as "shared" that process all tokens. This design improves expert specialization and achieves comparable performance to dense models with substantially fewer activated parameters. The DeepSeek-V2 and V3 models extended this approach to multi-hundred-billion parameter scales.

### 3.5.6 MoE Challenges

Key challenges in MoE models include: load imbalance (some experts receiving disproportionately many tokens), expert collapse (experts becoming redundant), routing instability during training, and the complexity of distributed training across devices where different experts reside [18, 19, 22].

## 3.6 Neural Architecture Search

Neural Architecture Search (NAS) automates the design of neural network architectures, potentially discovering designs that human engineers would not consider [23].

### 3.6.1 DARTS

Liu et al. (2019) [24] proposed DARTS (Differentiable Architecture Search), which relaxes the discrete architecture search space to be continuous, enabling gradient-based optimization. DARTS jointly optimizes architecture parameters and model weights using bilevel optimization, reducing search cost from thousands of GPU-days to a single GPU-day.

### 3.6.2 EfficientNet

Tan and Le (2019) [25] used NAS to discover EfficientNet, a family of models that uniformly scale width, depth, and resolution using a compound scaling coefficient. EfficientNet-B7 achieved state-of-the-art ImageNet accuracy while being 8.4x smaller and 6.1x faster than the best existing models.

### 3.6.3 Once-for-All (OFA)

Cai et al. (2020) [26] proposed Once-for-All networks, which train a single large network that supports many sub-networks of different sizes. At deployment time, the appropriate sub-network is selected based on hardware constraints without retraining. This amortizes the NAS cost and enables efficient deployment across diverse hardware.

### 3.6.4 Hardware-Aware NAS

Modern NAS increasingly incorporates hardware constraints directly into the search objective [27, 28]. Rather than optimizing only for accuracy, hardware-aware NAS optimizes for latency, energy consumption, or throughput on specific target devices. This has produced architectures like MobileNet v3 and EfficientNet-EdgeTPU that are specifically tailored for mobile and edge deployment.

## 3.7 Model Compression

Model compression reduces the size and computational requirements of trained models through distillation, pruning, and quantization.

### 3.7.1 Knowledge Distillation

Hinton et al. (2015) [29] formalized knowledge distillation, where a smaller "student" model is trained to mimic the outputs (soft targets) of a larger "teacher" model. The soft targets carry more information than hard labels (capturing inter-class relationships), enabling the student to achieve better performance than training on labels alone. Distillation has been extensively applied to compress large language models, with DistilBERT [30] showing that a 40% smaller BERT retains 97% of its performance.

### 3.7.2 Pruning

Pruning removes unnecessary parameters from trained models. Unstructured pruning (zeroing individual weights) can achieve very high sparsity (90%+) with minimal accuracy loss [31], but is difficult to accelerate on current hardware. Structured pruning (removing entire neurons, attention heads, or layers) produces models that are directly faster on standard hardware. The Lottery Ticket Hypothesis (Frankle and Carlin, 2019) [32] showed that dense networks contain sparse subnetworks ("winning tickets") that can match the full network's performance when trained in isolation.

### 3.7.3 Quantization

Quantization reduces the numerical precision of model parameters and activations. Post-training quantization (PTQ) methods quantize a trained model without retraining:

- **GPTQ** (Frantar et al., 2023) [33]: Uses approximate second-order information to quantize LLM weights to 3-4 bits with minimal quality loss. GPTQ processes weights layer by layer, making it practical for very large models.
- **AWQ** (Lin et al., 2024) [34]: Activation-Aware Weight Quantization protects salient weights (those corresponding to large activations) during quantization, achieving better quality than GPTQ at the same bit-width.
- **GGML/GGUF**: A practical quantization format by Georgi Gerganov that enables LLM inference on consumer CPUs, supporting 2-8 bit quantization with various schemes. GGML has been instrumental in the consumer LLM deployment ecosystem.

Quantization-aware training (QAT) incorporates quantization effects during training, generally achieving better quality than PTQ at the same precision level [35].

## 3.8 Efficient Training

### 3.8.1 Mixed Precision Training

Micikevicius et al. (2018) [36] demonstrated that training in mixed precision (FP16 for forward/backward passes, FP32 for master weights) achieves identical accuracy while roughly halving memory usage and doubling throughput on hardware with FP16 tensor cores. BF16 (brain floating point) has since become the standard training precision for large models, offering better numerical stability than FP16 with similar efficiency.

### 3.8.2 Gradient Checkpointing

Chen et al. (2016) [37] proposed gradient checkpointing (also called activation recomputation), which trades compute for memory by recomputing activations during the backward pass rather than storing them. This enables training much larger models or with much longer sequences within fixed memory budgets, at the cost of roughly 33% additional compute.

### 3.8.3 ZeRO and FSDP

Rajbhandari et al. (2020) [38] introduced ZeRO (Zero Redundancy Optimizer), which partitions optimizer states, gradients, and model parameters across data-parallel workers, eliminating redundant storage. ZeRO-3 partitions all three, enabling training of models much larger than any single GPU's memory. PyTorch FSDP (Fully Sharded Data Parallel) [39] implements similar ideas in the PyTorch ecosystem and has become a standard tool for large-scale training.

### 3.8.4 Pipeline Parallelism

Huang et al. (2019) [40] introduced GPipe, which partitions a model across devices layer-wise and uses micro-batching to keep all devices utilized. Pipeline parallelism, combined with tensor parallelism (splitting individual layers across devices) and data parallelism, forms the "3D parallelism" strategy used to train frontier models [41].

## 3.9 Inference Optimization

### 3.9.1 Speculative Decoding

Leviathan et al. (2023) [42] and Chen et al. (2023) [43] independently proposed speculative decoding, where a small "draft" model generates candidate tokens that are then verified in parallel by the large target model. Since verification of k tokens costs the same as generating 1 token (a single forward pass), speculative decoding can achieve 2-3x speedups when the draft model's acceptance rate is high, without any change in output distribution.

### 3.9.2 KV-Cache Optimization

The key-value cache grows linearly with sequence length during autoregressive generation, becoming a major memory bottleneck for long sequences. Several approaches address this:

- **Multi-Query/Grouped-Query Attention** [14, 15] reduces cache size at the architecture level.
- **PagedAttention** (Kwon et al., 2023) [44] manages KV-cache memory using virtual memory concepts, eliminating fragmentation and enabling near-optimal memory utilization. vLLM, built on PagedAttention, has become the standard serving framework.
- **KV-cache compression** methods like H2O (Zhang et al., 2024) [45] dynamically evict less important cache entries, maintaining quality while bounding memory usage.
- **SpeCache** (2025) [46] applies speculative execution concepts to KV-cache management, prefetching and managing cache entries based on predicted future attention patterns.

### 3.9.3 Continuous Batching and Serving

Efficient serving requires maximizing GPU utilization across multiple concurrent requests. Continuous batching (Yu et al., 2022) [47] dynamically adds and removes requests from a running batch as they arrive and complete, avoiding the throughput waste of static batching. This is implemented in systems like vLLM [44], TensorRT-LLM, and SGLang.

## 3.10 State Space Models

State Space Models (SSMs) offer a fundamentally different approach to sequence modeling, achieving linear complexity in sequence length while maintaining the ability to capture long-range dependencies.

### 3.10.1 S4

Gu et al. (2022) [48] introduced S4 (Structured State Spaces for Sequence Modeling), which parameterizes a continuous-time state space system and discretizes it for sequence processing. S4's key innovation is the HiPPO initialization, which provably enables long-range memory. S4 achieved breakthrough performance on the Long Range Arena benchmark, dramatically outperforming Transformers on tasks requiring very long-range dependencies (16k+ tokens).

### 3.10.2 Mamba

Gu and Dao (2024) [49] introduced Mamba, which makes SSM parameters input-dependent (selective), enabling content-based reasoning that fixed-parameter SSMs cannot perform. Mamba achieves linear-time sequence processing with a hardware-aware scan algorithm that avoids materializing the full state matrix. Mamba matches Transformer quality on language modeling while being 5x faster at inference for long sequences. Mamba-2 [50] further unified SSMs with structured attention, showing that selective state spaces and attention are mathematically related.

### 3.10.3 Jamba

Lieber et al. (2024) [51] introduced Jamba (AI21 Labs), a hybrid architecture that interleaves Mamba layers with Transformer attention layers and MoE modules. Jamba demonstrated that hybrid architectures combining SSM efficiency with attention's in-context learning ability can outperform pure Transformers and pure SSMs. With a 52B total parameter MoE model (12B active), Jamba delivered high quality with excellent efficiency.

### 3.10.4 Griffin

De et al. (2024) [52] (Google DeepMind) proposed Griffin, which combines gated linear recurrences (a simplified SSM variant) with local attention. Griffin demonstrated that even simple recurrent mechanisms, when combined with selective local attention, can match Transformer quality at large scale while being much more efficient for long-context inference.

## 3.11 Sub-Quadratic Architectures

Beyond SSMs, several other sub-quadratic architectures have been proposed.

### 3.11.1 Hyena

Poli et al. (2023) [53] introduced Hyena, which replaces attention with a hierarchy of data-controlled long convolutions and element-wise gating. Hyena achieves sub-quadratic complexity while maintaining the in-context learning capability that pure convolutional models lack. The data-dependent gating mechanism provides the selectivity that fixed convolutions miss.

### 3.11.2 RWKV

Peng et al. (2023) [54] proposed RWKV, which combines the parallelizable training of Transformers with the efficient inference of RNNs. RWKV uses a linear attention variant called WKV (weighted key-value) that can be computed either as a parallel scan (during training) or as a recurrence (during inference). RWKV models up to 14B parameters have been trained, demonstrating that linear-complexity architectures can scale.

### 3.11.3 BASED

Arora et al. (2024) [55] proposed BASED, which combines linear attention with sliding-window attention in a hybrid design. The key insight is that linear attention handles global context efficiently while local sliding-window attention captures fine-grained local patterns. BASED achieves strong language modeling performance with sub-quadratic complexity.

### 3.11.4 xLSTM

Beck et al. (2024) [56] revisited the LSTM architecture with xLSTM (Extended LSTM), introducing exponential gating and a novel memory mixing mechanism. xLSTM demonstrates that classical recurrent architectures, when modernized with insights from Transformers and SSMs, can be competitive with both. The mLSTM variant in xLSTM uses a matrix-valued memory state, bridging the gap between recurrent models and attention.

## 3.12 Benchmarks & Evaluation

### Standard Benchmarks

- **MLPerf** [57]: Industry-standard benchmarks for training and inference performance across hardware and software stacks. MLPerf measures wall-clock time to train to a target quality or inference throughput at target latency.
- **HELM** (Liang et al., 2023) [58]: The Holistic Evaluation of Language Models includes efficiency metrics alongside accuracy, evaluating models on a broad set of tasks with controlled compute budgets.
- **LMSys Chatbot Arena**: While primarily a quality benchmark, the serving infrastructure behind Chatbot Arena (using vLLM) has driven practical innovations in inference efficiency.
- **Long Range Arena** (Tay et al., 2021) [59]: Specifically designed to evaluate efficient sequence models on tasks requiring long-range dependencies (up to 16k tokens).

### Evaluation Challenges

Efficiency evaluation is complicated by hardware dependence (an architecture efficient on one GPU may not be on another), the distinction between theoretical complexity and practical speed (constant factors matter enormously), and the tradeoff between throughput and latency (high-throughput batched inference vs. low-latency single-query inference).

## 3.13 Open Problems & Future Directions

### Scaling Laws for Efficiency

While we have scaling laws for dense Transformers [1, 2], equivalent laws for MoE models, SSMs, and hybrid architectures are nascent. Understanding how efficiency gains scale with model size, data, and compute is critical for making informed architectural decisions at the frontier.

### Dynamic Compute Allocation

Current architectures allocate fixed compute per token (or per expert in MoE), but some tokens are "harder" than others. Adaptive computation -- allocating more compute to difficult inputs and less to easy ones -- could dramatically improve average efficiency. Early exits [60], mixture-of-depths [61], and conditional computation are promising but underexplored at scale.

### Co-Design of Algorithms and Hardware

The gap between theoretical algorithmic efficiency and practical hardware efficiency remains large. Architectures designed in tandem with hardware -- exploiting specific memory hierarchies, data movement patterns, and compute primitives -- can achieve speedups that purely algorithmic approaches cannot. FlashAttention exemplifies this principle, but systematic co-design methodologies are lacking.

### Unifying Efficient Architectures

The proliferation of efficient architectures (SSMs, linear attention, convolutions, RNNs, hybrids) raises the question: is there a unified framework that encompasses these approaches? Recent work connecting SSMs to attention [50] and linear attention to recurrence [54] suggests convergence, but a comprehensive theoretical framework is missing.

### Efficiency for Multimodal Models

As AI models increasingly process multiple modalities (text, images, video, audio), efficiency challenges multiply. Processing a single video frame as tokens can consume the entire context window of current models. Efficient multimodal architectures that can handle heterogeneous input types without quadratic cost in total token count are urgently needed.

## 3.14 Connections to Other Chapters

**Continual Learning (Chapter 1):** MoE architectures naturally support continual learning by adding new experts for new tasks. Parameter-efficient fine-tuning methods (LoRA, adapters) reduce the cost of adaptation while potentially mitigating forgetting. Efficient architectures enable more frequent model updates, making continual learning more practical.

**World Models (Chapter 2):** World models benefit directly from efficient architectures: SSMs can model long-horizon dynamics with linear cost; efficient attention enables video-based world models with longer temporal context; and MoE can scale world models across diverse domains without proportional compute.

**Agentic Search (Chapter 4):** Efficient inference is critical for agentic systems that perform many model queries during search and planning. Speculative decoding and KV-cache optimization directly impact the cost of tree search and iterative retrieval strategies.

**Randomized Algorithms (Chapter 5):** Many efficient architecture techniques have roots in randomized algorithms: random feature approximations for attention kernels, hashing-based sparse attention (SLIDE), sketching for gradient compression, and random projections for dimensionality reduction in SSMs.

## References

- [1] Kaplan, J., McCandlish, S., Henighan, T., et al. "Scaling Laws for Neural Language Models." arXiv:2001.08361, 2020.
- [2] Hoffmann, J., Borgeaud, S., Mensch, A., et al. "Training Compute-Optimal Large Language Models." NeurIPS, 2022.
- [3] Strubell, E., Ganesh, A., and McCallum, A. "Energy and Policy Considerations for Deep Learning in NLP." ACL, 2019.
- [4] Thompson, N.C., Greenewald, K., Lee, K., and Manso, G.F. "The Computational Limits of Deep Learning." arXiv:2007.05558, 2020.
- [5] Vaswani, A., Shazeer, N., Parmar, N., et al. "Attention Is All You Need." NeurIPS, 2017.
- [6] Child, R., Gray, S., Radford, A., and Sutskever, I. "Generating Long Sequences with Sparse Transformers." arXiv:1904.10509, 2019.
- [7] Zaheer, M., Guruganesh, G., Dubey, K.A., et al. "Big Bird: Transformers for Longer Sequences." NeurIPS, 2020.
- [8] Beltagy, I., Peters, M.E., and Cohan, A. "Longformer: The Long-Document Transformer." arXiv:2004.05150, 2020.
- [9] Katharopoulos, A., Vyas, A., Pappas, N., and Fleuret, F. "Transformers are RNNs: Fast Autoregressive Transformers with Linear Attention." ICML, 2020.
- [10] Keles, F.D., Wiber, P.M., Candan, C., and Cenk, M. "On the Computational Complexity of Self-Attention." ALT, 2023.
- [11] Dao, T., Fu, D.Y., Ermon, S., Rudra, A., and Re, C. "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness." NeurIPS, 2022.
- [12] Dao, T. "FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning." ICLR, 2024.
- [13] Shah, J., Bikshandi, G., Zhang, Y., Thakkar, V., Ramani, P., and Dao, T. "FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision." arXiv:2407.08691, 2024.
- [14] Shazeer, N. "Fast Transformer Decoding: One Write-Head is All You Need." arXiv:1911.02150, 2019.
- [15] Ainslie, J., Lee-Thorp, J., de Jong, M., et al. "GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints." EMNLP, 2023.
- [16] Shazeer, N., Mirhoseini, A., Maziarz, K., et al. "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer." ICLR, 2017.
- [17] Lepikhin, D., Lee, H., Xu, Y., et al. "GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding." ICLR, 2021.
- [18] Fedus, W., Zoph, B., and Shazeer, N. "Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity." JMLR, 2022.
- [19] Zoph, B., Bello, I., Kumar, S., et al. "ST-MoE: Designing Stable and Transferable Sparse Expert Models." arXiv:2202.08906, 2022.
- [20] Jiang, A.Q., Sablayrolles, A., Roux, A., et al. "Mixtral of Experts." arXiv:2401.04088, 2024.
- [21] Dai, D., Deng, C., Zhao, C., et al. "DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models." arXiv:2401.06066, 2024. https://arxiv.org/abs/2401.06066
- [22] Lewis, M., et al. "BASE Layers: Simplifying Training of Large, Sparse Models." ICML, 2021.
- [23] Elsken, T., Metzen, J.H., and Hutter, F. "Neural Architecture Search: A Survey." JMLR, 2019.
- [24] Liu, H., Simonyan, K., and Yang, Y. "DARTS: Differentiable Architecture Search." ICLR, 2019.
- [25] Tan, M. and Le, Q.V. "EfficientNet: Rethinking Model Scaling for Convolutional Neural Networks." ICML, 2019.
- [26] Cai, H., Gan, C., Wang, T., Zhang, Z., and Han, S. "Once-for-All: Train One Network and Specialize it for Efficient Deployment." ICLR, 2020.
- [27] Benmeziane, H., El Maghraoui, K., Ouarnoughi, H., et al. "A Comprehensive Survey on Hardware-Aware Neural Architecture Search." arXiv:2101.09336, 2021.
- [28] Li, C., et al. "Neural Architecture Search Survey: A Hardware Perspective." ACM Computing Surveys, 2022. https://dl.acm.org/doi/fullHtml/10.1145/3524500
- [29] Hinton, G., Vinyals, O., and Dean, J. "Distilling the Knowledge in a Neural Network." NeurIPS Workshop, 2015.
- [30] Sanh, V., Debut, L., Chaumond, J., and Wolf, T. "DistilBERT, a Distilled Version of BERT: Smaller, Faster, Cheaper and Lighter." EMC2 Workshop at NeurIPS, 2019.
- [31] Han, S., Pool, J., Tran, J., and Dally, W.J. "Learning Both Weights and Connections for Efficient Neural Networks." NeurIPS, 2015.
- [32] Frankle, J. and Carlin, M. "The Lottery Ticket Hypothesis: Finding Sparse, Trainable Neural Networks." ICLR, 2019.
- [33] Frantar, E., Ashkboos, S., Hoefler, T., and Alistarh, D. "GPTQ: Accurate Post-Training Quantization for Generative Pre-Trained Transformers." ICLR, 2023.
- [34] Lin, J., Tang, J., Tang, H., et al. "AWQ: Activation-Aware Weight Quantization for On-Device LLM Compression and Acceleration." MLSys, 2024.
- [35] Dettmers, T., Lewis, M., Belkada, Y., and Zettlemoyer, L. "GPT3.int8(): 8-bit Matrix Multiplication for Transformers at Scale." NeurIPS, 2022.
- [36] Micikevicius, P., Narang, S., Alben, J., et al. "Mixed Precision Training." ICLR, 2018.
- [37] Chen, T., Xu, B., Zhang, C., and Guestrin, C. "Training Deep Nets with Sublinear Memory Cost." arXiv:1604.06174, 2016.
- [38] Rajbhandari, S., Rasley, J., Ruwase, O., and He, Y. "ZeRO: Memory Optimizations Toward Training Trillion Parameter Models." SC, 2020.
- [39] Zhao, Y., Gu, A., Varma, R., et al. "PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel." VLDB, 2023.
- [40] Huang, Y., Cheng, Y., Bapna, A., et al. "GPipe: Efficient Training of Giant Neural Networks using Pipeline Parallelism." NeurIPS, 2019.
- [41] Narayanan, D., Shoeybi, M., Casper, J., et al. "Efficient Large-Scale Language Model Training on GPU Clusters Using Megatron-LM." SC, 2021.
- [42] Leviathan, Y., Kalman, M., and Matias, Y. "Fast Inference from Transformers via Speculative Decoding." ICML, 2023.
- [43] Chen, C., Borgeaud, S., Irving, G., et al. "Accelerating Large Language Model Decoding with Speculative Sampling." arXiv:2302.01318, 2023.
- [44] Kwon, W., Li, Z., Zhuang, S., et al. "Efficient Memory Management for Large Language Model Serving with PagedAttention." SOSP, 2023.
- [45] Zhang, Z., Sheng, Y., Zhou, T., et al. "H2O: Heavy-Hitter Oracle for Efficient Generative Inference of Large Language Models." NeurIPS, 2024.
- [46] SpeCache. "Speculative Key-Value Caching for Efficient LLM Inference." ICML, 2025.
- [47] Yu, G.I., Jeong, J.S., Kim, G.W., Kim, S., and Chun, B.G. "Orca: A Distributed Serving System for Transformer-Based Generative Models." OSDI, 2022.
- [48] Gu, A., Goel, K., and Re, C. "Efficiently Modeling Long Sequences with Structured State Spaces." ICLR, 2022.
- [49] Gu, A. and Dao, T. "Mamba: Linear-Time Sequence Modeling with Selective State Spaces." arXiv:2312.00752, 2024.
- [50] Dao, T. and Gu, A. "Transformers are SSMs: Generalized Models and Efficient Algorithms Through Structured State Space Duality." ICML, 2024.
- [51] Lieber, O., Lenz, B., Bata, H., et al. "Jamba: A Hybrid Transformer-Mamba Language Model." arXiv:2403.19887, 2024.
- [52] De, S., Smith, S.L., Fernando, A., et al. "Griffin: Mixing Gated Linear Recurrences with Local Attention for Efficient Language Models." arXiv:2402.19427, 2024.
- [53] Poli, M., Massaroli, S., Nguyen, E., et al. "Hyena Hierarchy: Towards Larger Convolutional Language Models." ICML, 2023.
- [54] Peng, B., Alcaide, E., Anthony, Q., et al. "RWKV: Reinventing RNNs for the Transformer Era." EMNLP Findings, 2023.
- [55] Arora, S., Eyuboglu, S., Zhang, M., et al. "Simple Linear Attention Language Models Balance the Recall-Throughput Tradeoff." ICML, 2024.
- [56] Beck, M., Poppel, K., Spanring, M., et al. "xLSTM: Extended Long Short-Term Memory." NeurIPS, 2024.
- [57] Mattson, P., et al. "MLPerf Training Benchmark." MLSys, 2020.
- [58] Liang, P., Bommasani, R., Lee, T., et al. "Holistic Evaluation of Language Models." TMLR, 2023.
- [59] Tay, Y., Dehghani, M., Abnar, S., et al. "Long Range Arena: A Benchmark for Efficient Transformers." ICLR, 2021.
- [60] Schuster, T., Fisch, A., Gupta, J., et al. "Confident Adaptive Language Modeling." NeurIPS, 2022.
- [61] Raposo, D., Ritter, S., Richards, B., et al. "Mixture-of-Depths: Dynamically Allocating Compute in Transformer-Based Language Models." arXiv:2404.02258, 2024.
