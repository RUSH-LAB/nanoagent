---
sidebar_position: 10
title: "Benchmarks & Evaluation"
---

# Benchmarks & Evaluation

### Standard Reinforcement Learning Benchmarks

- **Atari 100k:** Atari games evaluated with a budget of exactly 100,000 environment interactions (approximately 2 hours of real-time play) [@kaiser2020model]. This is the primary benchmark for sample-efficient world model RL, testing whether a world model can learn enough about game dynamics from limited experience to train an effective policy. Current state-of-the-art: DreamerV3 achieves a human-normalized mean score of approximately 1.12 (as reported in the DreamerV3 paper; the DIAMOND comparison table lists a closely matching approximately 1.097 for its reproduction) [@hafner2023mastering, @alonso2024diffusion]; DIAMOND achieves approximately 1.46 using diffusion-based world modeling [@alonso2024diffusion]; EfficientZero is the first method to surpass average human performance on Atari 100k (~194% mean, ~109% median human-normalized) [@ye2021mastering]. The benchmark includes 26 games spanning diverse challenges (exploration, memory, rapid reaction, planning).

- **Atari 200M:** Full-scale Atari evaluation (200 million frames) for assessing asymptotic performance, building on the Arcade Learning Environment [@bellemare2013arcade]. Used to evaluate whether world models can match model-free methods given sufficient data. DreamerV3 reportedly matches or exceeds top model-free methods on most games [@hafner2023mastering].

- **DeepMind Control Suite (DMControl):** A set of continuous control tasks with physics simulation [@tassa2018deepmind]. Standard for evaluating world models on locomotion (walker, cheetah, hopper), manipulation (finger, reacher), and balancing tasks (cartpole, pendulum). Tasks range from easy (cartpole balance) to hard (humanoid walk) and test both sample efficiency and asymptotic performance. Dreamer v1/v2/v3 achieved progressively better results, with the DreamerV3 results reporting that it matches model-free methods at 1M steps and reaches strong performance within roughly 100K steps on many DMControl tasks [@hafner2023mastering]. TD-MPC2 [@hansen2024tdmpc2] demonstrated scaling to 80+ tasks across diverse embodiments.

- **Minecraft (Diamond):** The ultimate long-horizon planning benchmark: autonomously collecting a diamond in Minecraft requires discovering and executing a complex sequence of subtasks (collect wood, craft planks, craft sticks, craft pickaxe, mine cobblestone, craft stone pickaxe, mine iron, smelt iron, craft iron pickaxe, mine diamond) spanning hundreds of environment steps with sparse reward (only received at the end). DreamerV3 [@hafner2023mastering] was the first (and remains one of the few) agents to achieve this without human data, curricula, or task-specific engineering.

Taken together, these RL benchmarks isolate complementary capability gaps: Atari 100k stresses sample efficiency under a tight interaction budget, Atari 200M and DMControl probe asymptotic performance and continuous control, and Minecraft targets sparse-reward long-horizon planning. A world model that excels on one says little about the others, which is why progress is reported across the full set rather than on any single environment.

### Robotics Benchmarks

- **Meta-World:** A suite of 50 robotic manipulation tasks for multi-task and meta-learning evaluation [@yu2020metaworld], ranging from simple reaching to complex assembly. Used to evaluate whether world models can generalize across manipulation skills. TD-MPC2 demonstrated that a single world model can handle 50 Meta-World tasks with a single set of hyperparameters.
- **CALVIN:** A benchmark for long-horizon, language-conditioned robotic manipulation, requiring execution of multi-step instructions in a simulated kitchen environment [@mees2022calvin]. CALVIN tests the ability to chain 5+ sub-tasks from language descriptions, requiring both world prediction and language grounding.
- **Habitat:** An embodied AI platform for navigation and interaction in photorealistic 3D environments [@savva2019habitat]. Used to evaluate world models for visual navigation and household tasks. Habitat 2.0 extended to interactive tasks (rearrangement, social navigation) requiring prediction of object and agent dynamics.
- **CARLA:** An autonomous driving simulator used to evaluate world models for driving tasks, including scenario generation, planning, and control [@dosovitskiy2017carla]. CARLA provides diverse weather, lighting, and traffic conditions, and is the standard testbed for end-to-end driving approaches.
- **RLBench:** A suite of 100 robot manipulation tasks with varying difficulty [@james2020rlbench], from simple pick-and-place to complex multi-step assembly. RLBench provides both state-based and vision-based evaluation, enabling analysis of how much visual prediction contributes to task performance.
- **BEHAVIOR-1K:** A benchmark of 1,000 everyday activities in realistic simulated environments, requiring world models to predict the outcomes of complex, multi-step household tasks [@srivastava2022behavior]. BEHAVIOR-1K tests long-horizon prediction and compositional generalization in realistic settings.
- **Real-World Robot Benchmarks:** DayDreamer-style evaluations on physical robots (quadruped walking, robotic arm manipulation, RC car driving) provide the most practically relevant but least standardized evaluation. The RT-2 benchmark suite [@brohan2023rt] evaluates vision-language-action models on real robotic manipulation, providing a testbed for evaluating whether world models transfer from simulation to real hardware.

These robotics benchmarks span the spectrum from controlled single-task evaluation (Meta-World, RLBench) to long-horizon compositional tasks (CALVIN, BEHAVIOR-1K), embodied navigation (Habitat, CARLA), and real-world transfer (RT-2, DayDreamer). Each targets a distinct gap: Meta-World and RLBench measure breadth of manipulation skills, CALVIN adds language grounding, BEHAVIOR-1K stresses compositional generalization over everyday activities, and the real-world suites test the sim-to-real gap that simulators cannot capture. No single benchmark exercises all of these, so multi-benchmark reporting is again the norm.

### Video Prediction and Generation Benchmarks

- **FVD (Frechet Video Distance):** The standard quantitative metric for video generation quality, measuring the distance between generated and real video distributions in a learned feature space [@unterthiner2018towards]. Lower FVD indicates higher quality, but FVD does not capture temporal coherence or physical plausibility perfectly.
- **SSIM, PSNR, LPIPS:** Pixel-level and perceptual similarity metrics for individual frames, with SSIM measuring structural similarity [@wang2004image] and LPIPS measuring perceptual distance in a learned feature space [@zhang2018unreasonable]. These metrics are easy to compute but poorly correlated with downstream task performance.
- **RoboNet, Something-Something, Kinetics:** Video datasets used for training and evaluating video prediction models, spanning robotic manipulation [@dasari2019robonet], human-object interaction [@goyal2017something], and diverse human actions [@kay2017kinetics]. These provide large-scale training corpora rather than a single headline world-model number.
- **PhysBench:** An emerging benchmark designed to test physical understanding (object permanence, gravity, collision dynamics) in vision-language and video prediction models [@chow2025physbench].

These video prediction benchmarks collectively test whether world models capture both low-level pixel fidelity (SSIM, PSNR, LPIPS), distributional realism (FVD), and physical plausibility (PhysBench), with the key unresolved question being which metric best predicts downstream task utility.

### Evaluation Challenges

World model evaluation faces several fundamental challenges:

1. **Prediction quality vs. task performance disconnect:** Pixel-level prediction accuracy (PSNR, SSIM, FVD) does not reliably correlate with downstream task performance [@schrittwieser2020mastering]. MuZero's world model produces predictions that look nothing like the actual game screens, yet supports superhuman play. Conversely, a visually perfect world model may predict irrelevant details accurately while missing task-critical dynamics. This disconnect raises a fundamental question: what should we optimize world models for?

2. **Long-horizon evaluation:** World model predictions degrade rapidly over long horizons due to compounding errors. Evaluating 1-step prediction quality is easy but uninformative about planning utility; evaluating 100-step prediction quality is informative but difficult (what is the right metric for stochastic multi-step prediction?).

3. **Stochastic environments:** In stochastic environments, the "correct" future prediction is not unique. Deterministic metrics penalize the model for generating one plausible future when the ground truth happened to be a different plausible future. Distribution-level metrics (FVD) partially address this but are noisy and expensive to compute.

4. **Generalization evaluation:** There is no standard protocol for evaluating whether a world model generalizes across environments, embodiments, or physics parameters. Developing standardized tests for generalization (transfer to new objects, new physics, new visual appearances) is an open challenge.

5. **Safety-critical evaluation:** For autonomous driving and medical robotics, the relevant question is not "how accurate is the world model on average?" but "how accurate is it in the worst case?" Evaluating worst-case prediction quality and its impact on downstream safety remains largely unsolved.
