---
sidebar_position: 5
title: "Mixture of Experts"
---

## Mixture of Experts

Mixture-of-Experts (MoE) models embody the principle of **conditional computation**: rather than applying all parameters to every input, they activate only a subset of parameters based on the input, enabling much larger total model capacity without proportional compute increases. This principle is both intuitively appealing (not all knowledge is relevant to every input) and practically powerful (it decouples model capacity from inference cost).

The MoE designs surveyed below differ primarily along three axes, and it is useful to read each system in terms of where it sits on them: (1) **routing strategy**, top-k token-choice (each token picks experts) versus top-1 token-choice versus expert-choice (each expert picks tokens); (2) **expert granularity**, a few large experts versus many small experts at a fixed compute budget; and (3) **shared versus fully-routed experts**, whether some experts process every token to hold universally useful knowledge. The chronological development below maps onto a steady movement along these axes, from top-2 routing with a handful of large experts toward finer granularity, shared experts, and balance-by-construction routing.

### Historical Foundations

The MoE concept has a long history predating deep learning. Jacobs et al. (1991) [@jacobs1991adaptive] introduced the original Mixture of Experts model, where multiple expert networks specialize on different parts of the input space and a gating network learns to weight their contributions. Jordan and Jacobs (1994) [@jordan1994hierarchical] extended this to Hierarchical Mixture of Experts (HME), introducing tree-structured gating. These early formulations demonstrated the power of specialization and conditional computation but were limited to small-scale problems.

### Modern Sparsely-Gated MoE

**Shazeer et al. (2017)** [@shazeer2017outrageously] revived the MoE concept for deep learning at scale with the Sparsely-Gated Mixture-of-Experts layer. The key innovation was combining MoE with modern deep networks: within each Transformer layer, the standard feed-forward network (FFN) is replaced by a set of expert FFNs, and a learned gating network routes each token to the top-k experts (typically k=2). The gating function uses a softmax with added noise for exploration:

G(x) = softmax(W_g x + epsilon), where epsilon ~ Normal(0, sigma^2)

(Note: Shazeer's original formulation used learned per-expert noise scales rather than fixed-variance noise; the above is a simplified presentation.)

The output is the weighted sum of the selected experts' outputs, weighted by the gating probabilities. A critical component is the **load balancing loss**, which encourages the gating network to distribute tokens approximately equally across experts, preventing the degenerate solution where all tokens are routed to the same expert. Shazeer et al. demonstrated 1000x capacity increases with modest compute overhead, training models with up to 137 billion parameters.

### GShard and Scaling

**Lepikhin et al. (2021)** [@lepikhin2021gshard] scaled MoE to 600 billion parameters for machine translation using GShard, which introduced key engineering innovations for distributed MoE training: experts are distributed across devices with automatic parallelism, and a capacity factor limits the number of tokens each expert can process (overflowing tokens are dropped or passed through a residual connection). GShard demonstrated that MoE can scale to thousands of TPU cores, achieving state-of-the-art translation quality at a fraction of the training cost of dense models of equivalent quality.

Along the comparative axes below, GShard inherits Shazeer's top-k token-choice routing but contributes the distributed-systems machinery (sharded experts, capacity-factor token dropping) that makes the routing strategy tractable at scale; the routing decision itself is unchanged, so the gains come from infrastructure rather than a new routing or granularity choice. The capacity-factor mechanism is itself a limitation: when an expert exceeds its capacity, the overflow tokens are dropped and receive no expert computation, so a tight capacity factor trades quality for memory predictability.

### Switch Transformer

**Fedus et al. (2022)** [@fedus2022switch] simplified MoE routing by routing each token to exactly **one** expert (top-1 routing), rather than the top-2 of Shazeer et al. This simplification has several advantages: it reduces the computational overhead of the gating network, simplifies the communication pattern in distributed training, and improves training stability. Switch Transformers achieved 4-7x pre-training speedups over dense T5 models at equivalent compute budgets, and demonstrated that MoE can be applied to scale models up to the trillion-parameter regime.

The Switch Transformer also introduced important practical insights: (1) bfloat16 precision is critical for MoE training stability (float16 caused training divergence); (2) smaller experts (more experts at a given compute budget) generally outperform fewer larger experts; and (3) the capacity factor (maximum fraction of tokens an expert can receive) is a critical hyperparameter that balances load balance against token dropping.

On the routing axis, Switch is the minimal endpoint: top-1 token-choice trades the redundancy of Shazeer's top-2 routing for lower gating and communication cost, while its empirical preference for many small experts foreshadows the fine-grained granularity that DeepSeek-MoE later pushes much further. The flip side of top-1 routing is reduced routing robustness: with only a single expert per token, a single bad routing decision has no second expert to compensate, which is part of why later systems often retain top-2 or higher.

### ST-MoE: Stable and Transferable MoE

**Zoph et al. (2022)** [@zoph2022stmoe] conducted the most comprehensive study of MoE design choices to date with ST-MoE. Key findings include:

- **Router z-loss:** Adding a penalty proportional to the log of the sum of the router logits stabilizes training by preventing the router from becoming overconfident. This simple regularizer was more effective than alternative stabilization techniques.
- **Auxiliary load-balancing losses:** ST-MoE carefully studied the interaction between different load balancing objectives and found that the combination of router z-loss and a standard load balancing auxiliary loss yields the best training stability and final quality.
- **Capacity factor tuning:** The capacity factor (CF) controls how many tokens each expert can process. CF=1.0 means each expert processes exactly its fair share; CF>1 allows some experts to process more tokens. ST-MoE found that CF=1.25 is a good default, and that dropping tokens (CF<1) is surprisingly tolerable with only modest quality loss.
- **Fine-tuning instability:** MoE models can be unstable during fine-tuning, with router distributions collapsing to send all tokens to a single expert. ST-MoE proposed techniques to stabilize fine-tuning, establishing best practices that subsequent work builds upon.

ST-MoE does not move along the routing or granularity axes; it keeps top-k token-choice and instead hardens it, contributing the regularizers (router z-loss plus a tuned auxiliary balancing loss) that make every later token-choice system trainable. Its lasting comparative role is to define the stability baseline that expert-choice routing would later try to sidestep by eliminating the balancing loss entirely.

### Mixtral and Open-Source MoE

**Mixtral 8x7B** (Jiang et al., 2024) [@jiang2024mixtral] brought MoE to the open-source community, demonstrating that sparse MoE is viable for practical deployment, not just research. Mixtral routes each token to 2 of 8 expert FFN modules, with 47B total parameters but only 13B parameters activated per forward pass. Mixtral matched or exceeded Llama 2 70B performance on most benchmarks while being 6x faster at inference. This dramatic efficiency gain demonstrated the practical value of MoE for deployment. However, the 47B total memory footprint can complicate deployment on memory-constrained hardware despite the 13B active compute.

Mixtral also showed that MoE models exhibit interesting specialization patterns: different experts develop different linguistic competencies (syntax vs. semantics, different languages, different domains), suggesting that the routing mechanism discovers meaningful task decompositions without explicit supervision.

Comparatively, Mixtral occupies the coarse-granularity, fully-routed corner of the design space: top-2 token-choice over only 8 large experts and no shared expert. That makes it the natural baseline against which DeepSeek-MoE's two changes (many small experts plus a shared expert) are best read, since the two systems differ on the granularity and shared-expert axes while holding the token-choice routing strategy fixed.

Mixtral was quickly followed by other open MoE releases that explored the granularity axis. DBRX [@databricks2024dbrx] uses 16 experts with top-4 routing (132B total, 36B active), and its developers explicitly frame it as fine-grained relative to Mixtral's 8-expert, top-2 design. The Qwen2 family [@yang2024qwen2] released a fine-grained MoE variant (Qwen2-57B-A14B, roughly 57B total and 14B active) that combines many routed experts with shared experts, echoing the DeepSeek-MoE recipe. Together these confirm the field's drift toward finer granularity rather than overturning the Mixtral-versus-DeepSeek contrast above.

### DeepSeek-MoE: Fine-Grained Experts

**DeepSeek-MoE** (Dai et al., 2024) [@dai2024deepseekmoe] introduced two architectural innovations that significantly improved MoE efficiency and quality:

1. **Fine-grained expert segmentation:** Instead of using a few large experts (e.g., 8 experts as in Mixtral), DeepSeek-MoE uses many smaller routed experts (e.g., 64 routed experts with top-6 routing). The same compute budget is distributed across more experts, each of which can specialize more narrowly. This produces more precise routing (each token's experts are more specifically relevant) and better utilization (the law of large numbers ensures more uniform load with more experts).

2. **Shared expert isolation:** A subset of experts are designated as "shared" and process all tokens regardless of routing decisions (for instance, DeepSeekMoE-16B uses 64 routed experts plus 2 always-active shared experts). These shared experts learn representations that are universally useful (e.g., basic language competence), while the routed experts can specialize in domain-specific knowledge. This separation eliminates the need for shared knowledge to be redundantly stored across multiple experts.

DeepSeek-V2 [@deepseek2024deepseekv2] and V3 [@deepseek2024deepseekv3] extended these principles to multi-hundred-billion-parameter scales, achieving frontier model quality at a fraction of the training cost of comparable dense models. DeepSeek-V3 (671B total, 37B active parameters) [@deepseek2024deepseekv3] demonstrated that MoE can compete with the largest dense models while being dramatically more efficient at both training and inference.

DeepSeek-V3 also advanced the load-balancing axis with an **auxiliary-loss-free load balancing** strategy [@deepseek2024deepseekv3]: rather than adding a balancing penalty to the training loss (the approach used by Switch Transformer and ST-MoE), it maintains a per-expert bias term that is added to the routing scores and adjusted dynamically to even out expert load, leaving the language-modeling objective free of an auxiliary gradient. This directly addresses the tension noted in the Challenges section, where a balancing loss that is strong enough to equalize load can force tokens onto suboptimal experts and hurt quality. The cost of fine-grained experts is a more demanding all-to-all communication and routing pattern: many small experts mean more routing decisions and finer-grained token dispatch, so the approach depends on the distributed-systems machinery introduced by GShard to remain efficient.

### BASE Layers and Expert Choice Routing

**Lewis et al. (2021)** [@lewis2021base] proposed BASE (Balanced Assignment of Sparse Experts), which inverts the standard routing paradigm: instead of each token choosing its experts (token-choice routing), each expert chooses the tokens it wants to process (expert-choice routing). This guarantees perfect load balance by construction, as each expert processes exactly the same number of tokens. The assignment is computed as a linear sum assignment problem, which can be solved efficiently.

**Zhou et al. (2022)** [@zhou2022expert_choice] formalized expert-choice routing and showed that it consistently outperforms token-choice routing with auxiliary load balancing losses, achieving better quality at the same compute budget. Expert-choice routing also naturally enables variable compute per token: some tokens may be selected by many experts (receiving more compute) while others are selected by few (receiving less), providing an implicit form of adaptive computation. The trade-off is that expert-choice routing is awkward for autoregressive inference: because experts select tokens across a batch, a token's routing depends on the other tokens present, which breaks the per-token independence that left-to-right decoding assumes and complicates use as a drop-in decoder.

### Comparing the MoE Family

The table below places the major systems on the three design axes introduced earlier. Entries are drawn from the figures stated in each system's subsection above; cells marked "n/a" indicate the work's contribution is a routing or balancing mechanism rather than a specific released model, so a fixed parameter count does not apply.

| System | Routing strategy | Experts / top-k | Granularity | Shared experts | Total / active params |
|---|---|---|---|---|---|
| Shazeer et al. [@shazeer2017outrageously] | Top-k token-choice (k=2) | many / k=2 | many small | no | up to 137B / sparse |
| GShard [@lepikhin2021gshard] | Top-k token-choice | many / k=2 | many small | no | up to 600B / sparse |
| Switch [@fedus2022switch] | Top-1 token-choice | many / k=1 | many small | no | up to ~1T / sparse |
| ST-MoE [@zoph2022stmoe] | Top-k token-choice + z-loss | configurable | configurable | no | n/a (design study) |
| Mixtral 8x7B [@jiang2024mixtral] | Top-k token-choice (k=2) | 8 / k=2 | few large | no | 47B / 13B |
| DBRX [@databricks2024dbrx] | Top-k token-choice (k=4) | 16 / k=4 | many small | no | 132B / 36B |
| Qwen2-57B-A14B [@yang2024qwen2] | Top-k token-choice | many / k>1 | many small | yes | 57B / 14B |
| DeepSeek-MoE [@dai2024deepseekmoe] | Top-k token-choice (k=6) | 64 / k=6 | many small | yes | n/a (architecture) |
| DeepSeek-V3 [@deepseek2024deepseekv3] | Top-k token-choice, aux-loss-free | many / k>1 | many small | yes | 671B / 37B |
| BASE [@lewis2021base] | Expert-choice (assignment) | n/a | n/a | no | n/a (routing method) |
| Expert Choice [@zhou2022expert_choice] | Expert-choice | n/a | n/a | no | n/a (routing method) |

Read across the rows, the trajectory is clear: token-choice routing thins from top-2 to top-1 for efficiency (Switch) before granularity becomes the main lever (DeepSeek-MoE's 64 small experts plus a shared expert), while a parallel line of work (BASE, Expert Choice) abandons token-choice altogether to get load balance by construction rather than by an auxiliary loss.

### MoE Training and Serving Challenges

Despite their promise, MoE models present unique challenges:

- **Load imbalance:** Token-choice routing tends to produce uneven expert utilization, with popular experts becoming overloaded while others are underutilized. Load balancing losses help but do not fully solve this problem, and overly aggressive balancing can force tokens to suboptimal experts, hurting quality. Two newer directions sidestep the loss entirely: expert-choice routing balances load by construction [@zhou2022expert_choice], and DeepSeek-V3's auxiliary-loss-free strategy [@deepseek2024deepseekv3] adjusts a per-expert routing bias instead of adding a balancing gradient.
- **Expert collapse:** During training, experts can converge to redundant representations, effectively reducing the number of unique experts. This wastes model capacity and defeats the purpose of MoE.
- **All-to-all communication:** In distributed training, each device typically hosts a subset of experts, and tokens must be routed to their assigned experts across devices. This all-to-all communication pattern can become a bottleneck, particularly at large scales.
- **Memory footprint:** While MoE models have fewer active parameters per forward pass, all expert parameters must be stored in memory, making the total model size much larger than a dense model with the same active compute. This can complicate deployment on memory-constrained hardware.
- **Fine-tuning sensitivity:** MoE models can be unstable during fine-tuning, with routing distributions collapsing [@zoph2022stmoe]. Careful learning rate scheduling and router regularization are needed.
