---
sidebar_position: 7
title: "World Models for Robotics & Autonomous Driving"
---

# World Models for Robotics & Autonomous Driving

World models are arguably most impactful in robotics and autonomous driving, where the cost of real-world interaction is highest (risk of hardware damage, slow data collection, safety constraints) and the potential benefit of simulation-based learning is greatest. This section covers world models specifically designed for robotic manipulation, locomotion, and autonomous driving.

## Robotics

### TD-MPC and TD-MPC2

Hansen et al. (2022, 2024) [@hansen2022temporal, @hansen2024tdmpc2] developed TD-MPC (Temporal Difference Learning for Model Predictive Control), which combines learned latent dynamics models with temporal difference learning for model-predictive control. The key insight is to learn a latent dynamics model that is specifically optimized for planning -- using a TD loss rather than reconstruction loss -- while planning with Model Predictive Path Integral (MPPI) control in the learned latent space.

TD-MPC2 (2024) scaled this approach dramatically: a single world model with a single set of hyperparameters that can control **80+ diverse robotic tasks** across different embodiments (arms, hands, quadrupeds, humanoids) and action spaces (continuous, high-dimensional). TD-MPC2 achieved this through multi-task training with large models (up to 317M parameters), demonstrating that world models for robotics follow favorable scaling laws -- performance improves predictably with model size and training data. This result suggests that a "foundation world model for robotics" is feasible, analogous to foundation language models.

### DayDreamer: Real-Robot Learning

Wu et al. (2023) [@wu2023daydreamer] demonstrated DayDreamer, the first application of Dreamer-style world models to learning directly on physical robots. DayDreamer trains a world model from a small amount of real-robot data (as little as 1 hour), then learns policies in imagination. Key results include:
- A quadruped robot learning to walk in 1 hour of real-world interaction
- A robot arm learning manipulation tasks from ~10 minutes of data
- An RC car learning to drive from camera observations

DayDreamer demonstrated that world model-based RL can work directly on physical hardware with realistic amounts of data, bridging the gap between simulation results and real-world deployment. The crucial insight is that even imperfect world models provide sufficient signal for policy learning when combined with ongoing real-world data collection.

### Foundation World Models for Robotics

Foundation-scale world models for robotics aim to learn general-purpose physics simulators from broad data that can transfer to specific robotic tasks. Du et al. (2024) [@du2024video] showed that large video prediction models pre-trained on diverse internet and robot video data can be fine-tuned for specific robotic manipulation tasks with limited demonstrations, enabling zero-shot or few-shot transfer to new tasks and environments.

### RoboDreamer

RoboDreamer (2024) [@zhou2024robodreamer] combines world models with language-conditioned planning for robotics. By learning to imagine the outcomes of language-described actions in a learned latent space, the model enables robots to plan complex manipulation sequences specified in natural language. The language conditioning enables compositional generalization: the robot can plan for instructions it has never seen by composing learned sub-skill predictions.

### Sim-to-Real Transfer

A central challenge in robotic world models is the **sim-to-real gap** -- discrepancies between learned (or designed) simulators and the real world. Domain randomization (training with randomized simulation parameters), system identification (fitting simulator parameters to real data), and domain adaptation techniques have been developed to bridge this gap [@zhao2020sim]. World models trained on real robot data (DayDreamer) sidestep the sim-to-real problem entirely, but at the cost of requiring real-world data collection.

## Autonomous Driving

Autonomous driving has emerged as one of the most active and commercially important application domains for world models. Learned world models serve multiple roles in the autonomous driving stack: scenario generation for testing, future prediction for planning, and simulation for training.

### GAIA-1 (Wayve)

Hu et al. (2023) [@hu2023gaia1] introduced GAIA-1, a generative world model for autonomous driving that generates realistic driving videos conditioned on text descriptions, actions, and past observations. GAIA-1 is a 9-billion parameter autoregressive transformer that generates video tokens, trained on driving data from Wayve's fleet. GAIA-1 demonstrated emergent understanding of driving scenarios: it generates realistic interactions between vehicles, respects traffic rules, and produces plausible responses to unusual situations (e.g., a car suddenly braking). GAIA-1 highlighted the potential of foundation world models for generating diverse training scenarios, potentially replacing expensive real-world data collection.

### MILE

Hu et al. (2022) [@hu2022mile] proposed MILE (Model-Based Imitation Learning), which learns a world model jointly with an imitation learning policy for autonomous driving. The world model predicts future bird's-eye-view (BEV) representations, enabling the policy to plan by imagining future traffic scenarios. MILE demonstrated that world model-based planning outperforms reactive (single-step) policies on the CARLA driving benchmark, particularly in complex scenarios requiring anticipation of other vehicles' behavior.

### OccWorld: Occupancy World Models

Zheng et al. (2024) [@zheng2024occworld] proposed OccWorld, which uses 3D occupancy prediction as the world model representation for autonomous driving. Rather than predicting raw sensor data or 2D images, OccWorld predicts future 3D occupancy grids, capturing the full spatial structure of the driving environment. This representation is particularly suitable for planning, as it directly encodes where objects will be in 3D space. OccWorld can predict both the evolution of the ego vehicle and surrounding traffic, enabling model-predictive planning in 3D.

### World Model Evaluation for Driving

Evaluating world models for autonomous driving poses unique challenges: pixel-level metrics (PSNR, SSIM) do not correlate well with driving performance, and downstream evaluation (actual driving success) is expensive and safety-critical. The development of standardized evaluation protocols that assess both generation quality and planning utility remains an active research area [@wang2024driving_world_survey].
