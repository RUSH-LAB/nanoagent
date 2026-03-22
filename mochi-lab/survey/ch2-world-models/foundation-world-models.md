---
sidebar_position: 6
title: "Foundation World Models"
---

# Foundation World Models

A transformative recent trend is the development of large-scale, general-purpose world models trained on broad data.

### Genie (Google DeepMind)

Genie (Bruce et al., 2024) [@bruce2024genie] introduced the concept of generative interactive environments. Trained on internet videos of 2D platformer games, Genie learns a latent action space from unlabeled video, enabling controllable generation of interactive environments from a single image. Genie introduced the Spatiotemporal Transformer (ST-Transformer) architecture for efficient video tokenization and dynamics modeling. The Genie family has since expanded to Genie 2 and Genie 3, which generate photorealistic 3D interactive worlds from text or image prompts [@deepmind2025genie3].

### UniSim

Yang et al. (2023) [@yang2023learning] proposed UniSim, a universal simulator that learns to simulate diverse real-world interactions from video data. UniSim can generate plausible video predictions conditioned on various action types (robotic actions, human actions, text descriptions), positioning it as a step toward universal world models that support multiple downstream applications.

### DIAMOND

Alonso et al. (2024) [@alonso2024diffusion] introduced DIAMOND (DIffusion As a Model Of eNvironment Dreams), which uses diffusion models as world models for reinforcement learning. By generating high-fidelity environment simulations through iterative denoising, DIAMOND achieves state-of-the-art performance on the Atari 100k benchmark among world model approaches, surpassing Dreamer v3 on several games. DIAMOND demonstrates that the sample quality of diffusion models translates into better downstream RL performance.

### GameNGen

Valevski et al. (2024) [@valevski2024diffusion] introduced GameNGen, which uses a fine-tuned diffusion model to simulate the game DOOM in real-time. GameNGen generates each frame conditioned on the previous frames and player actions, achieving playable quality at 20+ FPS. This work demonstrated that diffusion models can serve as neural game engines, potentially replacing traditional game rendering pipelines.
