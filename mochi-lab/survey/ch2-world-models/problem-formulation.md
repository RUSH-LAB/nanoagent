---
sidebar_position: 2
title: "Problem Formulation"
---

# Problem Formulation

### Dynamics Modeling

A world model is fundamentally a dynamics model that predicts future states given current states and actions. In the general formulation, we seek to learn a transition function:

s_{t+1} = f_theta(s_t, a_t)

where s_t is the state at time t, a_t is the action, and f_theta is a parameterized model. In practice, the "state" may be raw observations (e.g., pixel images), learned latent representations, or structured symbolic states. The quality of the learned dynamics directly determines the quality of plans derived from the model: a more accurate dynamics model enables longer planning horizons and more reliable decision-making.

When the environment is partially observable (the agent cannot see the full state), the world model must maintain a belief over possible states. This leads to the formulation as a Partially Observable Markov Decision Process (POMDP), where the world model learns:

- **Observation model:** p(o_t | s_t) -- the relationship between hidden states and observations
- **Transition model:** p(s_{t+1} | s_t, a_t) -- how the hidden state evolves
- **Reward model:** p(r_t | s_t, a_t) -- what rewards are expected

The Dreamer family addresses partial observability through the RSSM (Recurrent State-Space Model), which maintains a belief state combining deterministic memory (RNN hidden state) with a stochastic component.

### Key Components

A complete world model system typically consists of [@hafner2019learning, @hafner2020dream]:

1. **Encoder:** Maps raw observations o_t to latent states s_t = enc(o_t). In the RSSM framework, the encoder produces the posterior distribution q(s_t | h_t, o_t), where h_t is the deterministic state. The posterior is used during training to ground the latent state in actual observations.

2. **Transition model (prior):** Predicts latent state transitions without seeing the observation: p(s_t | h_t), where h_t = f(h_{t-1}, s_{t-1}, a_{t-1}). This is the component used during imagination (planning), as future observations are unavailable. The difference between the prior and posterior is measured by the KL divergence and drives the model to learn predictive representations.

3. **Observation model (decoder):** Reconstructs observations from latent states o_t = dec(s_t, h_t). The decoder provides the learning signal that ensures the latent space captures visually relevant information. However, as MuZero demonstrated, the decoder is not strictly necessary -- world models can learn useful representations without observation reconstruction.

4. **Reward model:** Predicts rewards r_t = rew(s_t, h_t, a_t) for reinforcement learning applications. In combination with the transition model, the reward model enables evaluating the expected return of imagined trajectories.

5. **Continuation model (optional):** Predicts episode termination probability, enabling the model to imagine trajectories that end at appropriate points rather than continuing indefinitely.

### Latent vs. Pixel-Space Models

A central design choice is whether to predict future states in observation space (pixel-space models) or in a learned latent space (latent-space models) [@lecun2022path]. This choice has profound implications:

**Pixel-space models** (SimPLe, DIAMOND, GameNGen) predict full observations at each step. Advantages include: easy evaluation (compare predicted and actual frames), no information loss (the model captures everything visible), and compatibility with powerful generative architectures (diffusion, autoregressive). Disadvantages include: computational expense (generating high-resolution frames at each planning step), wasted capacity on task-irrelevant details (exact textures, lighting variations), and difficulty with multi-step planning (errors in pixel prediction compound rapidly).

**Latent-space models** (Dreamer, MuZero, TD-MPC) learn compressed representations that retain task-relevant information while discarding irrelevant details. Advantages include: computational efficiency (planning in a compact space), natural handling of partial observability (the latent state can integrate information over time), and the ability to learn abstract, task-relevant representations. Disadvantages include: the risk of discarding task-relevant information during encoding, difficulty in evaluating prediction quality (latent predictions are not directly interpretable), and the challenge of ensuring the latent space has good geometric properties for planning.

The JEPA perspective [@lecun2022path] argues strongly for latent-space prediction, proposing that world models should predict in an abstract representation space where irrelevant details are explicitly removed. V-JEPA [@bardes2024vjepa] implements this vision, demonstrating that predicting in representation space (without pixel reconstruction) produces efficient and effective world models for video understanding.

### Planning with World Models

Given a learned dynamics model, an agent can plan by simulating trajectories and selecting the action sequence that maximizes expected cumulative reward [@hafner2019learning, @sutton1990integrated]:

a_{1:H}^* = argmax_{a_{1:H}} sum_{t=1}^{H} gamma^t * E[r_t | s_t, a_t]

Planning methods range in sophistication:

- **Random shooting:** Sample many random action sequences, evaluate each through the model, and select the best. Simple but effective for short horizons and low-dimensional action spaces.
- **Cross-Entropy Method (CEM):** An iterative refinement of random shooting that maintains a distribution over action sequences, samples from it, evaluates the samples, and fits the distribution to the top performers. Used in PlaNet [@hafner2019learning] and many subsequent methods.
- **Model Predictive Path Integral (MPPI):** A sampling-based method that weights trajectories by their exponential advantage, providing a soft version of CEM. Used in TD-MPC [@hansen2022temporal].
- **Monte Carlo Tree Search (MCTS):** Builds a search tree by simulating trajectories, evaluating leaf nodes, and backpropagating values. Used in MuZero [@schrittwieser2020mastering] for game-playing.
- **Gradient-based optimization:** Backpropagates through the differentiable dynamics model to optimize actions directly via gradient descent. Used in Dreamer for policy learning (backpropagating through imagined trajectories to optimize the actor).
- **Learned policies (amortized planning):** Rather than planning from scratch at each step, learn a policy network that amortizes the planning computation. Dreamer's actor-critic approach and MuZero's learned prior both represent amortized planning.

The choice of planning method involves a fundamental tradeoff between planning quality (more computation yields better decisions) and planning speed (decisions must be made in real time for interactive applications). MuZero uses hundreds of MCTS simulations per decision, enabling superhuman play but at significant computational cost. Dreamer uses a learned policy (zero simulation cost at decision time) but pays the cost during training.

### The Fidelity-Utility Tradeoff

A fundamental tension in world model design is between **model fidelity** (how accurately the model reproduces the true dynamics) and **model utility** (how useful the model is for downstream tasks). These are not the same: a model that perfectly predicts every pixel but runs too slowly for planning is less useful than a fast, approximate model that captures task-relevant dynamics. MuZero crystallized this insight: its world model predicts rewards and values but not observations, achieving superhuman performance without visual fidelity. This suggests that the right objective for a world model depends on its intended use: reconstruction-based training for open-ended simulation, value-based training for decision-making, and feature-based training for representation learning.
