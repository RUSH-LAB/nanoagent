---
sidebar_position: 10
title: "Benchmarks & Evaluation"
---

# Benchmarks & Evaluation

### Standard Benchmarks

- **DeepMind Control Suite (DMControl):** A set of continuous control tasks with physics simulation [@tassa2018deepmind]. Standard for evaluating world models on locomotion, manipulation, and balancing tasks.
- **Atari 100k:** Atari games with a budget of 100k environment interactions (roughly 2 hours of real-time play) [@kaiser2020model]. The primary benchmark for sample-efficient RL with world models.
- **Atari 200M:** Full-scale Atari evaluation for assessing asymptotic performance.
- **Minecraft (Diamond):** Crafting a diamond in Minecraft as a long-horizon planning benchmark, famously used to evaluate DreamerV3 [@hafner2023mastering].

### Robotics Benchmarks

- **Meta-World:** A suite of 50 robotic manipulation tasks for multi-task evaluation.
- **CALVIN:** A benchmark for long-horizon language-conditioned manipulation.
- **Habitat:** An embodied AI platform for navigation and interaction in 3D environments [@savva2019habitat].
- **CARLA:** An autonomous driving simulator used to evaluate world models for driving [@dosovitskiy2017carla].

### Evaluation Challenges

World model evaluation faces several open challenges: (1) prediction quality (pixel accuracy, FID/FVD) does not always correlate with downstream task performance [@schrittwieser2020mastering]; (2) long-horizon prediction accuracy degrades rapidly, making multi-step evaluation difficult; (3) stochastic environments make deterministic metrics misleading; and (4) there is no standard protocol for evaluating generalization across domains.
