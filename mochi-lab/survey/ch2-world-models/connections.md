---
sidebar_position: 12
title: "Connections to Other Chapters"
---

# Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** World models benefit enormously from and motivate advances in efficient architectures. The connections operate at multiple levels:

- *State space models for dynamics:* Mamba and S4 (Chapter 3) can replace transformer-based dynamics models, offering linear-time sequence processing for long-horizon prediction. The connection is natural: SSMs are continuous-time dynamical systems, and world models learn discrete-time dynamical systems -- the mathematical frameworks are closely related. SSM-based world models could enable much longer planning horizons by eliminating the quadratic cost of attention over long temporal sequences.
- *Efficient attention for video world models:* Video-based world models (DIAMOND, GameNGen, Sora) process sequences of video frames, where the number of tokens (frames x patches) can be enormous. FlashAttention, sparse attention, and Ring Attention (Chapter 3) are essential for training and serving these models at practical speeds.
- *MoE for multi-domain world models:* Foundation world models that simulate diverse environments (different physics, different visual styles, different action spaces) can use MoE architectures (Chapter 3) to scale model capacity without proportional compute increases, routing different environment types to specialized experts.
- *Quantization for real-time inference:* World models used for real-time planning (robotics, driving) must generate predictions faster than real-time. Quantization and efficient inference techniques from Chapter 3 enable deploying world models on edge devices and achieving the latency requirements of real-time control.

**Agentic Search (Chapter 4):** World models and agentic search are deeply connected through the principle of model-based planning -- using an internal model to evaluate candidate actions before committing.

- *Planning as search:* World model-based planning (CEM, MPPI, MCTS in MuZero) is fundamentally a search problem: searching through the space of possible action sequences for one that maximizes expected reward. This directly connects to the tree search methods in Chapter 4 (Tree-of-Thought, LATS, AlphaProof), which search through reasoning paths using the LLM as a "world model" that predicts the consequences of reasoning steps.
- *LLM reasoning as internal simulation:* Chain-of-thought reasoning in LLMs can be viewed as step-by-step simulation using an implicit world model, connecting the reasoning capabilities discussed in Chapter 4 to the world model framework. The LLM-as-world-model hypothesis (Section 2.8) makes this connection explicit.
- *World models of information landscapes:* An agentic search system implicitly builds a "world model" of the information landscape -- understanding what information exists, where it is located, and what queries will retrieve it. The dynamics model predicts what search results will be returned given a query, analogous to how a robotics world model predicts what observations will result from an action.

**Continual Learning (Chapter 1):** World models deployed in changing environments face the classic continual learning challenge:

- *Adapting dynamics:* A robot's world model must update as it encounters new objects, new environments, or changes in physical properties (e.g., a floor becoming slippery). This requires the world model to learn new dynamics without forgetting previously learned physics -- exactly the stability-plasticity tradeoff at the heart of continual learning.
- *Replay-based world model updates:* Experience replay methods from Chapter 1 are directly used in world model RL (Dreamer stores and replays past experiences for world model training). The replay buffer management strategies (reservoir sampling, gradient-based selection) determine how effectively the world model retains knowledge of rare but important environment dynamics.
- *Model merging for multi-environment world models:* Task arithmetic and model merging techniques from Chapter 1 could enable combining world models trained in different environments into a single multi-environment model, analogous to merging LLMs fine-tuned on different tasks.

**Randomized Algorithms (Chapter 5):** Randomized methods are essential tools in the world model toolbox:

- *Random projections for state compression:* World model latent states can be compressed using random projections (JL lemma) while preserving the dynamical properties needed for planning. This is particularly relevant for MuZero-style models where the latent space need not be interpretable.
- *Spectral analysis of learned dynamics:* The eigenspectrum of the learned transition model reveals the timescales and modes of the dynamics, connecting to the spectral analysis tools in Chapter 5. Modes with large eigenvalues correspond to slow dynamics (persistent features); small eigenvalues correspond to fast dynamics (transient features).
- *Randomized planning:* The Cross-Entropy Method (CEM), random shooting, and MPPI all generate random action sequences and select the best, directly using Monte Carlo sampling as a planning algorithm. These randomized planning methods are standard tools in world model-based control.
- *Streaming algorithms for online world model learning:* Online world model updates (in the DayDreamer setting, where data arrives continuously from a physical robot) can use streaming algorithms from Chapter 5 for efficient incremental updates.
- *Fourier analysis of temporal dynamics:* The frequency spectrum of world model predictions can be analyzed using the tools from Chapter 5, revealing whether the model captures high-frequency dynamics (rapid state changes) or primarily learns low-frequency trends. The spectral bias phenomenon (learning low frequencies first) may affect what aspects of dynamics world models learn first during training.
