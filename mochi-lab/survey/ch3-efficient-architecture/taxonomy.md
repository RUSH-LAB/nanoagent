---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

## Taxonomy of Approaches

Efficient architecture methods span a broad spectrum of techniques, from fundamental architectural innovations to engineering optimizations. We organize them into the following families, which are not mutually exclusive -- many state-of-the-art systems combine techniques from multiple families:

1. **Efficient attention mechanisms:** Reducing the O(n^2) cost of self-attention through sparse patterns (BigBird [@zaheer2020big], Longformer [@beltagy2020longformer]), linear approximations (Performer [@choromanski2021rethinking], Linear Attention [@katharopoulos2020transformers]), IO-aware implementations (FlashAttention [@dao2022flashattention, @dao2023flashattention2]), and architectural modifications (Multi-Query Attention [@shazeer2019fast], Grouped-Query Attention [@ainslie2023gqa], Differential Attention [@ye2024differential]). These methods preserve the Transformer architecture while making its core operation more efficient.

2. **State space models (SSMs):** Fundamentally different sequence models based on continuous-time dynamical systems (S4 [@gu2022efficiently], Mamba [@gu2024mamba], Mamba-2 [@dao2024mamba2]) that achieve linear complexity in sequence length. SSMs represent the most radical departure from the Transformer paradigm, offering both computational and memory advantages for long sequences. Hybrid architectures that combine SSMs with attention (Jamba [@lieber2024jamba], Zamba [@glorioso2024zamba]) are emerging as a practical synthesis.

3. **Sub-quadratic architectures:** Other alternatives to standard attention, including data-controlled convolutions (Hyena [@poli2023hyena]), linear RNN variants (RWKV [@peng2023rwkv], xLSTM [@beck2024xlstm], Griffin [@de2024griffin]), retention mechanisms (RetNet [@sun2023retentive]), and hybrid designs (BASED [@arora2024based]). These architectures explore the design space between pure attention and pure recurrence, often achieving competitive perplexity on language modeling while enabling O(n) inference.

4. **Mixture of Experts (MoE):** Conditional computation models that activate only a subset of parameters for each input, enabling much larger total model capacity without proportional compute increases (Switch Transformer [@fedus2022switch], Mixtral [@jiang2024mixtral], DeepSeek-MoE [@dai2024deepseekmoe], GShard [@lepikhin2021gshard]). MoE represents the principle of conditional computation -- allocating compute where it is needed.

5. **Parameter-efficient fine-tuning (PEFT):** Methods that adapt large pre-trained models by modifying only a small fraction of parameters (LoRA [@hu2022lora], QLoRA [@dettmers2023qlora], adapters [@houlsby2019parameter], prompt tuning [@lester2021prompt_tuning], DoRA [@liu2024dora], GaLore [@zhao2024galore]). PEFT reduces the cost of customization and enables new deployment patterns (multi-tenant serving with S-LoRA [@sheng2024slora], continual learning).

6. **Neural Architecture Search (NAS):** Automated discovery of efficient architectures through search algorithms (DARTS [@liu2019darts], EfficientNet [@tan2019efficientnet], Once-for-All [@cai2020once], MnasNet [@tan2019mnasnet]). NAS replaces human design intuition with systematic optimization, potentially discovering architectures that human engineers would not consider.

7. **Model compression:** Post-training techniques that reduce model size and compute cost, including knowledge distillation [@hinton2015distilling] (DistilBERT [@sanh2019distilbert]), pruning (SparseGPT [@frantar2023sparsegpt], Wanda [@sun2024wanda], Lottery Ticket Hypothesis [@frankle2019lottery]), and quantization (GPTQ [@frantar2023gptq], AWQ [@lin2024awq], LLM.int8() [@dettmers2022gpt3int8], BitNet b1.58 [@ma2024bitnet158]). Compression techniques are particularly important for deployment on resource-constrained hardware.

8. **Efficient training:** Techniques for reducing the cost of training, including mixed-precision arithmetic [@micikevicius2018mixed], gradient checkpointing [@chen2016training], distributed training strategies (ZeRO [@rajbhandari2020zero], FSDP [@zhao2023pytorch]), tensor parallelism (Megatron-LM [@shoeybi2020megatronlm]), and pipeline parallelism (GPipe [@huang2019gpipe]). These techniques do not change the model architecture but change how it is trained.

9. **Inference optimization:** Techniques for faster and cheaper model serving, including speculative decoding [@leviathan2023fast, @chen2023accelerating], KV-cache management (PagedAttention [@kwon2023efficient]), continuous batching, and serving system design (vLLM, SGLang [@zheng2024sglangradixtree]). These techniques are critical for production deployment.

These families are connected by several cross-cutting principles:

- **Low-rank structure:** Many efficiency gains exploit the fact that the computations and representations in neural networks have low effective rank. LoRA exploits low-rank weight updates; linear attention exploits low-rank attention matrices; pruning exploits sparsity (a form of low-rank structure).
- **Conditional computation:** Rather than applying all computation to all inputs, conditional computation allocates compute based on input difficulty or content. MoE is the most explicit form, but early exit, mixture-of-depths, and adaptive precision are related ideas.
- **Hardware-algorithm co-design:** The most practical efficiency gains often come from designing algorithms that are aware of hardware constraints (memory hierarchy, parallelism, data movement). FlashAttention is the paradigmatic example.
- **Trading one resource for another:** Many techniques trade off between different efficiency dimensions. Gradient checkpointing trades compute for memory; MoE trades parameters for compute; quantization trades precision for speed and memory.
