---
sidebar_position: 7
title: "World Models for Robotics & Autonomous Driving"
---

# World Models for Robotics & Autonomous Driving

World models are arguably most impactful in robotics and autonomous driving, where the cost of real-world interaction is highest (risk of hardware damage, slow data collection, safety constraints) and the potential benefit of simulation-based learning is greatest. This section covers world models specifically designed for robotic manipulation, locomotion, and autonomous driving.

## Robotics

### TD-MPC and TD-MPC2

Hansen et al. (2022, 2024) [@hansen2022temporal, @hansen2024tdmpc2] developed TD-MPC (Temporal Difference Learning for Model Predictive Control), which combines learned latent dynamics models with temporal difference learning for model-predictive control. The key insight is to learn a latent dynamics model that is specifically optimized for planning (using a TD loss rather than reconstruction loss) while planning with Model Predictive Path Integral (MPPI) control in the learned latent space.

TD-MPC2 (2024) scaled this approach dramatically: a single world model with a single set of hyperparameters that can control **80+ diverse robotic tasks** across different embodiments (arms, hands, quadrupeds, humanoids) and action spaces (continuous, high-dimensional). TD-MPC2 achieved this through multi-task training with large models (up to 317M parameters), demonstrating that world models for robotics follow favorable scaling laws, with performance improving predictably with model size and training data. This result suggests that a "foundation world model for robotics" is feasible, analogous to foundation language models, though the evidence remains qualified: TD-MPC2's 80+ tasks are all continuous-control simulation benchmarks rather than demonstrations of real-world generalization, and the strongest real-robot results to date (DayDreamer, below) are single-skill and hour-scale rather than broadly multi-task. Compared with reconstruction-based Dreamer variants, TD-MPC's task-optimized latent trades visual fidelity (it cannot render the future) for planning efficiency and cross-embodiment generality, making it the strongest example of latent-only planning at scale.

### DayDreamer: Real-Robot Learning

Wu et al. (2023) [@wu2023daydreamer] demonstrated DayDreamer, the first application of Dreamer-style world models to learning directly on physical robots. DayDreamer trains a world model from a small amount of real-robot data (as little as 1 hour), then learns policies in imagination. Key results include:
- A quadruped robot learning to walk in 1 hour of real-world interaction
- A robot arm learning manipulation tasks from ~10 minutes of data
- An RC car learning to drive from camera observations

DayDreamer demonstrated that world model-based RL can work directly on physical hardware with realistic amounts of data, bridging the gap between simulation results and real-world deployment. The crucial insight is that even imperfect world models provide sufficient signal for policy learning when combined with ongoing real-world data collection. Where TD-MPC optimizes for cross-task breadth in simulation, DayDreamer optimizes for data efficiency on a single physical robot, trading TD-MPC's task-specific latent for Dreamer's reconstruction objective that learns from raw observations on hardware.

### Foundation World Models for Robotics

Foundation-scale world models for robotics aim to learn general-purpose physics simulators from broad data that can transfer to specific robotic tasks. Du et al. (2024) [@du2024video] proposed Video Language Planning (VLP), which performs long-horizon visual planning by combining vision-language models (acting as policies and value functions) with text-to-video models (acting as dynamics models). VLP runs a forward tree search over candidate plans, using the text-to-video model to imagine future visual rollouts and the VLM to score them, then executes the resulting plans through goal-conditioned policies. This shows that pre-trained foundation models for language, vision, and video can be composed into a planning system for robotic manipulation without retraining a monolithic controller.

### RoboDreamer

RoboDreamer (2024) [@zhou2024robodreamer] combines world models with language-conditioned planning for robotics. By learning to imagine the outcomes of language-described actions in a learned latent space, the model enables robots to plan complex manipulation sequences specified in natural language. The language conditioning enables compositional generalization: the robot can plan for instructions it has never seen by composing learned sub-skill predictions. Relative to VLP, which composes separate frozen foundation models at inference time, RoboDreamer learns a single language-conditioned generative model, trading VLP's modularity for tighter coupling between language and predicted dynamics.

### Cross-Cutting Challenge: Sim-to-Real Transfer

The subsections above are organized by system family (TD-MPC, DayDreamer, foundation-scale models, RoboDreamer). Sim-to-real transfer is different in kind: it is a cross-cutting challenge that every one of those families must contend with rather than a system in its own right. A central challenge in robotic world models is the **sim-to-real gap**: discrepancies between learned (or designed) simulators and the real world. Domain randomization (training with randomized simulation parameters), system identification (fitting simulator parameters to real data), and domain adaptation techniques have been developed to bridge this gap [@zhao2020sim]. World models trained on real robot data (DayDreamer) sidestep the sim-to-real problem entirely, but at the cost of requiring real-world data collection.

## Autonomous Driving

Autonomous driving has emerged as one of the most active and commercially important application domains for world models. Learned world models serve multiple roles in the autonomous driving stack: scenario generation for testing, future prediction for planning, and simulation for training.

### GAIA-1 (Wayve)

Hu et al. (2023) [@hu2023gaia1] introduced GAIA-1, a generative world model for autonomous driving that generates realistic driving videos conditioned on text descriptions, actions, and past observations. GAIA-1 is a 9-billion parameter autoregressive transformer that generates video tokens, trained on driving data from Wayve's fleet. GAIA-1 demonstrated emergent understanding of driving scenarios: it generates realistic interactions between vehicles, respects traffic rules, and produces plausible responses to unusual situations (e.g., a car suddenly braking). GAIA-1 highlighted the potential of foundation world models for generating diverse training scenarios, potentially replacing expensive real-world data collection. Its pixel-space generative objective prioritizes scenario fidelity and diversity over direct planning utility, the opposite tradeoff from the BEV- and occupancy-space models below, which sacrifice photorealism for representations a planner can act on.

### MILE

Hu et al. (2022) [@hu2022mile] proposed MILE (Model-Based Imitation Learning), which learns a world model jointly with an imitation learning policy for autonomous driving. The world model predicts future bird's-eye-view (BEV) representations, enabling the policy to plan by imagining future traffic scenarios. MILE demonstrated that world model-based planning outperforms reactive (single-step) policies on the CARLA driving benchmark, reporting roughly a 31% relative improvement in driving score (route completion weighted by infraction penalty) over the prior state of the art when deployed in a previously unseen town and weather conditions, particularly in complex scenarios requiring anticipation of other vehicles' behavior. By predicting in BEV space rather than pixels, MILE keeps the world model directly aligned with the planning objective, but its 2D representation discards the vertical structure that OccWorld preserves.

### OccWorld: Occupancy World Models

Zheng et al. (2024) [@zheng2024occworld] proposed OccWorld, which uses 3D occupancy prediction as the world model representation for autonomous driving. Rather than predicting raw sensor data or 2D images, OccWorld predicts future 3D occupancy grids, capturing the full spatial structure of the driving environment. This representation is particularly suitable for planning, as it directly encodes where objects will be in 3D space. OccWorld can predict both the evolution of the ego vehicle and surrounding traffic, enabling model-predictive planning in 3D. Across these three driving systems, the representation choice sets the dominant tradeoff: GAIA-1's pixels maximize generative diversity for testing, MILE's BEV grids balance fidelity and planning cost, and OccWorld's 3D occupancy maximizes spatial completeness for planning at the expense of richer appearance cues.

### World Model Evaluation for Driving

Evaluating world models for autonomous driving poses unique challenges: pixel-level metrics do not correlate well with driving performance, and downstream evaluation (actual driving success) is expensive and safety-critical. The pixel-level metrics in question are PSNR (peak signal-to-noise ratio, the log-scaled inverse of mean-squared error between predicted and ground-truth frames, where higher is better) and SSIM (structural similarity, a perceptual score in [0, 1] comparing luminance, contrast, and structure). Both reward photometric reconstruction, which is largely orthogonal to whether a planner derived from the prediction drives safely. Recent work has therefore moved toward planning-oriented evaluation on the nuScenes benchmark, where the standard metrics are the L2 displacement error between the planned and ground-truth ego trajectory (averaged over a 3-second horizon) and the collision rate (the fraction of predicted waypoints that overlap with other agents). UniAD (Hu et al., 2023) [@hu2023planning] proposed a unified autonomous driving framework that jointly performs perception, prediction, and planning, using the world model's prediction quality as measured by downstream planning performance rather than pixel accuracy; under its own evaluation protocol it reports an average L2 error of approximately 1.03 m and an average collision rate of approximately 0.31% on nuScenes. BEVFormer (Li et al., 2022) [@li2022bevformer] established bird's-eye-view representation as the standard interface between perception and prediction in autonomous driving, with world models operating on BEV features rather than raw images. VAD (Jiang et al., 2023) [@jiang2023vad] proposed vectorized scene representation for efficient autonomous driving, representing scenes as sets of vectorized entities (lane centerlines, agent trajectories) rather than dense grids, enabling more efficient world modeling and planning. The development of standardized evaluation protocols that assess both generation quality and planning utility remains an active research area [@wang2024driving_world_survey].
