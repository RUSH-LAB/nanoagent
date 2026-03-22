---
sidebar_position: 2
title: "Problem Formulation"
---

# Problem Formulation

### Dynamics Modeling

A world model is fundamentally a dynamics model that predicts future states given current states and actions. In the general formulation, we seek to learn a transition function:

s_{t+1} = f_theta(s_t, a_t)

where s_t is the state at time t, a_t is the action, and f_theta is a parameterized model. In practice, the "state" may be raw observations (e.g., pixel images), learned latent representations, or structured symbolic states.

### Key Components

A complete world model system typically consists of [@hafner2019learning, @hafner2020dream]:

1. **Encoder:** Maps raw observations o_t to latent states s_t = enc(o_t).
2. **Transition model:** Predicts latent state transitions s_{t+1} = trans(s_t, a_t).
3. **Observation model (decoder):** Reconstructs observations from latent states o_t = dec(s_t).
4. **Reward model:** Predicts rewards r_t = rew(s_t, a_t) for reinforcement learning applications.

### Latent vs. Pixel-Space Models

A central design choice is whether to predict future states in observation space (pixel-space models) or in a learned latent space (latent-space models) [@lecun2022path]. Pixel-space models must capture every visual detail, which is computationally expensive and often unnecessary for decision-making. Latent-space models learn compressed representations that retain task-relevant information while discarding irrelevant details, enabling more efficient planning and learning.

### Planning with World Models

Given a learned dynamics model, an agent can plan by simulating trajectories and selecting the action sequence that maximizes expected cumulative reward [@hafner2019learning, @sutton1990integrated]:

a_{1:H}^* = argmax_{a_{1:H}} sum_{t=1}^{H} gamma^t * E[r_t | s_t, a_t]

Planning methods range from simple shooting (sampling random action sequences), to cross-entropy method (CEM), to tree search (MCTS), to gradient-based trajectory optimization.
