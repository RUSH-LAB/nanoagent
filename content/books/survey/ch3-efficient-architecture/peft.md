---
sidebar_position: 7.5
title: "Parameter-Efficient Fine-Tuning"
---

## Parameter-Efficient Fine-Tuning

As models grow to billions of parameters, full fine-tuning (updating all parameters for each downstream task) becomes prohibitively expensive in both compute and memory. Parameter-Efficient Fine-Tuning (PEFT) methods modify only a small fraction of the model's parameters (typically 0.01-1%) while keeping the rest frozen, achieving comparable performance to full fine-tuning at a fraction of the cost [@houlsby2019parameter, @hu2022lora]. This section covers the dominant PEFT families (LoRA and its quantized/decomposed variants, Adapters, and Prompt/Prefix Tuning) and their applications to continual learning and multi-tenant serving; specialized methods such as AdaLoRA, (IA)³, BitFit, and LoRA+ are omitted for brevity.

We organize PEFT methods along three axes defined by *where* the trainable parameters live. **Reparameterization methods** (LoRA, QLoRA, DoRA, GaLore) leave the network's forward structure unchanged and instead express the update to existing weights (or their gradients) in a low-rank form; their tradeoff is between training-time memory savings and how faithfully a low-rank update can approximate full fine-tuning. **Additive-module methods** (Adapters) insert new trainable submodules into the network; they are highly modular but pay a sequential inference cost. **Input and activation steering methods** (Prompt Tuning, Prefix Tuning) leave all model weights frozen and instead learn continuous vectors that condition the model; they are the cheapest to store but the least expressive, and they shrink the usable context window. The sections below treat each family in turn, naming its principle, flagship methods, and characteristic tradeoff, and close with a comparative synthesis.

### Additive Modules

The additive-module family inserts new trainable submodules into a frozen backbone. Its principle is locality: adaptation is confined to small, swappable components, which makes it modular at the cost of extra forward-pass computation.

#### Adapters

Houlsby et al. (2019) [@houlsby2019parameter] introduced adapter modules: small bottleneck layers inserted within each transformer layer, after the attention and feed-forward sub-layers. Each adapter consists of a down-projection, a nonlinearity, and an up-projection (e.g., projecting from hidden dimension 768 to bottleneck dimension 64 and back). During fine-tuning, only the adapter parameters are trained while the original model weights are frozen. Adapters add approximately 3.6% new parameters and achieve within 0.4% of full fine-tuning performance on GLUE (the General Language Understanding Evaluation benchmark, covering tasks such as sentiment analysis, question answering, and textual entailment), establishing the paradigm of modular, parameter-efficient adaptation. Adapters win when modularity matters more than latency (e.g., maintaining many task-specific modules), but lose to LoRA whenever inference-time neutrality is required, since their inserted layers add sequential computation that cannot be merged away.

### Reparameterization Methods

The reparameterization family leaves the network's forward structure unchanged and instead expresses the update to existing weights, or to their gradients, in a low-rank form. Its principle is to constrain the *update* rather than the architecture, which preserves inference-time behavior while shrinking what must be trained or stored.

#### LoRA: Low-Rank Adaptation

Hu et al. (2022) [@hu2022lora] proposed LoRA (Low-Rank Adaptation), which represents weight updates as low-rank matrices. Instead of modifying a weight matrix W directly, LoRA adds a low-rank update: W' = W + BA, where B is d x r and A is r x d (with rank r much smaller than d, typically r = 4-16). During fine-tuning, only B and A are trained while W is frozen. At inference, the update BA can be merged into W, adding **zero inference overhead**, in contrast to adapters, which add sequential computation.

LoRA's elegance lies in its simplicity, efficiency, and inference-time neutrality. It has become the dominant PEFT method, with extensive adoption across the LLM ecosystem. LoRA typically trains 0.01-0.1% of the original parameters while matching full fine-tuning performance on most tasks.

#### QLoRA: Quantized LoRA

Dettmers et al. (2023) [@dettmers2023qlora] proposed QLoRA, which combines LoRA with aggressive quantization of the base model. QLoRA stores the frozen base model in 4-bit NormalFloat precision (NF4), loads it in BFloat16 (BF16) for computation, and trains LoRA adapters in BFloat16 (BF16). This enables fine-tuning a 65B-parameter model on a single 48GB GPU, a task that would otherwise require multiple 80GB GPUs. QLoRA introduced NF4 (Normal Float 4-bit), a quantization format specifically designed for normally distributed weights, which achieves better accuracy than standard 4-bit formats. QLoRA demonstrated that the combination of aggressive quantization with parameter-efficient adaptation enables practical fine-tuning of the largest open-source models on consumer hardware. QLoRA wins precisely when the base model is too large to fit alongside its own gradients, trading a small accuracy cost from quantization for a large reduction in resident memory; it offers no advantage over plain LoRA once the model already fits comfortably.

#### DoRA: Weight-Decomposed LoRA

Liu et al. (2024) [@liu2024dora] proposed DoRA, which decomposes the pre-trained weight matrix into magnitude and direction components, then applies LoRA updates only to the direction component. This decomposition, inspired by weight normalization, consistently improves upon standard LoRA across tasks and model sizes. DoRA adds minimal overhead over LoRA (only the magnitude vector m) while closing the gap with full fine-tuning, particularly on tasks where LoRA underperforms. DoRA is the method of choice when LoRA leaves accuracy on the table on harder tasks; when plain LoRA already matches full fine-tuning, its extra magnitude parameter buys little.

#### GaLore: Gradient Low-Rank Projection

Zhao et al. (2024) [@zhao2024galore] proposed GaLore, which projects the gradient matrix into a low-rank subspace before applying optimizer state updates, reducing the memory required for optimizer states (which often dominate memory usage). Unlike LoRA, which constrains the update to a fixed low-rank subspace throughout training, GaLore periodically recomputes the projection subspace, allowing the optimizer to explore different directions over the course of training. GaLore enables training (not just fine-tuning) LLMs with significantly reduced memory, achieving full-rank training quality with LoRA-like memory efficiency. GaLore wins where the goal is from-scratch (or full-rank) pretraining under a tight memory budget, since it preserves full-rank update capacity that LoRA forgoes; for adapting an already-pretrained model to a downstream task, LoRA's cheaper, mergeable updates are usually preferable.

### Input and Activation Steering

The steering family freezes all model weights and instead learns continuous vectors that condition the model through its inputs or internal activations. Its principle is to adapt behavior without touching parameters at all, which yields the smallest storage footprint but the least expressiveness.

#### Prompt Tuning and Prefix Tuning

Lester et al. (2021) [@lester2021prompt_tuning] proposed Prompt Tuning, which prepends a small number of learnable "soft prompt" tokens to the input. Only these prompt tokens are trained; the entire model is frozen. Despite training only 0.001% of parameters, prompt tuning approaches full fine-tuning performance as model size increases (closing the gap above 10B parameters). Li and Liang (2021) [@li2021prefix] proposed Prefix Tuning, which prepends learnable vectors to the key and value matrices at every layer (not just the input), providing more expressiveness than input-only prompt tuning. These methods win at very large model scale and when a single base model must store thousands of tiny per-task prompts, but they lose to LoRA at smaller scales and on harder tasks, where their limited expressiveness and consumption of context-window length make them less effective.

### Comparative Analysis

The families above trade off three quantities that cannot be maximized simultaneously: training-time memory reduction, inference-time neutrality, and expressiveness. The table below contrasts them on these dimensions.

| Family / Method | Trainable params | Inference overhead | Memory savings | When it wins |
|---|---|---|---|---|
| Additive: Adapters | ~3.6% | Added (sequential layers) | Optimizer/gradient memory only on adapter params | Modularity across many tasks; latency not critical |
| Reparam: LoRA | ~0.01-0.1% | None (mergeable) | Optimizer/gradient memory only on low-rank factors | General default for adapting pretrained models |
| Reparam: QLoRA | ~0.01-0.1% | None (mergeable) | Large: base stored in 4-bit | Base model too large to fit with gradients |
| Reparam: DoRA | ~LoRA + magnitude vector | None (mergeable) | ~LoRA | Tasks where LoRA underperforms full fine-tuning |
| Reparam: GaLore | Full-rank weights | None | Large: low-rank optimizer states | From-scratch / full-rank training under memory limits |
| Steering: Prompt/Prefix | ~0.001-0.1% | Added (longer sequence) | Stores only vectors per task | Very large scale; thousands of tiny per-task adaptations |

The central tension is that the property a method optimizes is the property the others sacrifice. LoRA and its descendants prize inference-time neutrality (the update merges back into the weights), which forces the update into a low-rank form and so caps expressiveness; DoRA buys back some of that expressiveness, and QLoRA trades a little of it for dramatic resident-memory savings. GaLore moves the constraint from the weights to the gradients, recovering full-rank expressiveness for training at the cost of a non-mergeable optimization procedure. Adapters and steering methods abandon inference-time neutrality entirely (adapters add layers, prompts add tokens) in exchange for modularity or near-zero storage. In practice LoRA is the default for adapting pretrained models, QLoRA is the answer when the model will not otherwise fit, DoRA the upgrade when LoRA underperforms, GaLore the choice for memory-bound full-rank training, and prompt/prefix tuning the option when scale is large and per-task footprint must be minimal.

### PEFT for Continual Learning and Multi-Tenant Serving

PEFT methods have important implications beyond efficiency. For **continual learning** (Chapter 1), LoRA modules can be added for each new task while keeping the backbone frozen, naturally preventing forgetting. For **multi-tenant serving**, a single base model can serve multiple users with different LoRA adapters loaded dynamically, enabling personalized models without storing separate full-size models per user. Systems like S-LoRA [@sheng2024slora] optimize serving with hundreds or thousands of concurrent LoRA adapters.
