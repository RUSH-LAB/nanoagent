---
sidebar_position: 9
title: "World Models + Reinforcement Learning"
---

# World Models + Reinforcement Learning

### MuZero

Schrittwieser et al. (2020) [@schrittwieser2020mastering] introduced MuZero (DeepMind), which learns a world model that predicts only the quantities relevant to planning (rewards, value functions, and policy) rather than reconstructing observations. By combining learned dynamics with Monte Carlo Tree Search (MCTS), MuZero achieved superhuman performance in Go, chess, shogi, and Atari without being provided the rules of the game. MuZero demonstrated that world models need not be "accurate" in a perceptual sense -- they only need to support effective planning.

### EfficientZero

Ye et al. (2021) [@ye2021mastering] proposed EfficientZero, extending MuZero with self-supervised consistency loss, value prefix prediction, and observation reconstruction. EfficientZero achieved superhuman performance on Atari using only 2 hours of real-time game experience (100k environment steps), establishing a new standard for sample efficiency.

### IRIS

Micheli et al. (2023) [@micheli2023transformers] introduced IRIS (Imagination with autoRegressive models over an Inner Speech), which tokenizes observations with VQ-VAE and models environment dynamics autoregressively with a transformer. IRIS frames world modeling as sequence prediction, achieving competitive Atari 100k performance with a conceptually simple architecture that leverages the power of autoregressive transformers.

### Model-Based Policy Optimization (MBPO)

Janner et al. (2019) [@janner2019when] proposed MBPO, which uses short model rollouts (branching from real states) to augment the replay buffer for model-free RL algorithms. MBPO demonstrated that even imperfect world models can substantially improve sample efficiency when used carefully, and provided theoretical analysis of when model-based augmentation helps versus hurts.
