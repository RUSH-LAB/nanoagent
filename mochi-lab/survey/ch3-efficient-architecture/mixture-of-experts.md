---
sidebar_position: 5
title: "Mixture of Experts"
---

## Mixture of Experts

Mixture-of-Experts (MoE) models activate only a subset of parameters for each input, enabling much larger total model capacity without proportional compute increases [@shazeer2017outrageously].

### GShard and Sparsely-Gated MoE

Shazeer et al. (2017) [@shazeer2017outrageously] revived the MoE concept for deep learning with the Sparsely-Gated Mixture-of-Experts layer, demonstrating 1000x capacity increases with modest compute overhead. Lepikhin et al. (2021) [@lepikhin2021gshard] scaled this with GShard, training a 600B-parameter MoE model for machine translation across 2048 TPU cores with automatic parallelism.

### Switch Transformer

Fedus et al. (2022) [@fedus2022switch] simplified MoE routing to a Switch layer that routes each token to exactly one expert (top-1 routing). This simplification improved training stability and enabled scaling to trillion-parameter models. Switch Transformers achieved 4-7x pre-training speedups over dense T5 models at equivalent compute budgets.

### ST-MoE

Zoph et al. (2022) [@zoph2022stmoe] conducted a comprehensive study of MoE design choices in ST-MoE (Sparse Transformer with MoE). They identified critical design decisions including router z-loss for training stability, auxiliary load-balancing losses, and the importance of capacity factor tuning. ST-MoE established best practices for MoE training that subsequent work builds upon.

### Mixtral

Jiang et al. (2024) [@jiang2024mixtral] released Mixtral 8x7B, a sparse MoE model that routes each token to 2 of 8 expert FFN modules. Despite having 47B total parameters, Mixtral uses only 13B parameters per forward pass, matching or exceeding Llama 2 70B performance while being 6x faster at inference. Mixtral demonstrated that MoE is viable for open-source deployment, not just research.

### DeepSeek-MoE

Dai et al. (2024) [@dai2024deepseekmoe] introduced DeepSeek-MoE, which uses fine-grained expert segmentation and shared expert isolation. Instead of a few large experts, DeepSeek-MoE uses many small experts (e.g., 64 experts with top-6 routing), with some experts designated as "shared" that process all tokens. This design improves expert specialization and achieves comparable performance to dense models with substantially fewer activated parameters. The DeepSeek-V2 and V3 models extended this approach to multi-hundred-billion parameter scales.

### MoE Challenges

Key challenges in MoE models include: load imbalance (some experts receiving disproportionately many tokens), expert collapse (experts becoming redundant), routing instability during training, and the complexity of distributed training across devices where different experts reside [@fedus2022switch, @zoph2022stmoe, @lewis2021base].
