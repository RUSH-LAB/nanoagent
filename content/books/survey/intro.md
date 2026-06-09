---
sidebar_position: 0
title: "Frontiers of AI: A Comprehensive Survey"
---

# Frontiers of AI: A Comprehensive Survey

**A survey of five frontier research areas in artificial intelligence, covering continual learning, world models, efficient architecture design, agentic search, and the intersection of randomized algorithms with deep learning.**

**Scope.** These five areas were selected because they concern how AI systems learn over time, model their environment, scale efficiently, seek information autonomously, and draw on classical algorithmic foundations. They span learning dynamics (continual learning, world models), systems and efficiency (architecture design), interactive capability (agentic search), and theoretical grounding (randomized algorithms and signal processing). The survey deliberately leaves out several large, well-covered areas that warrant their own dedicated treatments, including generative modeling (diffusion and autoregressive image and audio generation), RLHF and alignment, and large-scale multimodal pretraining. The goal is depth across a coherent set of frontiers rather than exhaustive breadth across all of contemporary AI.

---

## Table of Contents

### [Continual Learning of AI](ch1-continual-learning/)

How can neural networks learn continuously from non-stationary data streams without catastrophically forgetting previously acquired knowledge? This chapter surveys the four major families of continual learning methods: regularization-based (EWC, SI, LwF), replay-based (experience replay, GEM, generative replay), architecture-based (progressive networks, PackNet, SupSup), and meta-learning-based (OML, ANML, La-MAML), along with the emerging challenge of continual learning in large language models. The chapter spans roughly three decades of research.

### [World Models](ch2-world-models/)

World models endow AI agents with the ability to simulate their environment internally, enabling planning, imagination, and sample-efficient learning. This chapter traces the evolution from Ha and Schmidhuber's foundational work through the Dreamer series, modern video prediction models, and foundation-scale world models like Genie and GameNGen. We cover applications in robotics (TD-MPC), reasoning (Dynalang, LLM-as-world-model), and reinforcement learning (MuZero, EfficientZero).

### [Efficient Architecture Design of AI](ch3-efficient-architecture/)

As the computational cost of training and deploying AI models grows unsustainably, efficiency has become a first-class design objective. This chapter provides a comprehensive survey of efficient attention mechanisms (FlashAttention, sparse attention, GQA), Mixture-of-Experts models (Switch Transformer, Mixtral, DeepSeek-MoE), neural architecture search, model compression (GPTQ, AWQ, distillation, pruning), training efficiency (ZeRO, FSDP, mixed precision), inference optimization (speculative decoding, KV-cache compression), and the rapidly evolving family of state space models (S4, Mamba, Jamba, Griffin).

### [Agentic Search](ch4-agentic-search/)

Agentic search represents a paradigm shift from static retrieval to autonomous, multi-step information seeking driven by LLM-based agents. This chapter surveys tool-augmented retrieval (WebGPT, ReAct, Toolformer), retrieval-augmented generation (RAG, RETRO, Self-RAG), multi-hop reasoning search (IRCoT, FLARE), autonomous web agents (WebArena, BrowserGym), search with planning (Tree-of-Thought, LATS, AlphaProof), and self-improving search and AI-powered search engines (STORM).

### [Randomized Algorithms, Data Structures & Signal Processing Perspectives of AI](ch5-randomized-signal/)

Many of deep learning's most effective techniques are rooted in classical randomized algorithms and signal processing theory. This chapter bridges these fields, covering random projections (Johnson-Lindenstrauss, random features), hashing for ML (LSH, SLIDE), sketching and streaming (CountSketch for gradient compression), Fourier and spectral perspectives (Fourier features, FNet, spectral bias), wavelet and multi-resolution analysis (scattering networks, WaveMix), the signal processing view of Transformers (attention as filtering, positional encoding as frequency), and randomized linear algebra (randomized SVD, Nystrom approximation).

---

## How to Read This Survey

This survey is designed to be read either linearly (chapters build conceptual momentum) or selectively (each chapter is self-contained). Cross-chapter connections are highlighted in a dedicated section at the end of each chapter.

**Key cross-chapter themes:**

- **Efficiency pervades everything.** Chapter 3 (Efficient Architecture Design) provides the foundational techniques, but efficiency considerations appear in every chapter: continual learning avoids expensive retraining (Ch1), world models reduce sample complexity (Ch2), agentic search optimizes for query cost (Ch4), and randomized algorithms provide sub-linear approximations (Ch5).

- **The representation question.** What should an AI system represent, and how? Continual learning asks how to maintain representations over time (Ch1). World models learn representations of dynamics (Ch2). Efficient architectures determine how representations are computed (Ch3). Signal processing theory analyzes what representations capture in the frequency domain (Ch5).

- **Search and planning connect everything.** Agentic search (Ch4) explicitly addresses information seeking, but search appears throughout: planning with world models is search through imagined futures (Ch2), MCTS guides both game-playing and code generation (Ch4), and architecture search finds efficient designs (Ch3).

- **Classical meets learned.** Chapter 5 is the most explicit bridge between classical algorithms and deep learning, but the theme recurs: synaptic consolidation from neuroscience inspires EWC (Ch1), control theory underlies state space models (Ch3), and information retrieval theory grounds RAG systems (Ch4).

**Suggested reading paths:**

- *For ML practitioners focused on deployment:* Ch3 (Efficient Architecture) -> Ch1 (Continual Learning) -> Ch4 (Agentic Search)
- *For researchers in model-based RL:* Ch2 (World Models) -> Ch3 (Efficient Architecture) -> Ch1 (Continual Learning)
- *For theoretically-inclined readers:* Ch5 (Randomized/Signal Processing) -> Ch3 (Efficient Architecture) -> Ch2 (World Models)
- *For those building AI agents:* Ch4 (Agentic Search) -> Ch2 (World Models) -> Ch3 (Efficient Architecture)
