---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

## Taxonomy of Approaches

Efficient architecture methods span a broad spectrum of techniques, from fundamental architectural innovations to engineering optimizations. We organize them into the following families, which are not mutually exclusive -- many state-of-the-art systems combine techniques from multiple families:

1. **Efficient attention mechanisms:** Reducing the O(n^2) cost of self-attention through sparse patterns (BigBird, Longformer), linear approximations (Linear Attention), IO-aware implementations (FlashAttention), and architectural modifications (Multi-Query/Grouped-Query Attention, Differential Attention). These methods preserve the Transformer architecture while making its core operation more efficient.

2. **State space models (SSMs):** Fundamentally different sequence models based on continuous-time dynamical systems (S4, Mamba) that achieve linear complexity in sequence length. SSMs represent the most radical departure from the Transformer paradigm, offering both computational and memory advantages for long sequences. Hybrid architectures that combine SSMs with attention are emerging as a practical synthesis.

3. **Sub-quadratic architectures:** Other alternatives to standard attention, including data-controlled convolutions (Hyena), linear RNN variants (RWKV, xLSTM), and hybrid designs (BASED). These architectures explore the design space between pure attention and pure recurrence.

4. **Mixture of Experts (MoE):** Conditional computation models that activate only a subset of parameters for each input, enabling much larger total model capacity without proportional compute increases (Switch Transformer, Mixtral, DeepSeek-MoE). MoE represents the principle of conditional computation -- allocating compute where it is needed.

5. **Parameter-efficient fine-tuning (PEFT):** Methods that adapt large pre-trained models by modifying only a small fraction of parameters (LoRA, QLoRA, adapters, prompt tuning). PEFT reduces the cost of customization and enables new deployment patterns (multi-tenant serving, continual learning).

6. **Neural Architecture Search (NAS):** Automated discovery of efficient architectures through search algorithms (DARTS, EfficientNet, Once-for-All). NAS replaces human design intuition with systematic optimization, potentially discovering architectures that human engineers would not consider.

7. **Model compression:** Post-training techniques that reduce model size and compute cost, including knowledge distillation (training smaller models to mimic larger ones), pruning (removing unnecessary parameters), and quantization (reducing numerical precision). Compression techniques are particularly important for deployment on resource-constrained hardware.

8. **Efficient training:** Techniques for reducing the cost of training, including mixed-precision arithmetic, gradient checkpointing, distributed training strategies (ZeRO, FSDP), and pipeline parallelism. These techniques do not change the model architecture but change how it is trained.

9. **Inference optimization:** Techniques for faster and cheaper model serving, including speculative decoding, KV-cache management, continuous batching, and serving system design. These techniques are critical for production deployment.

These families are connected by several cross-cutting principles:

- **Low-rank structure:** Many efficiency gains exploit the fact that the computations and representations in neural networks have low effective rank. LoRA exploits low-rank weight updates; linear attention exploits low-rank attention matrices; pruning exploits sparsity (a form of low-rank structure).
- **Conditional computation:** Rather than applying all computation to all inputs, conditional computation allocates compute based on input difficulty or content. MoE is the most explicit form, but early exit, mixture-of-depths, and adaptive precision are related ideas.
- **Hardware-algorithm co-design:** The most practical efficiency gains often come from designing algorithms that are aware of hardware constraints (memory hierarchy, parallelism, data movement). FlashAttention is the paradigmatic example.
- **Trading one resource for another:** Many techniques trade off between different efficiency dimensions. Gradient checkpointing trades compute for memory; MoE trades parameters for compute; quantization trades precision for speed and memory.
