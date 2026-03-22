---
sidebar_position: 7
title: "World Models for Robotics"
---

# World Models for Robotics

### TD-MPC and TD-MPC2

Hansen et al. (2022, 2024) [@hansen2022temporal, @hansen2024tdmpc2] developed TD-MPC (Temporal Difference Learning for Model Predictive Control), which combines learned latent dynamics models with temporal difference learning for model-predictive control. TD-MPC2 scaled this approach to a single world model capable of controlling 80+ diverse robotic tasks across different embodiments and action spaces, demonstrating the generalization potential of world models for robotics.

### FOWM (Foundation World Models for Robotics)

Foundation-scale world models for robotics aim to learn general-purpose physics simulators from video data that can transfer to specific robotic tasks. Recent work has shown that large video prediction models pre-trained on diverse data can be fine-tuned for specific robotic manipulation tasks with limited demonstrations [@du2024video].

### RoboDreamer

RoboDreamer (2024) [@zhou2024robodreamer] combines world models with language-conditioned planning for robotics. By learning to imagine the outcomes of language-described actions, the model enables robots to plan complex manipulation sequences specified in natural language.
