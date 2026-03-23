---
sidebar_position: 5
title: "Video Prediction Models"
---

# Video Prediction Models

Video prediction models learn to generate future video frames conditioned on past frames and optionally actions, forming a closely related class of world models. While video prediction and world modeling have historically been separate communities, they are converging rapidly: state-of-the-art world models increasingly use video generation architectures, and video prediction models are increasingly evaluated on their ability to support downstream decision-making.

### Early Video Prediction: From LSTMs to Adversarial Training

The foundations of neural video prediction were laid by Srivastava et al. (2015) [@srivastava2015unsupervised], who demonstrated that LSTM encoders-decoders could learn useful video representations through future frame prediction. Oh et al. (2015) [@oh2015action] showed that action-conditioned video prediction in Atari games could be achieved with convolutional architectures, establishing the paradigm of conditioning predictions on agent actions. Finn et al. (2016) [@finn2016unsupervised] extended this to robotic manipulation, predicting future frames conditioned on robot actions to enable simple planning through visual foresight. Chiappa et al. (2017) [@chiappa2017recurrent] proposed recurrent environment simulators that could generate long, coherent rollouts of game environments.

A key early insight was that pixel-space prediction with mean squared error produces blurry outputs because MSE averages over multiple possible futures. Mathieu et al. (2016) [@mathieu2016deep] addressed this with adversarial training, using a discriminator to encourage sharp predictions, while Lotter et al. (2017) [@lotter2017deep] proposed PredNet, inspired by predictive coding theory in neuroscience, which learns hierarchical prediction errors. These early works established the core challenges that continue to define the field: handling stochasticity (multiple plausible futures), maintaining long-horizon coherence, and avoiding the blurriness of MSE-trained models.

### Stochastic Video Generation (SVG)

Denton and Fergus (2018) [@denton2018stochastic] proposed SVG, which uses a VAE framework with a learned prior to generate stochastic video predictions. The key contribution was addressing the **fundamental multimodality** of video prediction: given a ball rolling toward a wall, it might bounce left or right, and a good model should be able to generate both futures. By sampling different latent codes from the learned prior, SVG can generate diverse plausible futures, each internally consistent. This was an important conceptual contribution, establishing that deterministic video prediction models are fundamentally limited by their inability to represent uncertainty.

### FitVid

Babaeizadeh et al. (2021) [@babaeizadeh2021fitvid] introduced FitVid, which systematically studied the design space of video prediction architectures. Rather than proposing a new algorithmic idea, FitVid conducted careful ablations of architecture choices: encoder depth, skip connections, latent space size, conditioning mechanisms, and resolution. The striking finding was that careful architecture choices (deep encoders, skip connections, large latent spaces) matter more than algorithmic novelty, achieving state-of-the-art video prediction quality with a relatively standard VAE-based architecture. This result served as an important corrective for the field, suggesting that engineering fundamentals may be more important than novel loss functions or training procedures.

### Autoregressive Video Models

**VideoGPT** (Yan et al., 2021) [@yan2021videogpt] proposed tokenizing video using VQ-VAE and modeling the resulting discrete tokens autoregressively with a GPT-like transformer. This approach leverages the success of autoregressive language models for video generation, treating video as a "language" of visual tokens. VideoGPT demonstrated that the sequence modeling paradigm transfers effectively to the video domain, generating coherent short videos with temporal consistency.

**iVideoGPT** (Wu et al., 2024) [@wu2024ivideogpt] extended this paradigm to interactive world models, where the autoregressive video model is conditioned on actions to generate interactive environment simulations. The key insight is that conditioning an autoregressive video model on actions transforms it from a passive predictor into an interactive simulator. iVideoGPT showed that scaling VideoGPT-style models creates increasingly capable world simulators, with performance improving predictably with model size and data.

**STORM** (Zhang et al., 2025) [@zhang2025storm_wm] proposed a transformer-based world model that uses a "stochastic transformer" to model both the deterministic and stochastic components of environment dynamics. STORM replaces the RSSM's RNN backbone with a transformer, enabling parallel training (which is much faster than sequential RNN training) while maintaining the ability to model stochastic futures. STORM achieves competitive performance with DreamerV3 on the Atari 100k benchmark while being significantly faster to train.

### Video Diffusion Models

Diffusion-based video generation has emerged as the dominant paradigm for high-fidelity video synthesis. Ho et al. (2022) [@ho2022video] demonstrated Video Diffusion Models that generate temporally coherent video through iterative denoising, extending the success of image diffusion models to the temporal domain. Imagen Video (Ho et al., 2022) [@ho2022imagen] scaled this approach to high-definition video generation with a cascade of spatial and temporal super-resolution diffusion models, producing 1280x768 videos at 24 fps. MCVD (Voleti et al., 2022) [@voleti2022mcvd] introduced Masked Conditional Video Diffusion for flexible video prediction, interpolation, and generation. Make-A-Video (Singer et al., 2022) [@singer2022make] demonstrated text-to-video generation by decoupling spatial and temporal learning, training on image-text pairs for spatial understanding and unsupervised video for temporal dynamics. Stable Video Diffusion (Blattmann et al., 2023) [@blattmann2023stable] scaled latent video diffusion to large datasets, achieving state-of-the-art video generation quality with a model that could be fine-tuned for specific downstream applications. VideoPoet (Kondratyuk et al., 2024) [@kondratyuk2024videopoet] unified video generation tasks within a single large language model, treating video tokens as another modality in a multimodal autoregressive framework.

These models produce substantially higher visual fidelity than VAE-based approaches, with sharper details and more realistic textures, but at significantly higher computational cost (requiring multiple denoising steps per frame). The convergence of video diffusion models with world modeling (as in DIAMOND and GameNGen) represents a major trend: the same architectures used for creative video generation can serve as high-fidelity environment simulators when conditioned on actions.

### Object-Centric Video Prediction

A distinct line of work focuses on structured, object-centric video prediction that explicitly decomposes scenes into objects and models their dynamics independently. The intellectual roots trace back to Interaction Networks (Battaglia et al., 2016) [@battaglia2016interaction], which modeled physical interactions between objects using graph neural networks, and Visual Interaction Networks (Watters et al., 2017) [@watters2017visual], which extended this to learning physics from video. The broader framework of graph networks for physical reasoning was formalized by Battaglia et al. (2018) [@battaglia2018relational].

Object discovery methods provide the perceptual foundation for object-centric world models. MONet (Burgess et al., 2019) [@burgess2019monet] and IODINE (Greff et al., 2019) [@greff2019multi] demonstrated unsupervised decomposition of scenes into object representations, while slot attention (Locatello et al., 2020) [@locatello2020object] provided a scalable, differentiable mechanism for binding visual features to object "slots." Graph-based physics simulation (Sanchez-Gonzalez et al., 2020) [@sanchez2020learning] showed that learned simulators with graph structure could generalize to novel physical scenarios.

**C-SWM** (Kipf et al., 2020) [@kipf2020contrastive] proposed Contrastive Structured World Models, which learn object-centric state representations and pairwise interaction dynamics using a contrastive loss. By decomposing the scene into objects and learning their interaction graph, C-SWM can generalize to novel object configurations not seen during training.

**SlotFormer** (Wu et al., 2023) [@wu2023slotformer] extended this idea using slot attention to discover objects and a transformer to model their temporal dynamics. SlotFormer achieves state-of-the-art unsupervised video prediction on multi-object scenes and supports downstream visual reasoning tasks. The compositional structure of object-centric world models enables systematic generalization: understanding the dynamics of individual objects and their interactions generalizes to novel combinations.

Object-centric world models connect to a deep question about the right level of abstraction for world models: should world models predict pixels (maximally detailed but computationally expensive), abstract features (efficient but potentially losing important structure), or objects and their relations (structured and generalizable but requiring object discovery)?
