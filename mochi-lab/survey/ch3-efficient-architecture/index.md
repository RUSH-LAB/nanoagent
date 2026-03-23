---
sidebar_position: 3
title: "Efficient Architecture Design of AI"
---

# Efficient Architecture Design of AI

This chapter provides a comprehensive survey of efficient architecture design for AI systems -- the techniques that enable the same or better performance with fewer FLOPs, less memory, lower latency, or reduced energy consumption. As scaling frontiers push model sizes to trillions of parameters and training costs to hundreds of millions of dollars, efficiency has become a first-class design objective that is as important as raw capability. We cover efficient attention mechanisms (sparse attention, linear attention, FlashAttention, multi-query/grouped-query attention), state space models (S4, Mamba, hybrid architectures), sub-quadratic alternatives to the Transformer (Hyena, RWKV, xLSTM), Mixture-of-Experts models (Switch Transformer, Mixtral, DeepSeek-MoE), parameter-efficient fine-tuning (LoRA, QLoRA, adapters, prompt tuning), neural architecture search (DARTS, EfficientNet, Once-for-All), model compression (distillation, pruning, quantization including the emerging 1-bit frontier), training efficiency (mixed precision, ZeRO/FSDP, 3D parallelism), and inference optimization (speculative decoding, KV-cache management, continuous batching). Throughout, we emphasize the unifying principles -- IO-awareness, conditional computation, low-rank structure, and hardware-algorithm co-design -- that connect these diverse techniques.
