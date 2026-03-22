---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

World models can be organized along several dimensions:

**By prediction space:**
- Pixel-space models: predict raw observations directly
- Latent-space models: predict in learned abstract state spaces
- Hybrid models: combine latent prediction with selective pixel decoding

**By generative paradigm:**
- Deterministic models: single-point predictions
- Stochastic models: distributions over future states (e.g., VAE-based)
- Autoregressive models: sequential token/patch prediction (GPT-style)
- Diffusion-based models: iterative denoising for prediction

**By application domain:**
- Game playing and Atari
- Continuous control and robotics
- Video generation and prediction
- Reasoning and language-grounded dynamics
