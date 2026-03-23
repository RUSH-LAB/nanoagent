---
sidebar_position: 10
title: "Benchmarks & Evaluation"
---

# Benchmarks & Evaluation

### Standard Reinforcement Learning Benchmarks

- **Atari 100k:** Atari games evaluated with a budget of exactly 100,000 environment interactions (approximately 2 hours of real-time play) [@kaiser2020model]. This is the primary benchmark for sample-efficient world model RL, testing whether a world model can learn enough about game dynamics from limited experience to train an effective policy. Current state-of-the-art: DreamerV3 achieves ~1.19 human-normalized mean score; DIAMOND achieves ~1.46 using diffusion-based world modeling. The benchmark includes 26 games spanning diverse challenges (exploration, memory, rapid reaction, planning).

- **Atari 200M:** Full-scale Atari evaluation (200 million frames) for assessing asymptotic performance. Used to evaluate whether world models can match model-free methods given sufficient data. DreamerV3 matches or exceeds top model-free methods on most games.

- **DeepMind Control Suite (DMControl):** A set of continuous control tasks with physics simulation [@tassa2018deepmind]. Standard for evaluating world models on locomotion (walker, cheetah, hopper), manipulation (finger, reacher), and balancing tasks (cartpole, pendulum). Tasks range from easy (cartpole balance) to hard (humanoid walk) and test both sample efficiency and asymptotic performance. Dreamer v1/v2/v3 achieved progressively better results, with DreamerV3 matching model-free methods at 1M steps while requiring only 100K steps for most tasks.

- **Minecraft (Diamond):** The ultimate long-horizon planning benchmark: autonomously collecting a diamond in Minecraft requires discovering and executing a complex sequence of subtasks (collect wood, craft planks, craft sticks, craft pickaxe, mine cobblestone, craft stone pickaxe, mine iron, smelt iron, craft iron pickaxe, mine diamond) spanning hundreds of environment steps with sparse reward (only received at the end). DreamerV3 was the first (and remains one of the few) agents to achieve this without human data, curricula, or task-specific engineering [@hafner2023mastering].

### Robotics Benchmarks

- **Meta-World:** A suite of 50 robotic manipulation tasks for multi-task and meta-learning evaluation, ranging from simple reaching to complex assembly. Used to evaluate whether world models can generalize across manipulation skills.
- **CALVIN:** A benchmark for long-horizon, language-conditioned robotic manipulation, requiring execution of multi-step instructions in a simulated kitchen environment.
- **Habitat:** An embodied AI platform for navigation and interaction in photorealistic 3D environments [@savva2019habitat]. Used to evaluate world models for visual navigation and household tasks.
- **CARLA:** An autonomous driving simulator used to evaluate world models for driving tasks, including scenario generation, planning, and control [@dosovitskiy2017carla].
- **RLBench:** A suite of 100 robot manipulation tasks with varying difficulty, from simple pick-and-place to complex multi-step assembly.
- **Real-World Robot Benchmarks:** DayDreamer-style evaluations on physical robots (quadruped walking, robotic arm manipulation, RC car driving) provide the most practically relevant but least standardized evaluation.

### Video Prediction and Generation Benchmarks

- **FVD (Frechet Video Distance):** The standard quantitative metric for video generation quality, measuring the distance between generated and real video distributions in a learned feature space. Lower FVD indicates higher quality, but FVD does not capture temporal coherence or physical plausibility perfectly.
- **SSIM, PSNR, LPIPS:** Pixel-level and perceptual similarity metrics for individual frames. These metrics are easy to compute but poorly correlated with downstream task performance.
- **RoboNet, Something-Something, Kinetics:** Video datasets used for training and evaluating video prediction models, spanning robotic manipulation, human actions, and diverse activities.
- **PhysBench:** Emerging benchmarks specifically designed to test physical understanding (object permanence, gravity, collision dynamics) in video prediction models.

### Evaluation Challenges

World model evaluation faces several fundamental challenges:

1. **Prediction quality vs. task performance disconnect:** Pixel-level prediction accuracy (PSNR, SSIM, FVD) does not reliably correlate with downstream task performance [@schrittwieser2020mastering]. MuZero's world model produces predictions that look nothing like the actual game screens, yet supports superhuman play. Conversely, a visually perfect world model may predict irrelevant details accurately while missing task-critical dynamics. This disconnect raises a fundamental question: what should we optimize world models for?

2. **Long-horizon evaluation:** World model predictions degrade rapidly over long horizons due to compounding errors. Evaluating 1-step prediction quality is easy but uninformative about planning utility; evaluating 100-step prediction quality is informative but difficult (what is the right metric for stochastic multi-step prediction?).

3. **Stochastic environments:** In stochastic environments, the "correct" future prediction is not unique. Deterministic metrics penalize the model for generating one plausible future when the ground truth happened to be a different plausible future. Distribution-level metrics (FVD) partially address this but are noisy and expensive to compute.

4. **Generalization evaluation:** There is no standard protocol for evaluating whether a world model generalizes across environments, embodiments, or physics parameters. Developing standardized tests for generalization (transfer to new objects, new physics, new visual appearances) is an open challenge.

5. **Safety-critical evaluation:** For autonomous driving and medical robotics, the relevant question is not "how accurate is the world model on average?" but "how accurate is it in the worst case?" Evaluating worst-case prediction quality and its impact on downstream safety remains largely unsolved.
