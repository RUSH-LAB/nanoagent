---
sidebar_position: 5
title: "Video Prediction Models"
---

# Video Prediction Models

Video prediction models learn to generate future video frames conditioned on past frames and optionally actions, forming a closely related class of world models. While video prediction and world modeling have historically been separate communities, they are converging rapidly: state-of-the-art world models increasingly use video generation architectures, and video prediction models are increasingly evaluated on their ability to support downstream decision-making.

### Stochastic Video Generation (SVG)

Denton and Fergus (2018) [@denton2018stochastic] proposed SVG, which uses a VAE framework with a learned prior to generate stochastic video predictions. The key contribution was addressing the **fundamental multimodality** of video prediction: given a ball rolling toward a wall, it might bounce left or right, and a good model should be able to generate both futures. By sampling different latent codes from the learned prior, SVG can generate diverse plausible futures, each internally consistent. This was an important conceptual contribution, establishing that deterministic video prediction models are fundamentally limited by their inability to represent uncertainty.

### FitVid

Babaeizadeh et al. (2021) [@babaeizadeh2021fitvid] introduced FitVid, which systematically studied the design space of video prediction architectures. Rather than proposing a new algorithmic idea, FitVid conducted careful ablations of architecture choices: encoder depth, skip connections, latent space size, conditioning mechanisms, and resolution. The striking finding was that careful architecture choices (deep encoders, skip connections, large latent spaces) matter more than algorithmic novelty, achieving state-of-the-art video prediction quality with a relatively standard VAE-based architecture. This result served as an important corrective for the field, suggesting that engineering fundamentals may be more important than novel loss functions or training procedures.

### Autoregressive Video Models

**VideoGPT** (Yan et al., 2021) [@yan2021videogpt] proposed tokenizing video using VQ-VAE and modeling the resulting discrete tokens autoregressively with a GPT-like transformer. This approach leverages the success of autoregressive language models for video generation, treating video as a "language" of visual tokens. VideoGPT demonstrated that the sequence modeling paradigm transfers effectively to the video domain, generating coherent short videos with temporal consistency.

**iVideoGPT** (Wu et al., 2024) [@wu2024ivideogpt] extended this paradigm to interactive world models, where the autoregressive video model is conditioned on actions to generate interactive environment simulations. The key insight is that conditioning an autoregressive video model on actions transforms it from a passive predictor into an interactive simulator. iVideoGPT showed that scaling VideoGPT-style models creates increasingly capable world simulators, with performance improving predictably with model size and data.

**STORM** (Zhang et al., 2025) [@zhang2025storm_wm] proposed a transformer-based world model that uses a "stochastic transformer" to model both the deterministic and stochastic components of environment dynamics. STORM replaces the RSSM's RNN backbone with a transformer, enabling parallel training (which is much faster than sequential RNN training) while maintaining the ability to model stochastic futures. STORM achieves competitive performance with DreamerV3 on the Atari 100k benchmark while being significantly faster to train.

### Video Diffusion Models

Diffusion-based video generation has emerged as the dominant paradigm for high-fidelity video synthesis. Ho et al. (2022) [@ho2022video] demonstrated Video Diffusion Models that generate temporally coherent video through iterative denoising, extending the success of image diffusion models to the temporal domain. MCVD (Voleti et al., 2022) [@voleti2022mcvd] introduced Masked Conditional Video Diffusion for flexible video prediction, interpolation, and generation. These models produce substantially higher visual fidelity than VAE-based approaches, with sharper details and more realistic textures, but at significantly higher computational cost (requiring multiple denoising steps per frame).

The convergence of video diffusion models with world modeling (as in DIAMOND and GameNGen) represents a major trend: the same architectures used for creative video generation can serve as high-fidelity environment simulators when conditioned on actions.

### Object-Centric Video Prediction

A distinct line of work focuses on structured, object-centric video prediction that explicitly decomposes scenes into objects and models their dynamics independently.

**C-SWM** (Kipf et al., 2020) [@kipf2020contrastive] proposed Contrastive Structured World Models, which learn object-centric state representations and pairwise interaction dynamics using a contrastive loss. By decomposing the scene into objects and learning their interaction graph, C-SWM can generalize to novel object configurations not seen during training.

**SlotFormer** (Wu et al., 2023) [@wu2023slotformer] extended this idea using slot attention [@locatello2020object] to discover objects and a transformer to model their temporal dynamics. SlotFormer achieves state-of-the-art unsupervised video prediction on multi-object scenes and supports downstream visual reasoning tasks. The compositional structure of object-centric world models enables systematic generalization: understanding the dynamics of individual objects and their interactions generalizes to novel combinations.

Object-centric world models connect to a deep question about the right level of abstraction for world models: should world models predict pixels (maximally detailed but computationally expensive), abstract features (efficient but potentially losing important structure), or objects and their relations (structured and generalizable but requiring object discovery)?
