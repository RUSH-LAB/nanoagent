---
sidebar_position: 11
title: "Open Problems & Future Directions"
---

# Open Problems & Future Directions

### Long-Horizon Prediction and Compounding Errors

Current world models struggle with predictions beyond a few dozen steps, as errors compound multiplicatively over time [@ke2019modeling]. A small prediction error at step t propagates through subsequent predictions, causing exponential divergence from reality. For a model with per-step error epsilon, the error after H steps can grow as O(epsilon * H) in the best case (additive errors for stable dynamics) or O(epsilon^H) in the worst case (multiplicative errors for unstable dynamics). This compounding is the fundamental limitation that motivates short-horizon methods like MBPO [@janner2019when] (which uses short branched rollouts whose length follows a schedule, typically 1 to 5 steps) and the latent-space prediction approach of MuZero [@schrittwieser2020mastering] (which avoids pixel-level compounding entirely).

Promising directions include: hierarchical world models that operate at multiple temporal scales (e.g., Director [@hafner2022director] learns high-level goals that decompose long-horizon tasks into manageable sub-goals), **abstract world models** that predict in compressed spaces where errors are less damaging (MuZero, JEPA [@lecun2022path]), error-aware planning that accounts for model uncertainty when making decisions (using ensemble disagreement or posterior uncertainty to downweight predictions from regions of high model uncertainty), and diffusion-based world models [@alonso2024diffusion] that may compound errors differently than autoregressive models due to their iterative refinement process.

### Compositional and Object-Centric World Models

Real-world environments have compositional structure: objects can be combined, physical laws apply uniformly, and novel configurations can arise from familiar components. Learning world models with explicit compositional structure (object-centric representations, relational reasoning, and modular dynamics [@kipf2020contrastive, @wu2023slotformer]) remains an important challenge. Current foundation world models (Genie, Sora) learn monolithic models that do not explicitly represent objects, limiting their ability to generalize to novel object configurations. The integration of object discovery (slot attention, unsupervised segmentation) with dynamics modeling is a promising but technically challenging direction.

### Sim-to-Real Transfer

World models trained in simulation or on video data must ultimately transfer to real-world settings. The sim-to-real gap (differences in visual appearance, physics, and dynamics between simulated and real environments) continues to be a major obstacle [@zhao2020sim]. While DayDreamer [@wu2023daydreamer] demonstrated that world models can be trained directly on real robot data, the data efficiency is not yet sufficient for complex manipulation tasks. Foundation world models trained on diverse video data offer a potential solution: pre-training on broad data may produce models that transfer more easily to specific real-world settings.

### Scaling Laws for World Models

Unlike language models, where scaling laws are well-characterized [@kaplan2020scaling, @hoffmann2022training], the relationship between world model size, training data, and downstream task performance is poorly understood. TD-MPC2 [@hansen2024tdmpc2] provided initial evidence that world models follow favorable scaling laws in the robotics domain, but a comprehensive characterization across domains, architectures, and applications is missing. Understanding these scaling properties is critical for allocating resources effectively and predicting future capabilities.

### Unifying Perception, Prediction, and Action

Current systems typically learn perception (encoders), prediction (dynamics models), and action (policies) as separate modules with separate objectives. A grand challenge is developing unified architectures that jointly optimize all three components, potentially achieving emergent capabilities not possible with modular designs. The JEPA framework [@lecun2022path] proposes one path toward unification, and the success of end-to-end approaches in autonomous driving (e.g., combining perception and planning in a single model) provides empirical motivation.

### World Models for Scientific Discovery

Beyond game playing and robotics, world models could serve as learned simulators for scientific domains where physics-based simulators are expensive or incomplete. Applications include weather prediction (where GraphCast [@lam2023graphcast] and FourCastNet [@pathak2022fourcastnet] have already shown the value of learned simulators, achieving competitive or superior accuracy compared to traditional numerical weather prediction at a fraction of the computational cost), molecular dynamics, protein folding, materials science, and climate modeling. The key question is whether foundation world models trained on video data encode sufficient physical understanding to be useful for scientific simulation, or whether domain-specific training data (from physics simulators) is required.

### The World Model vs. Video Generator Debate

The rapid progress in video generation (Sora, Genie, Cosmos) has raised a fundamental question: is a high-fidelity video generator sufficient as a world model, or does it lack something essential? Arguments for sufficiency point to the impressive physical understanding demonstrated by these models. Arguments against point to systematic failures in edge cases, lack of explicit causal reasoning, and the inability to support counterfactual queries ("what would have happened if I had turned left instead of right?"). Resolving this debate is crucial for determining the research agenda: whether to focus on scaling video generation or on developing new architectures with explicit causal structure.

LeCun (2022) [@lecun2022path] argued that video generators are not world models because they lack the ability to perform interventions and counterfactual reasoning, two hallmarks of genuine causal understanding. A video generator can predict what typically follows a given scene, but cannot answer "what would happen if this specific variable changed while everything else remained the same." This distinction, rooted in Pearl's causal hierarchy [@pearl2009causality], suggests that additional architectural inductive biases (causal graphs, intervention mechanisms) may be necessary beyond what purely observational training provides.

### Safety and Reliability

World models used for planning in safety-critical domains (autonomous driving, medical robotics) must be reliable: their predictions must be accurate enough that policies trained on them behave safely in the real world. Developing methods for quantifying world model uncertainty, detecting out-of-distribution inputs (where predictions are likely to be inaccurate), and providing safety guarantees for world-model-based planning is an essential prerequisite for deployment.
