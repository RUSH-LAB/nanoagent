---
sidebar_position: 11
title: "Open Problems & Future Directions"
---

# Open Problems & Future Directions

### Long-Horizon Prediction

Current world models struggle with predictions beyond a few dozen steps, as errors compound over time [@ke2019modeling]. Hierarchical world models that operate at multiple temporal scales, or models that can skip ahead to relevant future states, are promising but underexplored directions.

### Compositional World Models

Real-world environments have compositional structure: objects can be combined, physical laws apply uniformly, and novel configurations can arise from familiar components. Learning world models with explicit compositional structure -- object-centric representations, relational reasoning, and modular dynamics -- remains an important challenge [@kipf2020contrastive].

### Sim-to-Real Transfer

World models trained in simulation or on video data must ultimately transfer to real-world settings. The sim-to-real gap -- differences in visual appearance, physics, and dynamics between simulated and real environments -- continues to be a major obstacle for deploying world-model-based agents [@zhao2020sim].

### Scaling Laws for World Models

Unlike language models, where scaling laws are well-characterized [@kaplan2020scaling], the relationship between world model size, training data, and downstream performance is poorly understood. Understanding these scaling properties is critical for allocating resources effectively.

### Unifying Perception, Prediction, and Action

Current systems typically learn perception (encoders), prediction (dynamics models), and action (policies) as separate modules. A grand challenge is developing unified architectures that jointly optimize all three components, potentially achieving emergent capabilities not possible with modular designs.

### World Models for Scientific Discovery

Beyond game playing and robotics, world models could serve as learned simulators for scientific domains -- weather prediction, molecular dynamics, materials science -- where physics-based simulators are expensive or incomplete.
