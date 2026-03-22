# Chapter 1: Continual Learning of AI

## 1.1 Introduction & Motivation

Biological neural systems learn continuously throughout their lifetime, seamlessly integrating new knowledge without destroying what was previously learned. Artificial neural networks, by contrast, suffer from **catastrophic forgetting** (also called catastrophic interference) -- the tendency to abruptly lose performance on previously learned tasks when trained on new data [1, 2]. This phenomenon, first identified by McCloskey and Cohen (1989) [1] and later formalized by French (1999) [3], remains one of the central obstacles to building AI systems that can learn and adapt over time.

Continual learning (CL), also referred to as lifelong learning or incremental learning, seeks to endow neural networks with the ability to learn from a non-stationary stream of data, accumulating knowledge over time while maintaining performance on earlier tasks [4, 5]. The importance of this capability cannot be overstated: real-world deployment scenarios -- from autonomous vehicles encountering new road conditions to medical AI systems facing evolving disease patterns -- fundamentally require models that adapt without retraining from scratch.

The field has experienced a renaissance driven by three converging forces. First, the deployment of large-scale AI systems has made the cost of full retraining prohibitive. Second, the success of foundation models has raised questions about how to update these models with new knowledge without degrading existing capabilities. Third, neuroscience research on synaptic consolidation and complementary learning systems has inspired new algorithmic approaches [6, 7].

This chapter provides a comprehensive review of continual learning methods, organized by algorithmic family rather than chronologically. We cover regularization-based, replay-based, and architecture-based approaches, as well as the emerging intersection of continual learning with large language models. We discuss standard benchmarks and evaluation protocols, and conclude with open problems and connections to other chapters in this survey.

## 1.2 Problem Formulation

### Task Settings

Continual learning problems are typically categorized into three settings, following the taxonomy of van de Ven and Tolias (2019) [8]:

**Task-Incremental Learning (Task-IL):** The model learns a sequence of tasks T_1, T_2, ..., T_N, and at test time is told which task a given sample belongs to. This is the easiest setting, as the model can maintain task-specific output heads and only needs to avoid forgetting shared representations.

**Class-Incremental Learning (Class-IL):** The model must learn to distinguish among all classes seen so far, without being told which task a test sample comes from. This is significantly harder, as the model must solve both a within-task and a cross-task classification problem.

**Domain-Incremental Learning (Domain-IL):** The task structure (input-output mapping type) remains the same, but the input distribution shifts over time. For example, a sentiment classifier trained on product reviews must also handle movie reviews without performance degradation.

### Formal Framework

Consider a sequence of T tasks, where each task t provides a dataset D_t = {(x_i^t, y_i^t)}. The goal is to learn parameters theta that minimize the expected loss across all tasks seen so far:

min_theta sum_{t=1}^{T} E_{(x,y) ~ D_t} [L(f_theta(x), y)]

subject to constraints on memory, compute, and access to previous task data (which is typically unavailable or limited).

### Evaluation Metrics

The field has converged on several standard metrics [5, 9]:

- **Average Accuracy (AA):** Mean accuracy across all tasks after the final task is learned.
- **Backward Transfer (BWT):** Measures how much learning new tasks affects performance on old tasks. Negative BWT indicates forgetting.
- **Forward Transfer (FWT):** Measures how much learning earlier tasks helps performance on future tasks.
- **Average Incremental Accuracy:** The average of average accuracies computed after each task is learned.

## 1.3 Taxonomy of Approaches

Continual learning methods can be organized into four major families [4, 5, 10]:

1. **Regularization-based methods** add penalty terms to the loss function that discourage changes to parameters important for previous tasks.
2. **Replay-based methods** store or generate exemplars from previous tasks and interleave them with new task data during training.
3. **Architecture-based methods** allocate dedicated parameters or subnetworks for each task, preventing interference by design.
4. **Meta-learning-based methods** learn to learn continually, optimizing for the ability to quickly adapt to new tasks while retaining old knowledge.

These families are not mutually exclusive; many state-of-the-art methods combine elements from multiple families. For instance, a method might use replay with regularization, or architecture expansion with meta-learning.

## 1.4 Regularization Methods

Regularization-based approaches constrain weight updates to preserve knowledge encoded in parameters deemed important for previous tasks.

### 1.4.1 Elastic Weight Consolidation (EWC)

Kirkpatrick et al. (2017) [11] proposed EWC, drawing inspiration from synaptic consolidation in neuroscience. EWC adds a quadratic penalty to the loss function that penalizes changes to parameters proportional to their importance for previous tasks:

L_total = L_new(theta) + (lambda / 2) * sum_i F_i * (theta_i - theta_i^*)^2

where F_i is the diagonal of the Fisher information matrix (approximating parameter importance) and theta_i^* are the optimal parameters for the previous task. EWC demonstrated that selective parameter protection could substantially mitigate forgetting on sequential Atari game learning.

A key limitation of EWC is that the Fisher information approximation is only locally valid, and the quadratic penalty can become overly restrictive as the number of tasks grows. Online EWC [12] addresses the growing memory cost by maintaining a running sum of Fisher information matrices rather than storing one per task.

### 1.4.2 Synaptic Intelligence (SI)

Zenke et al. (2017) [13] proposed Synaptic Intelligence (SI), which computes parameter importance online during training rather than post-hoc. SI tracks the contribution of each parameter to the loss reduction along the entire training trajectory, yielding an importance measure that is both cheaper to compute and arguably more representative than the Fisher-based approximation of EWC. Empirical comparisons show SI and EWC perform comparably, with SI being more memory-efficient [13].

### 1.4.3 Learning without Forgetting (LwF)

Li and Hoiem (2017) [14] introduced LwF, which uses knowledge distillation [15] to preserve the behavior of the network on old tasks while learning new ones. Rather than constraining parameters directly, LwF constrains the network's outputs: when training on new task data, it minimizes a distillation loss that encourages the network to produce the same outputs as the old model on the new task's inputs. This approach requires no stored exemplars from previous tasks but assumes that new task data is somewhat representative of previous input distributions.

### 1.4.4 Memory Aware Synapses (MAS)

Aljundi et al. (2018) [16] proposed MAS, which estimates parameter importance based on the sensitivity of the learned function (rather than the loss) to parameter changes. This is computed as the magnitude of the gradient of the output with respect to each parameter, averaged over the data. MAS is task-agnostic and can be computed in an unsupervised manner, making it more flexible than EWC in settings where task boundaries are unclear.

### 1.4.5 Limitations of Regularization Approaches

Regularization methods share a fundamental limitation: as the number of tasks grows, the feasible region of parameter space that satisfies all constraints shrinks, eventually leaving insufficient capacity for new learning [17]. This phenomenon, sometimes called "capacity saturation," means regularization methods tend to degrade on long task sequences. Additionally, these methods generally struggle with class-incremental learning, where task identity is not provided at test time [8].

## 1.5 Replay & Rehearsal Methods

Replay-based methods maintain or generate data from previous tasks, mixing it with current task data during training.

### 1.5.1 Experience Replay (ER)

The simplest replay strategy maintains a fixed-size buffer of randomly sampled exemplars from previous tasks [18]. Despite its simplicity, experience replay has proven surprisingly competitive. Chaudhry et al. (2019) [19] showed that a well-tuned experience replay baseline outperforms many more complex continual learning algorithms. The key challenge is buffer management: which samples to store and how to balance buffer samples with current task data.

### 1.5.2 Gradient Episodic Memory (GEM) and A-GEM

Lopez-Paz and Ranzato (2017) [20] proposed GEM, which uses stored exemplars not for replay but as constraints on gradient updates. Specifically, GEM projects the gradient for the current task onto the feasible region where the loss on all previous task exemplars does not increase. While theoretically elegant, GEM requires solving a quadratic program at each optimization step, which is computationally expensive.

Chaudhry et al. (2019) [21] proposed Averaged GEM (A-GEM), a more efficient variant that projects the gradient using the average gradient over episodic memory rather than per-task constraints. A-GEM is significantly faster while retaining most of the forgetting-prevention benefits.

### 1.5.3 Dark Experience Replay (DER/DER++)

Buzzega et al. (2020) [22] introduced Dark Experience Replay, which stores not just input-label pairs but also the model's logits (soft targets) at the time each sample was added to the buffer. This combines the benefits of experience replay with knowledge distillation, and DER++ (which adds a regularization term) has become a strong baseline that outperforms many more complex methods.

### 1.5.4 Generative Replay

Instead of storing raw examples, generative replay methods train a generative model to produce synthetic data resembling previous tasks [23]. Shin et al. (2017) [23] proposed Deep Generative Replay (DGR), using a GAN that is trained alongside the main model. When learning a new task, the generator produces pseudo-samples from previous tasks that are mixed with real data.

Recent work has leveraged diffusion models for more effective generative replay. Gao et al. (2023) [24] proposed DDGR (Deep Diffusion-based Generative Replay), using denoising diffusion probabilistic models to generate higher-quality replay samples. Kim et al. (2024) [25] extended this to class-incremental object detection with SDDGR, using Stable Diffusion for replay sample generation.

### 1.5.5 CLEAR and Continual CIFAR Benchmarks

Galashov et al. (2023) [26] introduced methods for continually learning representations at scale, showing that replay-based methods can be effective even in large-scale settings when combined with appropriate learning rate schedules and regularization.

## 1.6 Architecture-Based Methods

Architecture-based approaches prevent forgetting by design, either by freezing subsets of parameters or by dynamically expanding the network.

### 1.6.1 Progressive Neural Networks

Rusu et al. (2016) [27] proposed Progressive Neural Networks (PNN), which allocate a new column of network parameters for each task while freezing all previous columns. Lateral connections from old columns to new ones enable forward transfer. PNN completely eliminates forgetting but at the cost of linearly growing model size and inability to share parameters across tasks efficiently.

### 1.6.2 Dynamically Expandable Networks (DEN)

Yoon et al. (2018) [28] proposed DEN, which selectively retrains and expands the network based on task demands. DEN first tries to learn new tasks using existing capacity, then adds neurons only when performance is insufficient. A group sparsity regularizer encourages parameter sharing across tasks, leading to more compact models than PNN.

### 1.6.3 PackNet

Mallya and Lazebnik (2018) [29] proposed PackNet, which uses iterative pruning to identify and freeze subnetworks for each task within a fixed-size network. After training on a task, unimportant weights are pruned and the remaining weights are frozen. New tasks use the pruned (freed) weights. PackNet achieves zero forgetting with constant model size but has limited capacity determined by the pruning ratio and number of tasks.

### 1.6.4 Hard Attention to the Task (HAT)

Serra et al. (2018) [30] proposed HAT, which learns task-specific attention masks over units in each layer. A learnable, nearly-binary mask determines which units are used for each task, and gradients are blocked from flowing through units important for previous tasks. HAT achieves near-zero forgetting with controlled capacity allocation.

### 1.6.5 Supermasks in Superposition (SupSup)

Wortsman et al. (2020) [31] proposed SupSup, which maintains a randomly initialized, fixed backbone and learns binary supermasks for each task. At inference, the appropriate mask is applied to the fixed weights, effectively instantiating a task-specific subnetwork. SupSup can handle thousands of tasks with constant backbone size and zero forgetting, though performance depends on the backbone's capacity and the task similarity.

### 1.6.6 Modular Networks and Mixture-of-Experts Approaches

Recent work has explored using Mixture-of-Experts (MoE) architectures for continual learning. Expert gates can route inputs to task-specific expert modules, with new experts added for new tasks while old experts are frozen [32]. This approach connects continual learning to efficient architecture design (see Chapter 3).

## 1.7 Meta-Continual Learning

Meta-learning approaches aim to learn initialization or update rules that are inherently amenable to continual learning.

### 1.7.1 Online Meta-Learning (OML)

Javed and White (2019) [33] proposed OML, which meta-learns a representation that is robust to catastrophic forgetting. OML uses a MAML-like outer loop where the meta-objective explicitly penalizes forgetting during the inner loop updates. The learned representation generalizes well to long task sequences.

### 1.7.2 A Neuromodulated Meta-Learning Algorithm (ANML)

Beaulieu et al. (2020) [34] introduced ANML, which adds a neuromodulatory network that gates activations during learning. The neuromodulator is meta-learned to selectively protect important features while allowing plasticity for new learning. This biologically inspired approach outperforms OML on several benchmarks.

### 1.7.3 La-MAML

Gupta et al. (2020) [35] proposed La-MAML (Look-Ahead Meta Learning for Continual Learning), which modulates the per-parameter learning rates based on the look-ahead loss on a meta-objective that includes both current and previous task performance. La-MAML achieves strong performance on both task-incremental and class-incremental settings while being more computationally efficient than standard MAML-based approaches.

### 1.7.4 Meta-Continual Learning with Replay (MRCL)

MRCL combines meta-learning with replay, learning representations that are specifically optimized for replay-based continual learning [36]. The meta-objective ensures that a small number of replay samples is maximally effective for retaining previous task knowledge.

## 1.8 Continual Learning in Large Language Models

The advent of large language models (LLMs) has created new urgency and new challenges for continual learning [37, 38].

### 1.8.1 Continual Pre-Training

LLMs are typically pre-trained on massive corpora and then adapted to downstream tasks. Continual pre-training -- updating the model on new data without full retraining -- is essential for keeping models current. Gupta et al. (2023) [39] studied continual pre-training of LLMs and found that naive fine-tuning on new data causes significant forgetting of previously learned capabilities. They showed that replay of a small fraction of original pre-training data substantially mitigates this issue.

Ibrahim et al. (2024) [40] investigated continual pre-training at scale, demonstrating that learning rate re-warming combined with data mixing strategies can enable effective knowledge accumulation across multiple pre-training stages. Their work on the Llama model family showed that thoughtful continual pre-training can match or exceed the performance of training from scratch on the combined dataset.

### 1.8.2 Continual Instruction Tuning

Wu et al. (2024) [41] addressed continual instruction tuning, where an LLM must learn to follow new types of instructions without forgetting how to handle previously learned instruction types. They proposed Self-Distillation for continual instruction tuning, using the model's own outputs as soft targets to preserve previous capabilities while learning new instruction-following abilities.

### 1.8.3 Catastrophic Forgetting in RLHF

Reinforcement Learning from Human Feedback (RLHF) can itself induce forgetting of pre-training knowledge. The alignment tax -- degradation of general capabilities during alignment training -- is a form of catastrophic forgetting. Methods like PPO with KL penalties partially address this by constraining the fine-tuned model to stay close to the base model, but more principled continual learning approaches are needed [42].

### 1.8.4 Parameter-Efficient Approaches

Parameter-efficient fine-tuning (PEFT) methods like LoRA, adapters, and prompt tuning offer natural mechanisms for continual learning in LLMs. By learning small task-specific parameter additions while keeping the backbone frozen, PEFT methods can reduce forgetting. Recent work has explored composing multiple LoRA modules for multi-task continual learning [43, 44].

## 1.9 Benchmarks & Evaluation

### Standard Benchmarks

The field has converged on several standard benchmarks [5, 8]:

- **Permuted MNIST:** A sequence of tasks where each task applies a different fixed pixel permutation to MNIST images. Now considered too simple for meaningful evaluation.
- **Split-CIFAR-10/100:** CIFAR-10 or CIFAR-100 classes are divided into sequential groups of tasks. Split-CIFAR-100 with 10 or 20 tasks is a common setting.
- **Split-ImageNet:** ImageNet classes divided into sequential tasks. Much more challenging and realistic.
- **Split-TinyImageNet:** A compromise between CIFAR and full ImageNet complexity.

### Newer Benchmarks

- **CTrL (Continual Transfer Learning):** Veniat et al. (2021) [45] proposed CTrL, which evaluates continual learning with diverse task types and controlled transfer relationships, going beyond simple splits of a single dataset.
- **CLUE (Continual Language Understanding Evaluation):** Extends continual learning evaluation to NLP tasks, testing sequential learning of different text classification and NLU tasks.
- **Avalanche:** Lomonaco et al. (2021) [46] released Avalanche, an end-to-end library and benchmark suite for continual learning that standardizes experimental protocols.

### Evaluation Challenges

Meaningful evaluation of continual learning remains difficult. Farquhar and Gal (2019) [47] identified several pitfalls: many evaluations use only class-incremental settings, which disadvantage certain method families; hyperparameter selection often uses the full test set; and the number of tasks is often too small to reveal long-term trends. More recent evaluations have moved toward longer task sequences, more realistic settings, and standardized protocols [26, 46].

## 1.10 Open Problems & Future Directions

### Scaling to Long Task Sequences

Most methods are evaluated on 5-20 tasks. Real-world scenarios may involve hundreds or thousands of tasks, and many methods degrade significantly in this regime [17]. Architecture-based methods face linear model growth, regularization methods face capacity saturation, and replay methods face buffer management challenges at scale.

### Forward and Backward Transfer

Positive backward transfer (learning new tasks improves old task performance) remains elusive. Most methods focus on preventing negative backward transfer (forgetting) while largely ignoring forward transfer. Achieving genuine knowledge accumulation where each new task makes the model globally better is a grand challenge [5].

### Task-Free Continual Learning

Most methods assume clear task boundaries, but real-world data streams may have gradual distribution shifts without explicit task demarcation. Task-free (or task-agnostic) continual learning, where the algorithm must detect and adapt to distributional changes without being told when they occur, is an important open problem [48].

### Continual Learning at Scale

The interaction between continual learning and large-scale pre-training is poorly understood. Foundation models already encode vast knowledge -- how to update them efficiently without destroying this knowledge is a critical question for practical deployment [37, 38, 40].

### Theoretical Foundations

Despite rapid algorithmic progress, the theoretical understanding of continual learning remains limited. Key open questions include: What are the fundamental limits of continual learning? How does the structure of the task sequence affect learnability? Can we prove convergence guarantees for continual learning algorithms? [49]

### Real-World Deployment

Bridging the gap between benchmark performance and real-world deployment requires addressing issues of data imbalance, noisy labels, domain shift, privacy constraints (which may prevent data storage), and computational budgets that vary over time.

## 1.11 Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** Architecture-based continual learning methods are closely related to efficient architecture design. Mixture-of-Experts models, modular networks, and parameter-efficient fine-tuning all serve dual purposes: enabling efficient inference and facilitating continual learning. The sparse activation patterns in MoE models naturally reduce interference between tasks.

**World Models (Chapter 2):** Continual learning is essential for world models that must adapt to changing environments. A robot's world model must update as it encounters new objects, environments, or physical interactions, making catastrophic forgetting a practical concern for model-based reinforcement learning.

**Agentic Search (Chapter 4):** Agents that interact with evolving knowledge bases must continually update their retrieval and reasoning capabilities. Continual learning of retrieval models and knowledge integration in RAG systems connects to the challenge of maintaining search quality as information changes.

**Randomized Algorithms (Chapter 5):** Sketching and hashing techniques from Chapter 5 can be applied to continual learning: compressed replay buffers, random projections for efficient importance estimation, and streaming algorithms for online learning are all relevant connections.

## References

- [1] McCloskey, M. and Cohen, N.J. "Catastrophic Interference in Connectionist Networks: The Sequential Learning Problem." Psychology of Learning and Motivation, 1989.
- [2] Ratcliff, R. "Connectionist Models of Recognition Memory: Constraints Imposed by Learning and Forgetting Functions." Psychological Review, 1990.
- [3] French, R.M. "Catastrophic Forgetting in Connectionist Networks." Trends in Cognitive Sciences, 1999.
- [4] Parisi, G.I., Kemker, R., Part, J.L., Kanan, C., and Wermter, S. "Continual Lifelong Learning with Neural Networks: A Review." Neural Networks, 2019.
- [5] De Lange, M., Aljundi, R., Masana, M., et al. "A Continual Learning Survey: Defying Forgetting in Classification Tasks." IEEE TPAMI, 2021. https://ieeexplore.ieee.org/document/9349197
- [6] Kumaran, D., Hassabis, D., and McClelland, J.L. "What Learning Systems Do Intelligent Agents Need? Complementary Learning Systems Theory Updated." Trends in Cognitive Sciences, 2016.
- [7] Zenke, F., Poole, B., and Ganguli, S. "Continual Learning through Synaptic Intelligence." ICML, 2017.
- [8] van de Ven, G.M. and Tolias, A.S. "Three Scenarios for Continual Learning." NeurIPS Continual Learning Workshop, 2019. arXiv:1904.07734
- [9] Diaz-Rodriguez, N., Lomonaco, V., Filliat, D., and Maltoni, D. "Don't Forget, There is More than Forgetting: New Metrics for Continual Learning." NeurIPS Workshop, 2018.
- [10] Masana, M., Liu, X., Twardowski, B., et al. "Class-Incremental Learning: Survey and Performance Evaluation on Image Classification." IEEE TPAMI, 2023.
- [11] Kirkpatrick, J., Pascanu, R., Rabinowitz, N., et al. "Overcoming Catastrophic Forgetting in Neural Networks." PNAS, 2017.
- [12] Schwarz, J., Czarnecki, W., Luketina, J., et al. "Progress & Compress: A Scalable Framework for Continual Learning." ICML, 2018.
- [13] Zenke, F., Poole, B., and Ganguli, S. "Continual Learning through Synaptic Intelligence." ICML, 2017.
- [14] Li, Z. and Hoiem, D. "Learning without Forgetting." IEEE TPAMI, 2017. https://arxiv.org/abs/1606.09282
- [15] Hinton, G., Vinyals, O., and Dean, J. "Distilling the Knowledge in a Neural Network." NeurIPS Workshop, 2015.
- [16] Aljundi, R., Babiloni, F., Elhoseiny, M., Rohrbach, M., and Tuytelaars, T. "Memory Aware Synapses: Learning What (not) to Forget." ECCV, 2018.
- [17] Hsu, Y.C., Liu, Y.C., Ramasamy, A., and Kira, Z. "Re-evaluating Continual Learning Scenarios: A Categorization and Case for Strong Baselines." NeurIPS CL Workshop, 2018.
- [18] Riemer, M., Cases, I., Ajemian, R., et al. "Learning to Learn without Forgetting by Maximizing Transfer and Minimizing Interference." ICLR, 2019.
- [19] Chaudhry, A., Rohrbach, M., Elhoseiny, M., Ajemian, R., and Piesco, N. "On Tiny Episodic Memories in Continual Learning." arXiv:1902.10486, 2019.
- [20] Lopez-Paz, D. and Ranzato, M. "Gradient Episodic Memory for Continual Learning." NeurIPS, 2017. https://arxiv.org/abs/1706.08840
- [21] Chaudhry, A., Ranzato, M., Rohrbach, M., and Elhoseiny, M. "Efficient Lifelong Learning with A-GEM." ICLR, 2019.
- [22] Buzzega, P., Boschini, M., Porrello, A., Abati, D., and Calderara, S. "Dark Experience for General Continual Learning: a Strong, Simple Baseline." NeurIPS, 2020.
- [23] Shin, H., Lee, J.K., Kim, J., and Kim, J. "Continual Learning with Deep Generative Replay." NeurIPS, 2017.
- [24] Gao, R., et al. "DDGR: Continual Learning with Deep Diffusion-based Generative Replay." ICML, 2023. https://proceedings.mlr.press/v202/gao23e
- [25] Kim, J., et al. "SDDGR: Stable Diffusion-based Deep Generative Replay for Class Incremental Object Detection." CVPR, 2024.
- [26] Galashov, A., et al. "Continually Learning Representations at Scale." CoLLAs, 2023. https://proceedings.mlr.press/v232/galashov23a.html
- [27] Rusu, A.A., Rabinowitz, N.C., Desjardins, G., et al. "Progressive Neural Networks." arXiv:1606.04671, 2016.
- [28] Yoon, J., Yang, E., Lee, J., and Hwang, S.J. "Lifelong Learning with Dynamically Expandable Networks." ICLR, 2018.
- [29] Mallya, A. and Lazebnik, S. "PackNet: Adding Multiple Tasks to a Single Network by Iterative Pruning." CVPR, 2018.
- [30] Serra, J., Suris, D., Miron, M., and Karatzoglou, A. "Overcoming Catastrophic Forgetting with Hard Attention to the Task." ICML, 2018.
- [31] Wortsman, M., Ramanujan, V., Liu, R., et al. "Supermasks in Superposition." NeurIPS, 2020. https://arxiv.org/abs/2006.14769
- [32] Aljundi, R., Chakravarty, P., and Tuytelaars, T. "Expert Gate: Lifelong Learning with a Network of Experts." CVPR, 2017.
- [33] Javed, K. and White, M. "Meta-Learning Representations for Continual Learning." NeurIPS, 2019.
- [34] Beaulieu, S., Frati, L., Miconi, T., et al. "Learning to Continually Learn." ECAI, 2020.
- [35] Gupta, G., Yadav, K., and Paull, L. "La-MAML: Look-ahead Meta Learning for Continual Learning." NeurIPS, 2020. https://papers.nips.cc/paper/2020/hash/85b9a5ac91cd629bd3afe396ec07270a-Abstract.html
- [36] Arani, E., Sarfraz, F., and Zonooz, B. "Learning Fast, Learning Slow: A General Continual Learning Method based on Complementary Learning System Theory." ICLR, 2022.
- [37] Jang, J., Ye, S., Yang, S., et al. "Towards Continual Knowledge Learning of Language Models." ICLR, 2022.
- [38] Scialom, T., et al. "Continual Learning of Large Language Models." EMNLP Tutorials, 2025. https://aclanthology.org/2025.emnlp-tutorials.7/
- [39] Gupta, K., Acting, B., Tay, Y., et al. "Continual Pre-Training of Large Language Models: How to Re-warm Your Model?" ICML Workshop, 2023.
- [40] Ibrahim, A., et al. "Investigating Continual Pretraining in Large Language Models." 2024. https://openreview.net/forum?id=aKjJoEVKgO
- [41] Wu, T., et al. "Mitigating Catastrophic Forgetting in Large Language Models with Self-Distillation." ACL, 2024. https://aclanthology.org/2024.acl-long.77/
- [42] Luo, Y., et al. "An Empirical Study of Catastrophic Forgetting in Large Language Models During Continual Fine-tuning." arXiv:2308.08747, 2023.
- [43] Wang, Z., et al. "Orthogonal Subspace Learning for Language Model Continual Learning." EMNLP Findings, 2023.
- [44] Huang, C., et al. "LoRAMoE: Alleviating World Knowledge Forgetting in Large Language Models via MoE-Style Plugin." ACL, 2024.
- [45] Veniat, T., Denoyer, L., and Ranzato, M. "Efficient Continual Learning with Modular Networks and Task-Driven Priors." ICLR, 2021.
- [46] Lomonaco, V., Pellegrini, L., Cossu, A., et al. "Avalanche: An End-to-End Library for Continual Learning." CLVision Workshop at CVPR, 2021.
- [47] Farquhar, S. and Gal, Y. "Towards Robust Evaluations of Continual Learning." Privacy in Machine Learning Workshop at NeurIPS, 2019.
- [48] Aljundi, R., Kelchtermans, K., and Tuytelaars, T. "Task-Free Continual Learning." CVPR, 2019.
- [49] Evron, I., Moroshko, E., Ward, R., Srebro, N., and Soudry, D. "How Catastrophic Can Catastrophic Forgetting Be in Linear Regression?" COLT, 2022.
