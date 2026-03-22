# Chapter 2: World Models

## 2.1 Introduction & Motivation

The concept of a world model -- an internal representation of how the environment works -- lies at the heart of intelligent behavior. Humans do not interact with the world purely through trial and error; instead, we simulate potential actions and their consequences in our minds before committing to a decision. This capacity for mental simulation, or "model-based" reasoning, is what allows us to plan, generalize, and adapt efficiently to novel situations [1, 2].

In artificial intelligence, world models formalize this idea: an agent learns a predictive model of its environment's dynamics, enabling it to plan and make decisions by "imagining" the outcomes of potential actions without executing them in the real world [3, 4]. The seminal work of Ha and Schmidhuber (2018) [3] crystallized the modern vision of world models for deep learning, demonstrating that a compact latent-space model of environment dynamics could support effective policy learning in a "dream" environment.

The field has expanded dramatically since then. World models now span applications from game playing to robotics, from video generation to reasoning. Three key drivers have propelled this expansion. First, the computational cost of model-free reinforcement learning -- which requires millions of real-world interactions -- has made sample-efficient, model-based approaches increasingly attractive. Second, advances in generative modeling (VAEs, GANs, diffusion models, autoregressive transformers) have enabled much higher-fidelity world simulations. Third, the rise of foundation models has raised the tantalizing possibility of universal world models that generalize across domains.

This chapter reviews the evolution of world models from classical approaches through modern foundation-scale systems. We organize the literature by application domain and architectural paradigm, covering pixel-space and latent-space models, video prediction, foundation world models, robotics applications, reasoning, and the intersection with reinforcement learning.

## 2.2 Problem Formulation

### Dynamics Modeling

A world model is fundamentally a dynamics model that predicts future states given current states and actions. In the general formulation, we seek to learn a transition function:

s_{t+1} = f_theta(s_t, a_t)

where s_t is the state at time t, a_t is the action, and f_theta is a parameterized model. In practice, the "state" may be raw observations (e.g., pixel images), learned latent representations, or structured symbolic states.

### Key Components

A complete world model system typically consists of [4, 5]:

1. **Encoder:** Maps raw observations o_t to latent states s_t = enc(o_t).
2. **Transition model:** Predicts latent state transitions s_{t+1} = trans(s_t, a_t).
3. **Observation model (decoder):** Reconstructs observations from latent states o_t = dec(s_t).
4. **Reward model:** Predicts rewards r_t = rew(s_t, a_t) for reinforcement learning applications.

### Latent vs. Pixel-Space Models

A central design choice is whether to predict future states in observation space (pixel-space models) or in a learned latent space (latent-space models) [6]. Pixel-space models must capture every visual detail, which is computationally expensive and often unnecessary for decision-making. Latent-space models learn compressed representations that retain task-relevant information while discarding irrelevant details, enabling more efficient planning and learning.

### Planning with World Models

Given a learned dynamics model, an agent can plan by simulating trajectories and selecting the action sequence that maximizes expected cumulative reward [4, 7]:

a_{1:H}^* = argmax_{a_{1:H}} sum_{t=1}^{H} gamma^t * E[r_t | s_t, a_t]

Planning methods range from simple shooting (sampling random action sequences), to cross-entropy method (CEM), to tree search (MCTS), to gradient-based trajectory optimization.

## 2.3 Taxonomy of Approaches

World models can be organized along several dimensions:

**By prediction space:**
- Pixel-space models: predict raw observations directly
- Latent-space models: predict in learned abstract state spaces
- Hybrid models: combine latent prediction with selective pixel decoding

**By generative paradigm:**
- Deterministic models: single-point predictions
- Stochastic models: distributions over future states (e.g., VAE-based)
- Autoregressive models: sequential token/patch prediction (GPT-style)
- Diffusion-based models: iterative denoising for prediction

**By application domain:**
- Game playing and Atari
- Continuous control and robotics
- Video generation and prediction
- Reasoning and language-grounded dynamics

## 2.4 Classic World Models

### 2.4.1 World Models (Ha & Schmidhuber, 2018)

The foundational work by Ha and Schmidhuber [3] introduced the modern world model paradigm. Their architecture consists of three components: a Variational Autoencoder (VAE) that compresses observations into a latent space, a Mixture Density Network-RNN (MDN-RNN) that models the dynamics in latent space, and a compact controller that operates on the latent representation. The agent is trained entirely in "dreams" -- rollouts generated by the learned model -- enabling rapid policy learning with minimal real-world interaction. They demonstrated this on the VizDoom and CarRacing environments.

### 2.4.2 PlaNet

Hafner et al. (2019) [4] introduced PlaNet (Deep Planning Network), which learns a latent dynamics model and plans online using the Cross-Entropy Method (CEM). PlaNet introduced the Recurrent State-Space Model (RSSM), which combines deterministic and stochastic state components to capture both predictable dynamics and environmental uncertainty. PlaNet achieved competitive performance on continuous control tasks from image observations using far fewer environment interactions than model-free methods.

### 2.4.3 Dreamer (v1, v2, v3)

The Dreamer series by Hafner et al. represents the most successful line of latent world model research:

**Dreamer v1 (2020)** [5] extended PlaNet by learning a policy and value function within the imagined latent trajectories, using backpropagation through the dynamics model. This "imagination-based" policy learning proved more efficient than CEM planning.

**Dreamer v2 (2021)** [8] introduced discrete latent representations using categorical variables, which improved stability and performance. It was the first model-based agent to achieve human-level performance on the Atari 100k benchmark.

**Dreamer v3 (2023)** [9] achieved a major milestone: a single, fixed set of hyperparameters that masters diverse domains including continuous control, Atari games, Minecraft (crafting a diamond), and DMLab navigation. Key innovations include symlog predictions (handling reward scales across orders of magnitude), free bits for KL balancing, and improved discrete world model representations. DreamerV3 demonstrated that world models can generalize across fundamentally different domain types without domain-specific tuning.

## 2.5 Video Prediction Models

Video prediction models learn to generate future video frames conditioned on past frames and optionally actions, forming a closely related class of world models.

### 2.5.1 Stochastic Video Generation (SVG)

Denton and Fergus (2018) [10] proposed SVG, which uses a VAE framework with learned prior to generate stochastic video predictions. By sampling different latent codes, the model can generate diverse plausible futures, addressing the fundamental multimodality of video prediction.

### 2.5.2 FitVid

Babaeizadeh et al. (2021) [11] introduced FitVid, which systematically studied the design space of video prediction architectures. They found that careful architecture choices (deep encoders, skip connections, large latent spaces) matter more than algorithmic novelty, achieving state-of-the-art video prediction quality.

### 2.5.3 VideoGPT and Autoregressive Approaches

Yan et al. (2021) [12] proposed VideoGPT, which tokenizes video using VQ-VAE and then models the resulting discrete tokens autoregressively with a GPT-like transformer. This approach leverages the success of autoregressive language models for video generation.

More recently, iVideoGPT (Wu et al., 2024) [13] extended this paradigm to interactive world models, where the autoregressive video model is conditioned on actions to generate interactive environment simulations. They showed that scaling VideoGPT-style models creates increasingly capable world simulators.

### 2.5.4 Video Diffusion Models

Diffusion-based video generation has emerged as a powerful paradigm. Ho et al. (2022) [14] demonstrated Video Diffusion Models that generate temporally coherent video through iterative denoising. MCVD (Voleti et al., 2022) [15] introduced Masked Conditional Video Diffusion for flexible video prediction, interpolation, and generation. These models produce higher visual fidelity than VAE-based approaches but at significantly higher computational cost.

## 2.6 Foundation World Models

A transformative recent trend is the development of large-scale, general-purpose world models trained on broad data.

### 2.6.1 Genie (Google DeepMind)

Genie (Bruce et al., 2024) [16] introduced the concept of generative interactive environments. Trained on internet videos of 2D platformer games, Genie learns a latent action space from unlabeled video, enabling controllable generation of interactive environments from a single image. Genie introduced the Spatiotemporal Transformer (ST-Transformer) architecture for efficient video tokenization and dynamics modeling. The Genie family has since expanded to Genie 2 and Genie 3, which generate photorealistic 3D interactive worlds from text or image prompts [17].

### 2.6.2 UniSim

Yang et al. (2023) [18] proposed UniSim, a universal simulator that learns to simulate diverse real-world interactions from video data. UniSim can generate plausible video predictions conditioned on various action types (robotic actions, human actions, text descriptions), positioning it as a step toward universal world models that support multiple downstream applications.

### 2.6.3 DIAMOND

Alonso et al. (2024) [19] introduced DIAMOND (DIffusion As a Model Of eNvironment Dreams), which uses diffusion models as world models for reinforcement learning. By generating high-fidelity environment simulations through iterative denoising, DIAMOND achieves state-of-the-art performance on the Atari 100k benchmark among world model approaches, surpassing Dreamer v3 on several games. DIAMOND demonstrates that the sample quality of diffusion models translates into better downstream RL performance.

### 2.6.4 GameNGen

Valevski et al. (2024) [20] introduced GameNGen, which uses a fine-tuned diffusion model to simulate the game DOOM in real-time. GameNGen generates each frame conditioned on the previous frames and player actions, achieving playable quality at 20+ FPS. This work demonstrated that diffusion models can serve as neural game engines, potentially replacing traditional game rendering pipelines.

## 2.7 World Models for Robotics

### 2.7.1 TD-MPC and TD-MPC2

Hansen et al. (2022, 2024) [21, 22] developed TD-MPC (Temporal Difference Learning for Model Predictive Control), which combines learned latent dynamics models with temporal difference learning for model-predictive control. TD-MPC2 scaled this approach to a single world model capable of controlling 80+ diverse robotic tasks across different embodiments and action spaces, demonstrating the generalization potential of world models for robotics.

### 2.7.2 FOWM (Foundation World Models for Robotics)

Foundation-scale world models for robotics aim to learn general-purpose physics simulators from video data that can transfer to specific robotic tasks. Recent work has shown that large video prediction models pre-trained on diverse data can be fine-tuned for specific robotic manipulation tasks with limited demonstrations [23].

### 2.7.3 RoboDreamer

RoboDreamer (2024) [24] combines world models with language-conditioned planning for robotics. By learning to imagine the outcomes of language-described actions, the model enables robots to plan complex manipulation sequences specified in natural language.

## 2.8 World Models for Reasoning

### 2.8.1 LLM-as-World-Model

An emerging perspective treats large language models themselves as world models that have implicitly learned dynamics of the world through text prediction [25, 26]. LLMs can simulate physical processes, predict action outcomes, and reason about counterfactuals to a surprising degree. WorldGPT (Ge et al., 2024) [27] explicitly frames LLMs as multimodal world models, integrating visual and textual information for environment simulation.

### 2.8.2 Dynalang

Lin et al. (2024) [28] proposed Dynalang, which learns to model the world with language. By integrating language annotations into a Dreamer-style world model, Dynalang can ground language understanding in environment dynamics. The model learns to use language for predicting future states and for planning, creating a tighter loop between language comprehension and world understanding.

### 2.8.3 Language-Grounded World Models

More broadly, there is growing interest in world models that operate on or are conditioned by structured language descriptions rather than (or in addition to) raw sensory inputs [29]. These models can leverage the compositional structure of language to generalize to novel situations described in natural language.

## 2.9 World Models + Reinforcement Learning

### 2.9.1 MuZero

Schrittwieser et al. (2020) [30] introduced MuZero (DeepMind), which learns a world model that predicts only the quantities relevant to planning (rewards, value functions, and policy) rather than reconstructing observations. By combining learned dynamics with Monte Carlo Tree Search (MCTS), MuZero achieved superhuman performance in Go, chess, shogi, and Atari without being provided the rules of the game. MuZero demonstrated that world models need not be "accurate" in a perceptual sense -- they only need to support effective planning.

### 2.9.2 EfficientZero

Ye et al. (2021) [31] proposed EfficientZero, extending MuZero with self-supervised consistency loss, value prefix prediction, and observation reconstruction. EfficientZero achieved superhuman performance on Atari using only 2 hours of real-time game experience (100k environment steps), establishing a new standard for sample efficiency.

### 2.9.3 IRIS

Micheli et al. (2023) [32] introduced IRIS (Imagination with autoRegressive models over an Inner Speech), which tokenizes observations with VQ-VAE and models environment dynamics autoregressively with a transformer. IRIS frames world modeling as sequence prediction, achieving competitive Atari 100k performance with a conceptually simple architecture that leverages the power of autoregressive transformers.

### 2.9.4 Model-Based Policy Optimization (MBPO)

Janner et al. (2019) [33] proposed MBPO, which uses short model rollouts (branching from real states) to augment the replay buffer for model-free RL algorithms. MBPO demonstrated that even imperfect world models can substantially improve sample efficiency when used carefully, and provided theoretical analysis of when model-based augmentation helps versus hurts.

## 2.10 Benchmarks & Evaluation

### Standard Benchmarks

- **DeepMind Control Suite (DMControl):** A set of continuous control tasks with physics simulation [34]. Standard for evaluating world models on locomotion, manipulation, and balancing tasks.
- **Atari 100k:** Atari games with a budget of 100k environment interactions (roughly 2 hours of real-time play) [35]. The primary benchmark for sample-efficient RL with world models.
- **Atari 200M:** Full-scale Atari evaluation for assessing asymptotic performance.
- **Minecraft (Diamond):** Crafting a diamond in Minecraft as a long-horizon planning benchmark, famously used to evaluate DreamerV3 [9].

### Robotics Benchmarks

- **Meta-World:** A suite of 50 robotic manipulation tasks for multi-task evaluation.
- **CALVIN:** A benchmark for long-horizon language-conditioned manipulation.
- **Habitat:** An embodied AI platform for navigation and interaction in 3D environments [36].
- **CARLA:** An autonomous driving simulator used to evaluate world models for driving [37].

### Evaluation Challenges

World model evaluation faces several open challenges: (1) prediction quality (pixel accuracy, FID/FVD) does not always correlate with downstream task performance [30]; (2) long-horizon prediction accuracy degrades rapidly, making multi-step evaluation difficult; (3) stochastic environments make deterministic metrics misleading; and (4) there is no standard protocol for evaluating generalization across domains.

## 2.11 Open Problems & Future Directions

### Long-Horizon Prediction

Current world models struggle with predictions beyond a few dozen steps, as errors compound over time [38]. Hierarchical world models that operate at multiple temporal scales, or models that can skip ahead to relevant future states, are promising but underexplored directions.

### Compositional World Models

Real-world environments have compositional structure: objects can be combined, physical laws apply uniformly, and novel configurations can arise from familiar components. Learning world models with explicit compositional structure -- object-centric representations, relational reasoning, and modular dynamics -- remains an important challenge [39].

### Sim-to-Real Transfer

World models trained in simulation or on video data must ultimately transfer to real-world settings. The sim-to-real gap -- differences in visual appearance, physics, and dynamics between simulated and real environments -- continues to be a major obstacle for deploying world-model-based agents [40].

### Scaling Laws for World Models

Unlike language models, where scaling laws are well-characterized [41], the relationship between world model size, training data, and downstream performance is poorly understood. Understanding these scaling properties is critical for allocating resources effectively.

### Unifying Perception, Prediction, and Action

Current systems typically learn perception (encoders), prediction (dynamics models), and action (policies) as separate modules. A grand challenge is developing unified architectures that jointly optimize all three components, potentially achieving emergent capabilities not possible with modular designs.

### World Models for Scientific Discovery

Beyond game playing and robotics, world models could serve as learned simulators for scientific domains -- weather prediction, molecular dynamics, materials science -- where physics-based simulators are expensive or incomplete.

## 2.12 Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** World models benefit enormously from efficient architectures. State space models (Mamba) can replace transformers for long-horizon dynamics modeling; efficient attention mechanisms reduce the cost of video-based world models; and MoE architectures enable scaling world models to diverse domains without proportional compute increases.

**Agentic Search (Chapter 4):** World models enable agents to "search" through possible futures via planning, directly connecting to Monte Carlo Tree Search approaches discussed in Chapter 4. The combination of world models with tree search (MuZero) and with LLM-based reasoning represents a convergence of world modeling and agentic search.

**Continual Learning (Chapter 1):** World models deployed in changing environments must continually update their dynamics models without forgetting previously learned physics. This is particularly critical in robotics, where a robot's world model must adapt to new objects and environments.

**Randomized Algorithms (Chapter 5):** Random projections and sketching techniques can compress world model representations; spectral methods can analyze the learned dynamics; and randomized planning algorithms (random shooting, CEM) are standard tools for planning with world models.

## References

- [1] Craik, K.J.W. "The Nature of Explanation." Cambridge University Press, 1943.
- [2] Johnson-Laird, P.N. "Mental Models: Towards a Cognitive Science of Language, Inference, and Consciousness." Harvard University Press, 1983.
- [3] Ha, D. and Schmidhuber, J. "World Models." arXiv:1803.10122, 2018.
- [4] Hafner, D., Lillicrap, T., Fischer, I., et al. "Learning Latent Dynamics for Planning from Pixels." ICML, 2019.
- [5] Hafner, D., Lillicrap, T., Ba, J., and Norouzi, M. "Dream to Control: Learning Behaviors by Latent Imagination." ICLR, 2020.
- [6] Lecun, Y. "A Path Towards Autonomous Machine Intelligence." openreview.net, 2022.
- [7] Sutton, R.S. "Integrated Architectures for Learning, Planning, and Reacting Based on Approximating Dynamic Programming." ICML, 1990.
- [8] Hafner, D., Lillicrap, T., Norouzi, M., and Ba, J. "Mastering Atari with Discrete World Models." ICLR, 2021.
- [9] Hafner, D., Pasukonis, J., Ba, J., and Lillicrap, T. "Mastering Diverse Domains through World Models." arXiv:2301.04104, 2023. https://arxiv.org/abs/2301.04104
- [10] Denton, E. and Fergus, R. "Stochastic Video Generation with a Learned Prior." ICML, 2018.
- [11] Babaeizadeh, M., Saffar, M.T., Nair, S., et al. "FitVid: Overfitting in Pixel-Level Video Prediction." arXiv:2106.13195, 2021.
- [12] Yan, W., Zhang, Y., Abbeel, P., and Srinivas, A. "VideoGPT: Video Generation using VQ-VAE and Transformers." arXiv:2104.10157, 2021.
- [13] Wu, J., et al. "iVideoGPT: Interactive VideoGPTs are Scalable World Models." NeurIPS, 2024. https://arxiv.org/abs/2405.15223
- [14] Ho, J., Salimans, T., Gritsenko, A., et al. "Video Diffusion Models." NeurIPS, 2022.
- [15] Voleti, V., Jolicoeur-Martineau, A., and Pal, C. "MCVD: Masked Conditional Video Diffusion for Prediction, Generation, and Interpolation." NeurIPS, 2022.
- [16] Bruce, J., Dennis, M., Edwards, A., et al. "Genie: Generative Interactive Environments." ICML, 2024. https://arxiv.org/abs/2402.15391
- [17] Google DeepMind. "Genie 3." 2025. https://deepmind.google/models/genie/
- [18] Yang, M., Du, Y., Ghasemipour, K., et al. "Learning Interactive Real-World Simulators." arXiv:2310.06114, 2023.
- [19] Alonso, E., Jelley, A., Kanervisto, A., and Shersten, T. "Diffusion for World Modeling: Visual Details Matter in Atari." NeurIPS, 2024.
- [20] Valevski, D., Leviathan, Y., Arar, M., and Fruchter, S. "Diffusion Models Are Real-Time Game Engines." arXiv:2408.14837, 2024.
- [21] Hansen, N., Su, X., and Wang, X. "Temporal Difference Learning for Model Predictive Control." ICML, 2022.
- [22] Hansen, N., Su, H., and Wang, X. "TD-MPC2: Scalable, Robust World Models for Continuous Control." ICLR, 2024.
- [23] Du, Y., Yang, M., Florence, P., Xia, F., et al. "Video Language Planning." ICLR, 2024.
- [24] Zhou, Z., et al. "RoboDreamer: Learning Compositional World Models for Robot Imagination." arXiv:2404.12377, 2024.
- [25] Hao, S., Gu, Y., Ma, H., et al. "Reasoning with Language Model is Planning with World Model." EMNLP, 2023.
- [26] Guan, L., Valmeekam, K., Sreedharan, S., and Kambhampati, S. "Leveraging Pre-trained Large Language Models to Construct and Utilize World Models for Model-based Task Planning." NeurIPS, 2023.
- [27] Ge, Y., et al. "WorldGPT: Empowering LLM as Multimodal World Model." arXiv:2404.18202, 2024. https://arxiv.org/abs/2404.18202
- [28] Lin, J., Du, Y., Watkins, O., et al. "Learning to Model the World with Language." ICLR, 2024. https://dynalang.github.io/
- [29] Wong, L., Grand, G., Lew, A., et al. "From Word Models to World Models: Translating from Natural Language to the Probabilistic Language of Thought." arXiv:2306.12672, 2023.
- [30] Schrittwieser, J., Antonoglou, I., Hubert, T., et al. "Mastering Atari, Go, Chess and Shogi by Planning with a Learned Model." Nature, 2020.
- [31] Ye, W., Liu, S., Kurutach, T., Abbeel, P., and Gao, Y. "Mastering Atari Games with Limited Data." NeurIPS, 2021.
- [32] Micheli, V., Alonso, E., and Fleuret, F. "Transformers are Sample-Efficient World Models." ICLR, 2023.
- [33] Janner, M., Fu, J., Zhang, M., and Levine, S. "When to Trust Your Model: Model-Based Policy Optimization." NeurIPS, 2019.
- [34] Tassa, Y., Doron, Y., Muldal, A., et al. "DeepMind Control Suite." arXiv:1801.00690, 2018.
- [35] Kaiser, L., Babaeizadeh, M., Milos, P., et al. "Model Based Reinforcement Learning for Atari." ICLR, 2020.
- [36] Savva, M., Kadian, A., Maksymets, O., et al. "Habitat: A Platform for Embodied AI Research." ICCV, 2019.
- [37] Dosovitskiy, A., Ros, G., Codevilla, F., Lopez, A., and Koltun, V. "CARLA: An Open Urban Driving Simulator." CoRL, 2017.
- [38] Ke, N.R., Singh, A., Touati, A., et al. "Modeling the Long Term Future in Model-Based Reinforcement Learning." ICLR, 2019.
- [39] Kipf, T., van der Pol, E., and Welling, M. "Contrastive Learning of Structured World Models." ICLR, 2020.
- [40] Zhao, W., Queralta, J.P., and Westerlund, T. "Sim-to-Real Transfer in Deep Reinforcement Learning for Robotics: A Survey." IEEE Symposium Series on Computational Intelligence, 2020.
- [41] Kaplan, J., McCandlish, S., Henighan, T., et al. "Scaling Laws for Neural Language Models." arXiv:2001.08361, 2020.
