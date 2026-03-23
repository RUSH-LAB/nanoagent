---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

World models can be organized along several orthogonal dimensions, and understanding these dimensions is essential for navigating the rapidly expanding literature.

**By prediction space:**
- **Pixel-space models** (SimPLe, DIAMOND, GameNGen): Predict raw observations directly. These models must capture every visual detail, which is computationally expensive but produces interpretable, evaluable predictions. Pixel-space models benefit from advances in generative modeling (diffusion, autoregressive), as higher visual fidelity directly translates to better world model quality.
- **Latent-space models** (PlaNet, Dreamer series, MuZero, TD-MPC): Predict in learned abstract state spaces. These models learn compressed representations that retain task-relevant information while discarding irrelevant visual details, enabling more efficient planning and learning. The Dreamer series represents the most mature lineage of latent-space world models.
- **Hybrid models** (JEPA, V-JEPA, STORM): Combine latent prediction with selective pixel or representation decoding. These models aim to balance the efficiency of latent prediction with the interpretability and fidelity of observation-space prediction.

**By generative paradigm:**
- **Deterministic models** (SimPLe, early dynamics models): Produce single-point predictions of future states. Simple to train but fundamentally unable to represent the multimodality of future outcomes.
- **Stochastic models** (PlaNet, Dreamer series, SVG): Use latent variables (typically via VAE) to model distributions over future states, capturing the inherent uncertainty and multimodality of the environment. The RSSM architecture, combining deterministic and stochastic components, is the dominant paradigm.
- **Autoregressive models** (VideoGPT, IRIS, STORM, GAIA-1): Model sequences of discrete tokens autoregressively, treating world simulation as sequence prediction. These models leverage the powerful scaling properties of autoregressive transformers, and the connection to language modeling enables transfer of architectural insights.
- **Diffusion-based models** (DIAMOND, GameNGen, Sora): Generate predictions through iterative denoising, producing the highest visual fidelity at the cost of multiple forward passes per prediction step.

**By application domain:**
- **Game playing and Atari** (MuZero, EfficientZero, SimPLe, IRIS, DIAMOND): The most well-benchmarked domain, with standardized evaluation protocols (Atari 100k) and clear comparison across methods.
- **Continuous control and robotics** (Dreamer series, TD-MPC, DayDreamer): Control tasks requiring precise physical prediction, from locomotion to manipulation.
- **Autonomous driving** (GAIA-1, MILE, OccWorld, Cosmos): Safety-critical applications requiring both high fidelity and reliable uncertainty estimation.
- **Video generation and prediction** (SVG, FitVid, Video Diffusion, Sora): Video prediction as a stepping stone toward general world modeling, with evaluation focused on visual quality metrics.
- **Reasoning and language-grounded dynamics** (Dynalang, WorldGPT, LLM-as-world-model): Connecting world models to language understanding, enabling compositional reasoning about dynamics.
- **Interactive environments** (Genie, UniSim, GameNGen): Foundation-scale models that generate interactive worlds from video data.

**By the level of structure:**
- **Monolithic models**: Learn a single, undifferentiated dynamics function that maps entire states to entire states. Most current models fall in this category.
- **Object-centric models** (C-SWM, SlotFormer): Explicitly decompose scenes into objects and model their individual dynamics and interactions. These models offer compositional generalization but require solving the unsupervised object discovery problem.
- **Physics-informed models**: Incorporate physical priors (conservation laws, symmetries, differential equations) into the dynamics model structure, improving generalization and physical plausibility.

These dimensions are largely orthogonal: one can build a latent-space, stochastic, object-centric, diffusion-based world model for robotics, for example. The trend in the field is toward models that are latent-space (for efficiency), stochastic (for uncertainty), autoregressive or diffusion-based (for quality), and trained on broad data (for generality).
