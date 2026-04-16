---
sidebar_position: 5
title: "Mixture of Experts"
---

## Mixture of Experts

Mixture-of-Experts (MoE) models embody the principle of **conditional computation**: rather than applying all parameters to every input, they activate only a subset of parameters based on the input, enabling much larger total model capacity without proportional compute increases. This principle is both intuitively appealing (not all knowledge is relevant to every input) and practically powerful (it decouples model capacity from inference cost).

### Historical Foundations

The MoE concept has a long history predating deep learning. Jacobs et al. (1991) [@jacobs1991adaptive] introduced the original Mixture of Experts model, where multiple expert networks specialize on different parts of the input space and a gating network learns to weight their contributions. Jordan and Jacobs (1994) [@jordan1994hierarchical] extended this to Hierarchical Mixture of Experts (HME), introducing tree-structured gating. These early formulations demonstrated the power of specialization and conditional computation but were limited to small-scale problems.

### Modern Sparsely-Gated MoE

**Shazeer et al. (2017)** [@shazeer2017outrageously] revived the MoE concept for deep learning at scale with the Sparsely-Gated Mixture-of-Experts layer. The key innovation was combining MoE with modern deep networks: within each Transformer layer, the standard feed-forward network (FFN) is replaced by a set of expert FFNs, and a learned gating network routes each token to the top-k experts (typically k=2). The gating function uses a softmax with added noise for exploration:

G(x) = softmax(W_g x + epsilon), where epsilon ~ Normal(0, sigma^2)

The output is the weighted sum of the selected experts' outputs, weighted by the gating probabilities. A critical component is the **load balancing loss**, which encourages the gating network to distribute tokens approximately equally across experts, preventing the degenerate solution where all tokens are routed to the same expert. Shazeer et al. demonstrated 1000x capacity increases with modest compute overhead, training models with up to 137 billion parameters.

### GShard and Scaling

**Lepikhin et al. (2021)** [@lepikhin2021gshard] scaled MoE to 600 billion parameters for machine translation using GShard, which introduced key engineering innovations for distributed MoE training: experts are distributed across devices with automatic parallelism, and a capacity factor limits the number of tokens each expert can process (overflowing tokens are dropped or passed through a residual connection). GShard demonstrated that MoE can scale to thousands of TPU cores, achieving state-of-the-art translation quality at a fraction of the training cost of dense models of equivalent quality.

### Switch Transformer

**Fedus et al. (2022)** [@fedus2022switch] simplified MoE routing by routing each token to exactly **one** expert (top-1 routing), rather than the top-2 of Shazeer et al. This simplification has several advantages: it reduces the computational overhead of the gating network, simplifies the communication pattern in distributed training, and improves training stability. Switch Transformers achieved 4-7x pre-training speedups over dense T5 models at equivalent compute budgets, and demonstrated that MoE can be applied to scale models up to the trillion-parameter regime.

The Switch Transformer also introduced important practical insights: (1) bfloat16 precision is critical for MoE training stability (float16 caused training divergence); (2) smaller experts (more experts at a given compute budget) generally outperform fewer larger experts; and (3) the capacity factor (maximum fraction of tokens an expert can receive) is a critical hyperparameter that balances load balance against token dropping.

### ST-MoE: Stable and Transferable MoE

**Zoph et al. (2022)** [@zoph2022stmoe] conducted the most comprehensive study of MoE design choices to date with ST-MoE. Key findings include:

- **Router z-loss:** Adding a penalty proportional to the log of the sum of the router logits stabilizes training by preventing the router from becoming overconfident. This simple regularizer was more effective than alternative stabilization techniques.
- **Auxiliary load-balancing losses:** ST-MoE carefully studied the interaction between different load balancing objectives and found that the combination of router z-loss and a standard load balancing auxiliary loss yields the best training stability and final quality.
- **Capacity factor tuning:** The capacity factor (CF) controls how many tokens each expert can process. CF=1.0 means each expert processes exactly its fair share; CF>1 allows some experts to process more tokens. ST-MoE found that CF=1.25 is a good default, and that dropping tokens (CF<1) is surprisingly tolerable with only modest quality loss.
- **Fine-tuning instability:** MoE models can be unstable during fine-tuning, with router distributions collapsing to send all tokens to a single expert. ST-MoE proposed techniques to stabilize fine-tuning, establishing best practices that subsequent work builds upon.

### Mixtral and Open-Source MoE

**Mixtral 8x7B** (Jiang et al., 2024) [@jiang2024mixtral] brought MoE to the open-source community, demonstrating that sparse MoE is viable for practical deployment, not just research. Mixtral routes each token to 2 of 8 expert FFN modules, with 47B total parameters but only 13B parameters activated per forward pass. Mixtral matched or exceeded Llama 2 70B performance on most benchmarks while being 6x faster at inference. This dramatic efficiency gain demonstrated the practical value of MoE for deployment.

Mixtral also showed that MoE models exhibit interesting specialization patterns: different experts develop different linguistic competencies (syntax vs. semantics, different languages, different domains), suggesting that the routing mechanism discovers meaningful task decompositions without explicit supervision.

### DeepSeek-MoE: Fine-Grained Experts

**DeepSeek-MoE** (Dai et al., 2024) [@dai2024deepseekmoe] introduced two architectural innovations that significantly improved MoE efficiency and quality:

1. **Fine-grained expert segmentation:** Instead of using a few large experts (e.g., 8 experts as in Mixtral), DeepSeek-MoE uses many smaller experts (e.g., 64 experts with top-6 routing). The same compute budget is distributed across more experts, each of which can specialize more narrowly. This produces more precise routing (each token's experts are more specifically relevant) and better utilization (the law of large numbers ensures more uniform load with more experts).

2. **Shared expert isolation:** A subset of experts are designated as "shared" and process all tokens regardless of routing decisions. These shared experts learn representations that are universally useful (e.g., basic language competence), while the routed experts can specialize in domain-specific knowledge. This separation eliminates the need for shared knowledge to be redundantly stored across multiple experts.

DeepSeek-V2 and V3 extended these principles to multi-hundred-billion-parameter scales, achieving frontier model quality at a fraction of the training cost of comparable dense models. DeepSeek-V3 (671B total, 37B active parameters) demonstrated that MoE can compete with the largest dense models while being dramatically more efficient at both training and inference.

### BASE Layers and Expert Choice Routing

**Lewis et al. (2021)** [@lewis2021base] proposed BASE (Balanced Assignment of Sparse Experts), which inverts the standard routing paradigm: instead of each token choosing its experts (token-choice routing), each expert chooses the tokens it wants to process (expert-choice routing). This guarantees perfect load balance by construction, as each expert processes exactly the same number of tokens. The assignment is computed as a linear sum assignment problem, which can be solved efficiently.

**Zhou et al. (2022)** [@zhou2022expert_choice] formalized expert-choice routing and showed that it consistently outperforms token-choice routing with auxiliary load balancing losses, achieving better quality at the same compute budget. Expert-choice routing also naturally enables variable compute per token: some tokens may be selected by many experts (receiving more compute) while others are selected by few (receiving less), providing an implicit form of adaptive computation.

### MoE Training and Serving Challenges

Despite their promise, MoE models present unique challenges:

- **Load imbalance:** Token-choice routing tends to produce uneven expert utilization, with popular experts becoming overloaded while others are underutilized. Load balancing losses help but do not fully solve this problem, and overly aggressive balancing can force tokens to suboptimal experts, hurting quality.
- **Expert collapse:** During training, experts can converge to redundant representations, effectively reducing the number of unique experts. This wastes model capacity and defeats the purpose of MoE.
- **All-to-all communication:** In distributed training, each device typically hosts a subset of experts, and tokens must be routed to their assigned experts across devices. This all-to-all communication pattern can become a bottleneck, particularly at large scales.
- **Memory footprint:** While MoE models have fewer active parameters per forward pass, all expert parameters must be stored in memory, making the total model size much larger than a dense model with the same active compute. This can complicate deployment on memory-constrained hardware.
- **Fine-tuning sensitivity:** MoE models can be unstable during fine-tuning, with routing distributions collapsing [@zoph2022stmoe]. Careful learning rate scheduling and router regularization are needed.
