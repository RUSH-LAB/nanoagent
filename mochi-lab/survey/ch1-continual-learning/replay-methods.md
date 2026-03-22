---
sidebar_position: 5
title: "Replay & Rehearsal Methods"
---

# Replay & Rehearsal Methods

Replay-based methods maintain or generate data from previous tasks, mixing it with current task data during training.

### Experience Replay (ER)

The simplest replay strategy maintains a fixed-size buffer of randomly sampled exemplars from previous tasks [@riemer2019learning]. Despite its simplicity, experience replay has proven surprisingly competitive. Chaudhry et al. (2019) [@chaudhry2019tiny] showed that a well-tuned experience replay baseline outperforms many more complex continual learning algorithms. The key challenge is buffer management: which samples to store and how to balance buffer samples with current task data.

### Gradient Episodic Memory (GEM) and A-GEM

Lopez-Paz and Ranzato (2017) [@lopezpaz2017gradient] proposed GEM, which uses stored exemplars not for replay but as constraints on gradient updates. Specifically, GEM projects the gradient for the current task onto the feasible region where the loss on all previous task exemplars does not increase. While theoretically elegant, GEM requires solving a quadratic program at each optimization step, which is computationally expensive.

Chaudhry et al. (2019) [@chaudhry2019efficient] proposed Averaged GEM (A-GEM), a more efficient variant that projects the gradient using the average gradient over episodic memory rather than per-task constraints. A-GEM is significantly faster while retaining most of the forgetting-prevention benefits.

### Dark Experience Replay (DER/DER++)

Buzzega et al. (2020) [@buzzega2020dark] introduced Dark Experience Replay, which stores not just input-label pairs but also the model's logits (soft targets) at the time each sample was added to the buffer. This combines the benefits of experience replay with knowledge distillation, and DER++ (which adds a regularization term) has become a strong baseline that outperforms many more complex methods.

### Generative Replay

Instead of storing raw examples, generative replay methods train a generative model to produce synthetic data resembling previous tasks [@shin2017continual]. Shin et al. (2017) [@shin2017continual] proposed Deep Generative Replay (DGR), using a GAN that is trained alongside the main model. When learning a new task, the generator produces pseudo-samples from previous tasks that are mixed with real data.

Recent work has leveraged diffusion models for more effective generative replay. Gao et al. (2023) [@gao2023ddgr] proposed DDGR (Deep Diffusion-based Generative Replay), using denoising diffusion probabilistic models to generate higher-quality replay samples. Kim et al. (2024) [@kim2024sddgr] extended this to class-incremental object detection with SDDGR, using Stable Diffusion for replay sample generation.

### CLEAR and Continual CIFAR Benchmarks

Galashov et al. (2023) [@galashov2023continually] introduced methods for continually learning representations at scale, showing that replay-based methods can be effective even in large-scale settings when combined with appropriate learning rate schedules and regularization.
