---
sidebar_position: 7.5
title: "Parameter-Efficient Fine-Tuning"
---

## Parameter-Efficient Fine-Tuning

As models grow to billions of parameters, full fine-tuning (updating all parameters for each downstream task) becomes prohibitively expensive in both compute and memory. Parameter-Efficient Fine-Tuning (PEFT) methods modify only a small fraction of the model's parameters (typically 0.01-1%) while keeping the rest frozen, achieving comparable performance to full fine-tuning at a fraction of the cost [@houlsby2019parameter, @hu2022lora].

### Adapters

Houlsby et al. (2019) [@houlsby2019parameter] introduced adapter modules -- small bottleneck layers inserted between the layers of a pre-trained transformer. Each adapter consists of a down-projection, a nonlinearity, and an up-projection (e.g., projecting from hidden dimension 768 to bottleneck dimension 64 and back). During fine-tuning, only the adapter parameters are trained while the original model weights are frozen. Adapters add approximately 3-5% new parameters and achieve within 0.4% of full fine-tuning performance on GLUE, establishing the paradigm of modular, parameter-efficient adaptation.

### LoRA: Low-Rank Adaptation

Hu et al. (2022) [@hu2022lora] proposed LoRA (Low-Rank Adaptation), which represents weight updates as low-rank matrices. Instead of modifying a weight matrix W directly, LoRA adds a low-rank update: W' = W + BA, where B is d x r and A is r x d (with rank r much smaller than d, typically r = 4-16). During fine-tuning, only B and A are trained while W is frozen. At inference, the update BA can be merged into W, adding **zero inference overhead** -- unlike adapters, which add sequential computation.

LoRA's elegance lies in its simplicity, efficiency, and inference-time neutrality. It has become the dominant PEFT method, with extensive adoption across the LLM ecosystem. LoRA typically trains 0.01-0.1% of the original parameters while matching full fine-tuning performance on most tasks.

### QLoRA: Quantized LoRA

Dettmers et al. (2023) [@dettmers2023qlora] proposed QLoRA, which combines LoRA with aggressive quantization of the base model. QLoRA stores the frozen base model in 4-bit NormalFloat precision (NF4), loads it in FP16 for computation, and trains LoRA adapters in FP16. This enables fine-tuning a 65B-parameter model on a single 48GB GPU -- a task that would otherwise require multiple 80GB GPUs. QLoRA introduced NF4 (Normal Float 4-bit), a quantization format specifically designed for normally distributed weights, which achieves better accuracy than standard 4-bit formats. QLoRA demonstrated that the combination of aggressive quantization with parameter-efficient adaptation enables practical fine-tuning of the largest open-source models on consumer hardware.

### DoRA: Weight-Decomposed LoRA

Liu et al. (2024) [@liu2024dora] proposed DoRA, which decomposes the pre-trained weight matrix into magnitude and direction components, then applies LoRA updates only to the direction component. This decomposition, inspired by weight normalization, consistently improves upon standard LoRA across tasks and model sizes. DoRA adds minimal overhead over LoRA (only the magnitude vector m) while closing the gap with full fine-tuning, particularly on tasks where LoRA underperforms.

### GaLore: Gradient Low-Rank Projection

Zhao et al. (2024) [@zhao2024galore] proposed GaLore, which projects the gradient matrix into a low-rank subspace before applying optimizer state updates, reducing the memory required for optimizer states (which often dominate memory usage). Unlike LoRA, which constrains the update to a fixed low-rank subspace throughout training, GaLore periodically recomputes the projection subspace, allowing the optimizer to explore different directions over the course of training. GaLore enables training (not just fine-tuning) LLMs with significantly reduced memory, achieving full-rank training quality with LoRA-like memory efficiency.

### Prompt Tuning and Prefix Tuning

Lester et al. (2021) [@lester2021prompt_tuning] proposed Prompt Tuning, which prepends a small number of learnable "soft prompt" tokens to the input. Only these prompt tokens are trained; the entire model is frozen. Despite training only 0.001% of parameters, prompt tuning approaches full fine-tuning performance as model size increases (closing the gap above 10B parameters). Li and Liang (2021) [@li2021prefix] proposed Prefix Tuning, which prepends learnable vectors to the key and value matrices at every layer (not just the input), providing more expressiveness than input-only prompt tuning.

### PEFT for Continual Learning and Multi-Tenant Serving

PEFT methods have important implications beyond efficiency. For **continual learning** (Chapter 1), LoRA modules can be added for each new task while keeping the backbone frozen, naturally preventing forgetting. For **multi-tenant serving**, a single base model can serve multiple users with different LoRA adapters loaded dynamically, enabling personalized models without storing separate full-size models per user. Systems like S-LoRA [@sheng2024slora] optimize serving with hundreds or thousands of concurrent LoRA adapters.
