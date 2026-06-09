---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

## Taxonomy of Approaches

Efficient architecture methods span a broad spectrum of techniques, from fundamental architectural innovations to engineering optimizations. We organize them along two distinct axes. The first axis classifies methods by **model architecture**: the design of the sequence-mixing and parameter-allocation primitives themselves (families 1 through 4). The second axis classifies methods by their position in the **model lifecycle**: how a model is adapted, designed, compressed, trained, or served, largely independent of the underlying architecture (families 5 through 9). These families are not mutually exclusive, and many state-of-the-art systems combine techniques from both axes.

### Axis 1: Architectural families

1. **Efficient attention mechanisms:** Reducing the O(n^2) cost of self-attention through sparse patterns (BigBird [@zaheer2020bigbird], Longformer [@beltagy2020longformer]), linear approximations (Performer [@choromanski2021rethinking], Linear Attention [@katharopoulos2020transformers]), IO-aware implementations (FlashAttention [@dao2022flashattention, @dao2023flashattention2]), and architectural modifications (Multi-Query Attention [@shazeer2019fast], Grouped-Query Attention [@ainslie2023gqa], Differential Attention [@ye2024diff_transformer]). These methods preserve the Transformer architecture while making its core operation more efficient.

2. **State space models (SSMs):** Sequence models derived from a continuous-time state-space parameterization, discretized into a structured linear recurrence (S4 [@gu2022efficiently], Mamba [@gu2024mamba], Mamba-2 [@dao2024transformers]) that achieves linear complexity in sequence length. We use the continuous-time state-space derivation as the demarcation criterion that separates this family from family 3: a model belongs here when its recurrence is obtained by discretizing a continuous dynamical system. SSMs represent the most radical departure from the Transformer paradigm, offering both computational and memory advantages for long sequences. Hybrid architectures that combine SSMs with attention (Jamba [@lieber2024jamba], Zamba [@glorioso2024zamba]) are emerging as a practical synthesis.

3. **Sub-quadratic architectures:** Other alternatives to standard attention whose efficient form does *not* arise from a continuous-time state-space derivation, instead built from discrete gated recurrence or long convolution. This family includes data-controlled convolutions (Hyena [@poli2023hyena]), gated linear RNN variants (RWKV [@peng2023rwkv], xLSTM [@beck2024xlstm], Griffin [@de2024griffin]), retention mechanisms (RetNet [@sun2023retentive]), and hybrid designs (BASED [@arora2024based]). These architectures explore the design space between pure attention and pure recurrence, often achieving competitive perplexity on language modeling while enabling O(n) inference. However, recurrent and sub-quadratic models can struggle with tasks requiring exact copying or in-context retrieval, where standard attention excels. The boundary with family 2 is one of derivation rather than empirical behavior, and several of these models are sometimes described as linear-attention or SSM-adjacent in the literature.

4. **Mixture of Experts (MoE):** Conditional computation models that activate only a subset of parameters for each input, enabling much larger total model capacity without proportional compute increases (Switch Transformer [@fedus2022switch], Mixtral [@jiang2024mixtral], DeepSeek-MoE [@dai2024deepseekmoe], GShard [@lepikhin2021gshard]). MoE represents the principle of conditional computation: allocating compute where it is needed.

### Axis 2: Lifecycle and deployment optimizations

5. **Parameter-efficient fine-tuning (PEFT):** Methods that adapt large pre-trained models by modifying only a small fraction of parameters (LoRA [@hu2022lora], QLoRA [@dettmers2023qlora], adapters [@houlsby2019parameter], prompt tuning [@lester2021prompt_tuning], DoRA [@liu2024dora], GaLore [@zhao2024galore]). PEFT reduces the cost of customization and enables new deployment patterns (multi-tenant serving with S-LoRA [@sheng2024slora], continual learning).

6. **Neural Architecture Search (NAS):** Automated discovery of efficient architectures through search algorithms (DARTS [@liu2019darts], EfficientNet [@tan2019efficientnet], Once-for-All [@cai2020once], MnasNet [@tan2019mnasnet]). NAS replaces human design intuition with systematic optimization, potentially discovering architectures that human engineers would not consider.

7. **Model compression:** Post-training techniques that reduce model size and compute cost, including knowledge distillation [@hinton2015distilling] (DistilBERT [@sanh2019distilbert]), pruning (SparseGPT [@frantar2023sparsegpt], Wanda [@sun2024wanda], Lottery Ticket Hypothesis [@frankle2019lottery]), and quantization (GPTQ [@frantar2023gptq], AWQ [@lin2024awq], LLM.int8() [@dettmers2022gpt3int8], BitNet b1.58 [@ma2024bitnet158]). Compression techniques are particularly important for deployment on resource-constrained hardware.

8. **Efficient training:** Techniques for reducing the cost of training, including mixed-precision arithmetic [@micikevicius2018mixed], gradient checkpointing [@chen2016training], distributed training strategies (ZeRO [@rajbhandari2020zero], FSDP [@zhao2023pytorch]), tensor parallelism (Megatron-LM [@shoeybi2020megatronlm]), and pipeline parallelism (GPipe [@huang2019gpipe]). These techniques do not change the model architecture but change how it is trained.

9. **Inference optimization:** Techniques for faster and cheaper model serving, including speculative decoding [@leviathan2023fast, @chen2023accelerating], KV-cache management (PagedAttention [@kwon2023efficient]), continuous batching (Orca [@yu2022orca]), and serving system design (vLLM [@kwon2023efficient], SGLang [@zheng2024sglang]). These techniques are critical for production deployment.

The table below summarizes the nine families along the axis they belong to, the primary resource each one targets, the central tradeoff it makes, and a representative method.

| Family | Axis | Primary target | Central tradeoff | Representative |
| --- | --- | --- | --- | --- |
| Efficient attention | Architecture | Attention compute/memory (O(n^2)) | Exactness or generality vs. speed | FlashAttention |
| State space models | Architecture | Sequence-length scaling | Architectural novelty vs. ecosystem maturity | Mamba |
| Sub-quadratic architectures | Architecture | Inference cost (O(n)) | Exact retrieval/copying vs. cheaper recurrence | RWKV |
| Mixture of Experts | Architecture | Active compute per token | Total parameters vs. active compute | Mixtral |
| PEFT | Lifecycle | Trainable parameters | Adaptation cost vs. full-model expressiveness | LoRA |
| Neural Architecture Search | Lifecycle | Design effort | Search cost vs. discovered efficiency | DARTS |
| Model compression | Lifecycle | Model size and precision | Accuracy vs. footprint | GPTQ |
| Efficient training | Lifecycle | Training time and memory | Memory or communication vs. compute | ZeRO |
| Inference optimization | Lifecycle | Serving latency and throughput | Memory/scheduling complexity vs. throughput | PagedAttention |

These families are connected by several cross-cutting principles:

- **Low-rank structure:** Many efficiency gains exploit the fact that the computations and representations in neural networks have low effective rank. LoRA exploits low-rank weight updates; linear attention exploits low-rank attention matrices; pruning exploits sparsity (a form of low-rank structure).
- **Conditional computation:** Rather than applying all computation to all inputs, conditional computation allocates compute based on input difficulty or content. MoE is the most explicit form, but early exit, mixture-of-depths, and adaptive precision are related ideas.
- **Hardware-algorithm co-design:** The most practical efficiency gains often come from designing algorithms that are aware of hardware constraints (memory hierarchy, parallelism, data movement). FlashAttention is the paradigmatic example.
- **Trading one resource for another:** Many techniques trade off between different efficiency dimensions. Gradient checkpointing trades compute for memory; MoE trades parameters for compute; quantization trades precision for speed and memory.
