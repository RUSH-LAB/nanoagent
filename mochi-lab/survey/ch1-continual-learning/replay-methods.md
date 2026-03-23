---
sidebar_position: 5
title: "Replay & Rehearsal Methods"
---

# Replay & Rehearsal Methods

Replay-based methods maintain or generate data from previous tasks, mixing it with current task data during training. This approach is directly inspired by the neuroscience of memory consolidation: the hippocampus rapidly encodes new experiences, which are then "replayed" during sleep to consolidate them in the neocortex [@ji2007coordinated, @mcclelland1995there]. Replay has emerged as the dominant paradigm in continual learning, with replay-based methods consistently achieving the best results across benchmarks and settings [@delange2021continual, @boschini2022class].

## Experience Replay and Buffer Management

### Experience Replay (ER)

The simplest and most fundamental replay strategy maintains a fixed-size buffer of randomly sampled exemplars from previous tasks and interleaves them with current task data during training [@riemer2019learning, @chaudhry2019tiny]. Despite its simplicity, experience replay has proven surprisingly competitive -- a finding that has been both humbling and instructive for the field.

Chaudhry et al. (2019) [@chaudhry2019tiny] conducted a landmark study showing that a well-tuned experience replay baseline (which they called "Tiny Episodic Memories") with as few as 1 exemplar per class outperforms many more complex continual learning algorithms, including EWC, SI, and GEM, on standard benchmarks. This result was an important corrective for the field, demonstrating that simple baselines had been insufficiently explored and that method complexity does not necessarily translate to better performance.

### Buffer Management Strategies

The effectiveness of replay critically depends on buffer management -- which samples to store and which to evict when the buffer is full:

- **Reservoir sampling** [@vitter1985random] maintains a uniform random sample of all data seen so far, with each sample having equal probability of being retained. This is memory-efficient and theoretically principled but does not account for sample informativeness.
- **Herding** (nearest-mean-of-exemplars) selects exemplars that best approximate the class mean in feature space [@rebuffi2017icarl]. This deterministic strategy tends to produce more representative buffers than random sampling.
- **Gradient-based selection** chooses samples that maximize gradient diversity or minimize expected forgetting [@aljundi2019gradient]. Aljundi et al. (2019) [@aljundi2019gradient] proposed GSS (Gradient-based Sample Selection), which selects exemplars that maximize the diversity of gradients in the buffer, ensuring broad coverage of the loss landscape.
- **Surprise-based selection** retains samples that the current model finds surprising or informative, measured by loss value or prediction uncertainty [@chrysakis2020online].

### MER: Meta-Experience Replay

Riemer et al. (2019) [@riemer2019learning] proposed MER (Meta-Experience Replay), which combines experience replay with meta-learning. Rather than simply mixing replay samples with current data, MER uses the replay buffer within a meta-learning framework: the model is updated on current data (inner loop) and then adjusted to maintain performance on buffer samples (outer loop). This "learn to not forget" approach achieves stronger knowledge retention than naive replay.

## Gradient-Constrained Methods

### Gradient Episodic Memory (GEM) and A-GEM

Lopez-Paz and Ranzato (2017) [@lopezpaz2017gradient] proposed GEM, which uses stored exemplars not for replay but as constraints on gradient updates. Specifically, GEM projects the gradient for the current task onto the feasible region where the loss on all previous task exemplars does not increase. Formally, at each optimization step, GEM solves:

min_g' ||g' - g||^2 such that g'^T g_k >= 0 for all k in {1, ..., t-1}

where g is the gradient on current task data and g_k is the gradient on exemplars from task k. This ensures that no update increases the loss on any previous task's exemplars. While theoretically elegant and providing formal guarantees on per-task loss, GEM requires solving a quadratic program at each optimization step (O(t^2) per step for t tasks), which becomes computationally prohibitive for long task sequences.

Chaudhry et al. (2019) [@chaudhry2019efficient] proposed Averaged GEM (A-GEM), a more efficient variant that projects the gradient using the average gradient over the entire episodic memory rather than per-task constraints. A-GEM reduces the constraint to a single inner product check per step, making it orders of magnitude faster while retaining most of the forgetting-prevention benefits. However, A-GEM's single averaged constraint is weaker than GEM's per-task constraints, and it can permit forgetting on individual tasks as long as the average is maintained.

### Gradient Projection Memory (GPM)

Saha et al. (2021) [@saha2021gradient] proposed GPM, which projects gradient updates to be orthogonal to the subspace spanned by the representations of previous tasks. GPM maintains a basis for the input representation subspace of each past task (computed via SVD of the stored representations) and projects the gradient onto the orthogonal complement. This ensures that updates for new tasks do not interfere with the representations used by previous tasks. GPM achieves strong performance in Task-IL and Domain-IL settings, and its gradient orthogonality principle has influenced several subsequent methods [@wang2021orthogonal_adamn].

## Distillation-Enhanced Replay

### iCaRL: Incremental Classifier and Representation Learning

Rebuffi et al. (2017) [@rebuffi2017icarl] proposed iCaRL, one of the earliest and most influential methods for class-incremental learning. iCaRL combines three ideas: (1) a knowledge distillation loss to preserve representations, (2) herding-based exemplar selection to maintain a representative buffer, and (3) nearest-mean-of-exemplars classification (using class means in feature space rather than the softmax classifier) to avoid the bias toward recent classes. iCaRL demonstrated that combining representation preservation with intelligent buffer management could achieve viable class-incremental performance, and its framework has been the basis for many subsequent methods.

### Dark Experience Replay (DER/DER++)

Buzzega et al. (2020) [@buzzega2020dark] introduced Dark Experience Replay, which stores not just input-label pairs but also the model's logits (soft targets) at the time each sample was added to the buffer. When replaying samples, the model is trained to match both the hard labels and the stored soft targets, effectively combining experience replay with knowledge distillation in a single framework.

DER++ extends DER by adding a regularization term that further constrains the model's outputs on buffer samples. The key insight is that logits contain richer information than hard labels -- they encode the model's confidence and inter-class relationships at the time of storage, providing a more informative replay signal. DER++ has become one of the strongest baselines in continual learning, consistently outperforming more complex methods across benchmarks. In the comprehensive evaluation of Boschini et al. (2022) [@boschini2022class], DER++ achieved the best performance among non-ensemble methods on Split-CIFAR-100 and Split-TinyImageNet.

### FOSTER: Feature Boosting and Compression

Wang et al. (2022) [@wang2022foster] proposed FOSTER (Feature Boosting and Compression for class-incremental learning), which dynamically expands the network with a new feature extractor for each task (boosting step) and then compresses the expanded model back to the original size via knowledge distillation (compression step). This approach combines the zero-forgetting property of architecture expansion with the fixed-capacity property of distillation-based methods, achieving strong class-incremental performance without growing model size.

### Co2L: Contrastive Continual Learning

Cha et al. (2021) [@cha2021co2l] proposed Co2L, which applies supervised contrastive learning [@khosla2020supervised] to continual learning. Co2L trains representations using a contrastive loss (pulling same-class samples together and pushing different-class samples apart) combined with asymmetric knowledge distillation that preserves old-task representations. The contrastive formulation produces more transferable representations than standard cross-entropy training, improving both within-task and cross-task performance.

### SS-IL: Separated Softmax for Incremental Learning

Ahn et al. (2021) [@ahn2021ssil] proposed SS-IL (Separated Softmax for Incremental Learning), which addresses the classifier bias problem by computing softmax separately for old and new classes during training, then combining them at inference. This simple separation prevents the new classes from dominating the softmax competition during training, maintaining a more balanced decision boundary. SS-IL is easy to implement and can be combined with any replay-based method for improved class-incremental performance.

## Generative Replay

### Deep Generative Replay (DGR)

Instead of storing raw examples (which may be impractical for privacy or memory reasons), generative replay methods train a generative model to produce synthetic data resembling previous tasks. Shin et al. (2017) [@shin2017continual] proposed Deep Generative Replay (DGR), using a GAN that is trained alongside the main model. When learning a new task, the generator produces pseudo-samples from previous tasks that are mixed with real data. The generator itself is trained continually, producing synthetic data from the previous generator while learning to generate the current task's data.

DGR's appeal lies in its potential to avoid storing any real data, making it fully privacy-preserving. However, the quality of generative replay depends critically on the quality of the generative model, and training GANs that can continually generate diverse, high-quality samples across many tasks remains challenging. Mode collapse in the generator can lead to incomplete coverage of previous tasks' data distributions.

### Diffusion-Based Replay

Recent work has leveraged diffusion models for more effective generative replay, taking advantage of their superior sample quality compared to GANs. Gao et al. (2023) [@gao2023ddgr] proposed DDGR (Deep Diffusion-based Generative Replay), using denoising diffusion probabilistic models to generate higher-quality replay samples. The improved fidelity and diversity of diffusion-generated samples translates to better continual learning performance, narrowing the gap with methods that store real exemplars.

Kim et al. (2024) [@kim2024sddgr] extended this to class-incremental object detection with SDDGR, using Stable Diffusion for replay sample generation. By leveraging a pre-trained text-to-image diffusion model, SDDGR can generate diverse, high-quality images of previously seen object classes without storing any real training data.

### REMIND

Hayes et al. (2020) [@hayes2020remind] proposed REMIND (Replay using Memory Indexing), which stores compressed intermediate representations (quantized feature maps from mid-level network layers) rather than raw images. When replaying, these compressed representations are reconstructed and passed through the remaining network layers. This approach is significantly more memory-efficient than storing raw images while providing more accurate replay than generative methods, occupying an interesting middle ground between exemplar-based and generative replay.

## Replay at Scale

### Continual Representation Learning at Scale

Galashov et al. (2023) [@galashov2023continually] introduced methods for continually learning representations at scale, showing that replay-based methods can be effective even in large-scale settings when combined with appropriate learning rate schedules, warmup strategies, and regularization. Their work on ImageNet-scale continual learning demonstrated that the principles discovered on small benchmarks do not always transfer to large-scale settings, and that careful engineering of the training pipeline is as important as the choice of continual learning algorithm.

### The Surprising Effectiveness of Simple Replay

A recurring theme in continual learning research is the strong performance of simple replay baselines. Multiple comprehensive evaluations [@chaudhry2019tiny, @buzzega2020dark, @boschini2022class] have found that carefully implemented experience replay, possibly augmented with knowledge distillation (DER++), matches or outperforms most purpose-built continual learning methods. This suggests that the field's progress on replay-free methods may be slower than it appears, and that any new continual learning method should be compared against a well-tuned replay baseline.
