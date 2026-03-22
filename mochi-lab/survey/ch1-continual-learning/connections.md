---
sidebar_position: 11
title: "Connections to Other Chapters"
---

# Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** Architecture-based continual learning methods are closely related to efficient architecture design. Mixture-of-Experts models, modular networks, and parameter-efficient fine-tuning all serve dual purposes: enabling efficient inference and facilitating continual learning. The sparse activation patterns in MoE models naturally reduce interference between tasks.

**World Models (Chapter 2):** Continual learning is essential for world models that must adapt to changing environments. A robot's world model must update as it encounters new objects, environments, or physical interactions, making catastrophic forgetting a practical concern for model-based reinforcement learning.

**Agentic Search (Chapter 4):** Agents that interact with evolving knowledge bases must continually update their retrieval and reasoning capabilities. Continual learning of retrieval models and knowledge integration in RAG systems connects to the challenge of maintaining search quality as information changes.

**Randomized Algorithms (Chapter 5):** Sketching and hashing techniques from Chapter 5 can be applied to continual learning: compressed replay buffers, random projections for efficient importance estimation, and streaming algorithms for online learning are all relevant connections.
