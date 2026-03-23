---
sidebar_position: 1
title: "Introduction & Motivation"
---

## Introduction & Motivation

The scaling paradigm that has driven the deep learning revolution -- larger models, more data, more compute -- is approaching fundamental limits. Training frontier language models now costs tens of millions of dollars, consumes megawatt-hours of electricity, and requires months on thousands of accelerators [@kaplan2020scaling, @hoffmann2022training]. GPT-4 is estimated to have cost over $100 million to train; subsequent frontier models are projected to exceed $1 billion [@epoch2023trends]. Inference costs scale with user demand, and for widely deployed models the aggregate inference cost can dwarf training cost within months of deployment. The environmental impact of this trajectory is increasingly scrutinized: Strubell et al. (2019) [@strubell2019energy] estimated that training a single large NLP model produces carbon emissions comparable to five cars over their lifetimes, and the situation has only intensified as model sizes have grown by orders of magnitude since.

Efficiency in AI architecture design has thus become a first-class objective, no longer a secondary concern to be addressed after accuracy is maximized. The goal is to achieve the same or better performance with fewer FLOPs, less memory, lower latency, or reduced energy consumption. This is not merely an engineering challenge -- it is a fundamental research question about the nature of computation in neural networks. The observation that most neural network parameters are redundant (networks can be pruned by 90%+ with minimal accuracy loss [@han2015learning, @frankle2019lottery]) suggests that our architectures are profoundly inefficient in how they use parameters and compute. Understanding and eliminating this inefficiency is both practically urgent and scientifically important.

The field has been transformed by several converging forces:

1. **The compute wall.** Moore's Law has slowed dramatically, with transistor density improvements decelerating from the historical 2x every 18 months to roughly 2x every 3-4 years. Meanwhile, model compute requirements have grown by 10x annually [@sevilla2022compute]. This divergence means that architectural efficiency gains are increasingly the primary lever for continued capability growth.

2. **The memory wall.** Memory bandwidth, not compute, is often the bottleneck in modern AI systems. Transformer inference is memory-bandwidth-bound during autoregressive generation, where each token requires reading the full model weights and the growing KV-cache from memory. This has motivated architectural innovations (multi-query attention, KV-cache compression) and systems innovations (PagedAttention, speculative decoding) that specifically target memory efficiency.

3. **The deployment imperative.** As AI systems move from research labs to production deployment -- powering search engines, coding assistants, autonomous vehicles, and medical diagnostics -- the cost of inference per query becomes a binding economic constraint. A model that is 2x more efficient at inference can serve twice as many users at the same cost, or the same users at half the cost. This has driven intense focus on inference optimization techniques.

4. **The democratization goal.** The concentration of frontier AI capability in a handful of well-funded organizations has motivated work on making capable models accessible to broader communities. Quantization techniques like GPTQ and GGML have enabled running billion-parameter models on consumer hardware. Parameter-efficient fine-tuning methods like LoRA and QLoRA have enabled customizing large models on single GPUs. These democratization-driven innovations have become some of the most impactful efficiency advances.

5. **The long-context frontier.** Applications requiring very long contexts (entire codebases, full books, long videos) push against the quadratic cost of standard attention. The need for million-token context windows has driven architectural innovations from sub-quadratic attention mechanisms to state space models to hybrid architectures.

This chapter surveys the landscape of efficient architecture design, organized by technique family. We cover efficient attention mechanisms and sub-quadratic alternatives to the Transformer, state space models, Mixture-of-Experts, parameter-efficient fine-tuning, neural architecture search, model compression, training efficiency, and inference optimization. Throughout, we emphasize not just the techniques themselves but the underlying principles -- IO-awareness, conditional computation, low-rank structure, and hardware-algorithm co-design -- that connect seemingly disparate approaches into a coherent framework for efficient AI.
