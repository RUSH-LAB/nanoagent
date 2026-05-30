---
sidebar_position: 6
title: "Foundation World Models"
---

# Foundation World Models

A transformative recent trend is the development of large-scale, general-purpose world models trained on broad data. Unlike the domain-specific world models of the Dreamer line (trained per-environment), foundation world models aim to learn general physics, visual dynamics, and interaction patterns from massive datasets, then transfer to specific environments with minimal adaptation. This parallels the foundation model paradigm in NLP (GPT, LLaMA) and vision (ViT, CLIP), where broad pre-training enables efficient specialization.

We organize the systems below along two axes. The first is the **prediction space**: whether a model predicts future observations directly in pixel space (Cosmos, DIAMOND, GameNGen, Sora) or in an abstract latent representation (Genie, JEPA). The second is the **training supervision**: whether dynamics are learned from action-conditioned interaction data (DIAMOND, GameNGen) or inferred from passive, unlabeled video (Genie, UniSim, Sora, V-JEPA). These axes set up the central tension running through every family, the fidelity-utility tradeoff: higher visual fidelity can improve planning when task-relevant dynamics are visually encoded, but it also raises compute cost and can waste capacity on details irrelevant to the downstream task. We return to this comparison at the end of the section.

### Genie (Google DeepMind)

Genie (Bruce et al., 2024) [@bruce2024genie] introduced the concept of **generative interactive environments**. Trained on 200,000 hours of internet videos of 2D platformer games (without any action labels), Genie learns three components: (1) a video tokenizer (VQ-VAE) that compresses video frames into discrete tokens, (2) a latent action model that infers a discrete action space from unlabeled video (learning what actions correspond to the observed state transitions), and (3) a dynamics model (ST-Transformer) that predicts the next frame given the current frame and a latent action.

The remarkable aspect of Genie is that it learns controllable world simulation from passive video: no action labels, no reward signals, no environment interaction. Given a single image (hand-drawn sketch, photograph, or generated image), Genie can generate a playable interactive environment. This opens the possibility of creating infinite training environments for RL agents from the vast corpus of internet video. The Genie family has since expanded: Genie 2 generates 3D interactive worlds with consistent geometry, and Genie 3 produces interactive environments from text or image prompts [@deepmind2025genie3], representing a rapid scaling of the foundation world model paradigm. (Note that the Genie 3 capabilities cited here are reported on a DeepMind product page rather than in a peer-reviewed technical report, so quantitative specifics should be treated as vendor claims pending an independent technical writeup.)

### Cosmos (NVIDIA)

NVIDIA's Cosmos [@nvidia2024cosmos] is a family of world foundation models designed to generate physically plausible visual simulations. Cosmos spans both diffusion-based variants (reported at 7B and 14B parameters) and autoregressive variants (4B and 12B), curated from roughly 20M hours of raw video distilled into about 100M training clips and trained on a 10,000-GPU cluster. This scale is the point: the key application is autonomous-driving simulation, where Cosmos can generate diverse driving scenarios for training and testing self-driving systems, and the reported data and compute budget illustrates why such systems are an industrial rather than academic undertaking. The economic value of synthetic simulation data, replacing expensive real-world collection, is what justifies that investment.

### UniSim

Yang et al. (2023) [@yang2023learning] proposed UniSim, a universal simulator that learns to simulate diverse real-world interactions from video data. UniSim can generate plausible video predictions conditioned on various action types (robotic actions, human actions, text descriptions), positioning it as a step toward universal world models that support multiple downstream applications. The concrete payoff the paper demonstrates is transfer: both a high-level vision-language policy and a low-level RL policy trained purely inside UniSim deploy zero-shot to the real world, evidence that a single foundation world model, by accepting actions in different formats (end-effector positions, language instructions, joystick inputs), can serve as the training substrate for diverse downstream agents rather than just producing visually plausible clips.

### DIAMOND

Alonso et al. (2024) [@alonso2024diffusion] introduced DIAMOND (DIffusion As a Model Of eNvironment Dreams), which uses diffusion models as world models for reinforcement learning. Instead of the VAE-based encoding used in Dreamer, DIAMOND generates complete pixel-space observations through iterative denoising, conditioned on the action and a history of previous frames. By generating high-fidelity environment simulations, DIAMOND achieves strong performance on the Atari 100k benchmark among world model approaches: its aggregate human-normalized mean score of 1.46 exceeds the DreamerV3 result of approximately 1.097 listed in the same comparison table (DIAMOND, Alonso et al. 2024, Table 1 [@alonso2024diffusion]), which is closely consistent with the approximately 1.12 mean reported in the DreamerV3 paper [@hafner2023mastering]. This is an aggregate mean across the benchmark rather than a per-game result.

DIAMOND demonstrates that the sample quality of diffusion models, their ability to generate sharp, diverse, and coherent images, directly translates into better downstream RL performance. The higher-fidelity "dreams" provide more accurate training signal for the policy, reducing the sim-to-imagination gap. However, the computational cost of diffusion-based world models (requiring multiple denoising steps per prediction) remains significantly higher than latent-space models. The success of DIAMOND can be understood through the lens of the fidelity-utility tradeoff: when the environment has complex visual structure that affects task-relevant dynamics (as in Atari), higher visual fidelity directly improves planning utility.

### GameNGen and Neural Game Engines

Valevski et al. (2024) [@valevski2024diffusion] introduced GameNGen, which uses a fine-tuned Stable Diffusion model [@rombach2022high] to simulate the game DOOM in real-time. GameNGen generates each frame conditioned on the previous frames and player actions, achieving playable quality at 20+ FPS on a TPU. A human evaluator study found that clips generated by GameNGen were indistinguishable from actual gameplay 58% of the time (near random chance). This work demonstrated that diffusion models can serve as **neural game engines**, potentially replacing traditional rendering pipelines.

The GameNGen paradigm suggests a future where games and simulations are not programmed with explicit rules but learned from demonstrations. This has profound implications: any environment that can be recorded as video can potentially be converted into a playable, interactive world model.

### Sora and Video Generation as World Modeling

OpenAI's Sora (2024) [@openai2024sora], while primarily a video generation model, has been discussed extensively through the lens of world modeling. Sora generates temporally coherent videos with consistent 3D geometry, object permanence, and plausible physics, properties that suggest it has learned an implicit world model from internet video data. However, Sora exhibits systematic failures (objects passing through each other, incorrect physics in edge cases) that reveal the limitations of learning world models purely from video prediction without explicit physics grounding.

The debate around whether video generation models like Sora are "true" world models (capable of supporting planning and counterfactual reasoning) or merely sophisticated pattern matchers remains active. This question has deep implications for the foundation world model approach: if video prediction alone is insufficient, what additional training signals (actions, rewards, physics simulators) are needed to learn genuine world models?

### JEPA: Joint Embedding Predictive Architecture

LeCun (2022) [@lecun2022path] proposed the Joint Embedding Predictive Architecture (JEPA) as a theoretical framework for world models that predict in abstract representation space rather than pixel space. The key argument is that pixel-level prediction is wasteful: it forces the model to predict irrelevant details (exact texture patterns, lighting variations) that are uninformative for planning. Instead, JEPA predicts in a learned latent space where irrelevant details are abstracted away.

V-JEPA (Bardes et al., 2024) [@bardes2024vjepa] implemented this vision for video understanding, training a model to predict masked spatiotemporal regions in a learned representation space (without pixel-level reconstruction). With a frozen backbone (no fine-tuning of model parameters), the ViT-H/16 variant reports 81.9% top-1 on Kinetics-400 and 72.2% on Something-Something-v2, motion-heavy benchmarks where appearance-only features tend to struggle. Because the objective predicts features rather than reconstructing pixels, V-JEPA avoids the decoder and per-pixel loss that reconstruction-based video models carry; the authors attribute its efficiency to this feature-prediction-only objective rather than reporting a fixed speedup ratio. V-JEPA 2 (Assran et al., 2025) [@assran2025vjepa2] extends the approach to a self-supervised video model that, after post-training on under 62 hours of unlabeled robot video, yields an action-conditioned world model (V-JEPA 2-AC) capable of zero-shot image-goal planning on real robot arms, pushing the latent-prediction line from passive understanding toward control.

The JEPA perspective directly connects to the MuZero insight (Section 2.9): world models do not need to predict observations accurately, they only need to predict quantities relevant to downstream tasks (values, rewards, policies, or abstract features).

### Comparative Analysis

Mapping these systems onto the two axes introduced above clarifies the design space. The following table summarizes prediction space, training supervision, and the primary application each system targets.

| System | Prediction space | Training supervision | Primary application |
|---|---|---|---|
| Genie | Latent (token) | Passive video, inferred latent actions | Generating playable RL environments |
| Cosmos | Pixel | Large-scale video | Autonomous-driving simulation |
| UniSim | Pixel | Video, multi-format action conditioning | Universal interaction simulation |
| DIAMOND | Pixel (diffusion) | Action-conditioned interaction | RL world model (Atari 100k) |
| GameNGen | Pixel (diffusion) | Action-conditioned gameplay | Neural game engine |
| Sora | Pixel | Passive video | Video generation / implicit world model |
| JEPA / V-JEPA | Latent (embedding) | Masked-region self-supervision | Representation learning, understanding |

Viewed through the fidelity-utility tradeoff, the pixel-space family (Cosmos, DIAMOND, GameNGen, Sora) invests in high visual fidelity, which pays off when task-relevant dynamics are encoded visually (as DIAMOND shows on Atari) but incurs heavy per-step compute, illustrated by diffusion's multi-step denoising and GameNGen's need for a TPU to reach interactive frame rates. The latent-space family (Genie, JEPA) deliberately abstracts away pixel detail, trading photorealism for efficiency and transfer, at the risk of discarding information a downstream task may need. The supervision axis cuts across this divide: passively trained models (Genie, UniSim, Sora, V-JEPA) scale to internet-sized corpora but must infer or forgo action grounding, while action-conditioned models (DIAMOND, GameNGen) obtain cleaner control signals at the cost of requiring interaction data. The open question the Sora debate sharpens, whether passive video prediction alone yields a planning-capable world model, is essentially a question about where on these two axes genuine world models must lie.
