---
sidebar_position: 12
title: "Connections to Other Chapters"
---

# Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** World models benefit enormously from efficient architectures. State space models (Mamba) can replace transformers for long-horizon dynamics modeling; efficient attention mechanisms reduce the cost of video-based world models; and MoE architectures enable scaling world models to diverse domains without proportional compute increases.

**Agentic Search (Chapter 4):** World models enable agents to "search" through possible futures via planning, directly connecting to Monte Carlo Tree Search approaches discussed in Chapter 4. The combination of world models with tree search (MuZero) and with LLM-based reasoning represents a convergence of world modeling and agentic search.

**Continual Learning (Chapter 1):** World models deployed in changing environments must continually update their dynamics models without forgetting previously learned physics. This is particularly critical in robotics, where a robot's world model must adapt to new objects and environments.

**Randomized Algorithms (Chapter 5):** Random projections and sketching techniques can compress world model representations; spectral methods can analyze the learned dynamics; and randomized planning algorithms (random shooting, CEM) are standard tools for planning with world models.
