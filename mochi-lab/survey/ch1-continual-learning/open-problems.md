---
sidebar_position: 10
title: "Open Problems & Future Directions"
---

# Open Problems & Future Directions

### Scaling to Long Task Sequences

Most methods are evaluated on 5-20 tasks. Real-world scenarios may involve hundreds or thousands of tasks, and many methods degrade significantly in this regime [@hsu2018reevaluating]. Architecture-based methods face linear model growth; regularization methods face capacity saturation as the feasible region of parameter space shrinks; and replay methods face buffer management challenges at scale (with a fixed buffer, the number of exemplars per task decreases as the number of tasks grows). Developing methods that maintain consistent performance across hundreds or thousands of tasks without unbounded resource growth is a critical open challenge. The few studies that have evaluated on long sequences (50-200 tasks) suggest that most methods' performance profiles look very different at scale than on short sequences [@javed2019meta].

### Forward and Backward Transfer

Positive backward transfer -- learning new tasks improves old task performance -- remains elusive. Most methods focus exclusively on preventing negative backward transfer (forgetting) while largely ignoring forward transfer (how learning earlier tasks helps with future tasks). Achieving genuine **knowledge accumulation**, where each new task makes the model globally better, is a grand challenge [@delange2021continual]. Current methods at best maintain old task performance while learning new tasks; they rarely improve old task performance. The few methods that achieve positive backward transfer (e.g., through feature sharing or progressive task adaptation) do so only in limited settings where tasks are highly related.

### Task-Free Continual Learning

Most methods assume clear task boundaries -- the model is told when one task ends and another begins. Real-world data streams, however, often have gradual distribution shifts without explicit task demarcation. Task-free (or task-agnostic) continual learning, where the algorithm must detect and adapt to distributional changes without being told when they occur, is an important open problem [@aljundi2019taskfree]. This requires methods that can: (1) detect distributional changes online, (2) decide when to allocate new capacity or protect existing knowledge, and (3) operate without task-specific hyperparameters (like per-task regularization strength). While some methods (MAS, online EWC) can operate without explicit task boundaries, they generally perform worse in this setting than when task boundaries are provided.

### Continual Learning at Scale

The interaction between continual learning and large-scale pre-training is poorly understood. Foundation models already encode vast knowledge -- how to update them efficiently without destroying this knowledge is a critical question for practical deployment [@jang2022towards, @scialom2025continual, @ibrahim2024investigating]. Key questions include: Do standard continual learning techniques (replay, regularization) work the same way at the billion-parameter scale? How does the structure of pre-training data interact with continual learning? Can we develop continual pre-training strategies that are provably efficient (i.e., requiring less compute than retraining from scratch)?

### Theoretical Foundations

Despite rapid algorithmic progress, the theoretical understanding of continual learning remains limited. Key open questions include [@evron2022catastrophic]:

- **Fundamental limits:** What are the information-theoretic limits of continual learning? Given a sequence of T tasks with specified complexity, what is the minimum model capacity needed to achieve given accuracy levels on all tasks?
- **Task structure and learnability:** How does the structure of the task sequence (e.g., task similarity, ordering) affect the difficulty of continual learning? Are there conditions under which continual learning is provably easy or provably hard?
- **Convergence guarantees:** Can we prove convergence guarantees for continual learning algorithms? Most existing analyses are limited to convex settings or specific architectures that do not reflect practical use.
- **Representation learning theory:** What makes some representations more amenable to continual learning than others? Can we characterize the properties of "good" continual learning representations?

### Continual Learning Beyond Classification

The vast majority of continual learning research focuses on image classification. Extending continual learning to other tasks -- object detection, semantic segmentation, generation, reinforcement learning, and multi-modal learning -- raises unique challenges. For instance, continual object detection must handle both new classes and changing backgrounds, while continual generation must avoid mode collapse across sequentially learned distributions. Recent work has begun addressing these settings: SDDGR [@kim2024sddgr] tackles continual object detection using diffusion-based replay; continual semantic segmentation methods must handle the background shift problem (regions that were background in previous tasks become foreground in new tasks); and continual RL faces the additional challenge that the data distribution depends on the policy, creating a feedback loop between forgetting and exploration.

Continual learning for generative models presents particular challenges. A continual image generator must produce high-quality samples from all previously learned distributions without mode collapse or mode forgetting. This is closely related to the generative replay approach (DGR [@shin2017continual], DDGR [@gao2023ddgr]) -- in fact, continual generative modeling and generative replay are two sides of the same coin. The rise of diffusion models has opened new opportunities: their iterative denoising process may be more amenable to continual training than GANs, as the denoising objective is more stable and less prone to mode collapse.

### Privacy-Preserving Continual Learning

Replay-based methods, which store data from previous tasks, can conflict with privacy requirements (e.g., GDPR, HIPAA). Developing continual learning methods that are both effective and privacy-preserving is an important practical challenge. Generative replay (DGR [@shin2017continual], DDGR [@gao2023ddgr]) offers one solution (storing a model rather than data), but the generated samples may still contain identifiable information through memorization in the generative model. Federated continual learning [@yoon2021federated], where data remains on user devices and only model updates are shared, is a promising direction but introduces additional challenges from data heterogeneity (non-IID data distribution across clients) and communication constraints (limited bandwidth for model updates). Differential privacy techniques can be combined with continual learning to provide formal privacy guarantees, but the noise required for privacy can exacerbate forgetting. The intersection of privacy, continual learning, and federated learning is a rich area with many open problems.

### Real-World Deployment

Bridging the gap between benchmark performance and real-world deployment requires addressing a constellation of practical issues: data imbalance (real-world tasks are rarely balanced), noisy labels, domain shift within tasks, privacy constraints (which may prevent data storage), computational budgets that vary over time, and the need for anytime inference (the model must perform well at any point during training, not just after completing a task). Industrial applications such as autonomous driving, medical diagnosis, and recommendation systems each bring domain-specific challenges that current benchmarks do not capture [@hsu2018reevaluating].

### Unifying Perspectives

The field of continual learning is increasingly fragmented, with separate communities working on continual learning from scratch, continual learning with pre-trained models, continual pre-training of LLMs, knowledge editing, and model merging. A unifying theoretical and methodological framework that connects these perspectives -- recognizing that they all address the fundamental stability-plasticity tradeoff in different contexts -- would be valuable for guiding future research and avoiding redundant effort.
