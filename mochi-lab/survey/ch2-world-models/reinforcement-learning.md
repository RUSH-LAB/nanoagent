---
sidebar_position: 9
title: "World Models + Reinforcement Learning"
---

# World Models + Reinforcement Learning

The integration of world models with reinforcement learning is the most mature application of world modeling, with a clear narrative arc from model-based planning to learned dynamics to foundation-scale agents. This section covers the key milestones.

### MuZero: Value-Equivalent World Models

Schrittwieser et al. (2020) [@schrittwieser2020mastering] introduced MuZero (DeepMind), which represents a fundamental rethinking of what world models should predict. Unlike Dreamer-style models that reconstruct observations (pixel-level prediction), MuZero learns a world model that predicts only the quantities relevant to planning: **rewards, value functions, and policy priors**. The model never reconstructs observations -- it operates entirely in an abstract latent space where the only requirement is that the predicted quantities support effective Monte Carlo Tree Search (MCTS).

By combining this learned, value-equivalent dynamics model with MCTS planning, MuZero achieved superhuman performance in Go, chess, shogi, and Atari without being provided the rules of any game. The model learns the "rules" (dynamics) purely from experience, then uses MCTS to search for optimal actions in the learned model. MuZero demonstrated a crucial insight: **world models need not be perceptually accurate -- they only need to be decision-theoretically accurate.** A model that perfectly predicts pixel values but poorly predicts rewards is less useful than one that ignores visual details but accurately predicts task-relevant quantities.

### EfficientZero: Sample-Efficient MuZero

Ye et al. (2021) [@ye2021mastering] proposed EfficientZero, extending MuZero with three key improvements: (1) **self-supervised consistency loss** that ensures the dynamics model produces consistent latent representations regardless of whether they are computed forward (from previous states) or backward (from observations), (2) **value prefix prediction** that predicts multi-step returns, and (3) **observation reconstruction** as an auxiliary training signal. EfficientZero achieved superhuman performance on 26 of 26 Atari games using only 2 hours of real-time game experience (100k environment steps), establishing a new standard for sample efficiency and demonstrating the power of well-designed world models for data-efficient RL.

### IRIS: World Modeling as Sequence Prediction

Micheli et al. (2023) [@micheli2023transformers] introduced IRIS (Imagination with autoRegressive models over an Inner Speech), which makes an elegant conceptual unification: it treats world modeling as autoregressive sequence prediction, using the same transformer architecture that powers language models. IRIS tokenizes observations with VQ-VAE (producing discrete tokens like words in a language) and models environment dynamics autoregressively with a transformer (predicting the next "word" in the environment's "language"). IRIS frames state-action-reward-state sequences as token sequences, achieving competitive Atari 100k performance with a conceptually simple architecture.

IRIS is significant because it demonstrates that world modeling and language modeling are the same computational problem at an abstract level -- both involve predicting the next element in a sequence conditioned on history. This unification opens the door to applying the scaling laws and architectural innovations from NLP to world modeling.

### Model-Based Policy Optimization (MBPO)

Janner et al. (2019) [@janner2019when] proposed MBPO, which addresses a practical question: how to benefit from an imperfect world model without being hurt by its errors. MBPO uses short model rollouts (branching from real states stored in a replay buffer) to augment the replay buffer for model-free RL algorithms (SAC). By keeping rollouts short (typically 1-5 steps), MBPO limits the accumulation of model errors while still gaining substantial sample efficiency improvements.

MBPO provided both practical and theoretical contributions: empirically, it achieved 10-100x sample efficiency improvements over model-free SAC on the MuJoCo benchmark, and theoretically, it provided conditions under which model-based augmentation provably helps (when the model's error is bounded and the rollout horizon is appropriately chosen). The key practical insight -- use the model for short rollouts from real states rather than long imagined trajectories -- has influenced the design of many subsequent methods.

### SimPLe: Simulated Policy Learning

Kaiser et al. (2020) [@kaiser2020model] proposed SimPLe (Simulated Policy Learning), one of the first successful applications of world models to Atari games. SimPLe trains a deterministic video prediction model (pixel-space) from 100k environment steps, then trains a policy entirely within the learned model using PPO. Despite its simplicity, SimPLe demonstrated that even relatively basic pixel-space world models can support effective policy learning when the environment complexity is moderate. SimPLe established the Atari 100k benchmark as the standard testbed for sample-efficient world model methods.

### GenRL: Generative World Models for RL at Scale

Recent work has explored using large-scale generative models (including diffusion models and autoregressive transformers) as world models for RL. The key insight is that the massive improvements in generative model quality (sharper, more coherent, more diverse generations) directly translate into better world model quality, and thus better downstream RL performance. This trend, exemplified by DIAMOND [@alonso2024diffusion] and STORM [@zhang2025storm_wm], suggests that future world model advances may come primarily from generative modeling improvements rather than RL-specific innovations.

### The Dyna Architecture and Its Legacy

All modern world model RL methods can be traced back to the **Dyna architecture** proposed by Sutton (1991) [@sutton1990integrated]. Dyna interleaves real experience with simulated experience generated by a learned model, using both to update the value function and policy. The key components -- learn a model from real experience, generate simulated experience from the model, update the policy from both -- are exactly the three-phase loop used by Dreamer, MuZero, MBPO, and virtually all modern world model RL methods. The evolution from Dyna to DreamerV3 is a story of scaling this basic idea from tabular environments to complex visual environments through advances in deep learning and generative modeling.
