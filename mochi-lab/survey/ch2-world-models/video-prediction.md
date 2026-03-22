---
sidebar_position: 5
title: "Video Prediction Models"
---

# Video Prediction Models

Video prediction models learn to generate future video frames conditioned on past frames and optionally actions, forming a closely related class of world models.

### Stochastic Video Generation (SVG)

Denton and Fergus (2018) [@denton2018stochastic] proposed SVG, which uses a VAE framework with learned prior to generate stochastic video predictions. By sampling different latent codes, the model can generate diverse plausible futures, addressing the fundamental multimodality of video prediction.

### FitVid

Babaeizadeh et al. (2021) [@babaeizadeh2021fitvid] introduced FitVid, which systematically studied the design space of video prediction architectures. They found that careful architecture choices (deep encoders, skip connections, large latent spaces) matter more than algorithmic novelty, achieving state-of-the-art video prediction quality.

### VideoGPT and Autoregressive Approaches

Yan et al. (2021) [@yan2021videogpt] proposed VideoGPT, which tokenizes video using VQ-VAE and then models the resulting discrete tokens autoregressively with a GPT-like transformer. This approach leverages the success of autoregressive language models for video generation.

More recently, iVideoGPT (Wu et al., 2024) [@wu2024ivideogpt] extended this paradigm to interactive world models, where the autoregressive video model is conditioned on actions to generate interactive environment simulations. They showed that scaling VideoGPT-style models creates increasingly capable world simulators.

### Video Diffusion Models

Diffusion-based video generation has emerged as a powerful paradigm. Ho et al. (2022) [@ho2022video] demonstrated Video Diffusion Models that generate temporally coherent video through iterative denoising. MCVD (Voleti et al., 2022) [@voleti2022mcvd] introduced Masked Conditional Video Diffusion for flexible video prediction, interpolation, and generation. These models produce higher visual fidelity than VAE-based approaches but at significantly higher computational cost.
