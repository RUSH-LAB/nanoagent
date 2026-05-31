---
sidebar_position: 4
title: "Regularization Methods"
---

# Regularization Methods

Regularization-based approaches constrain weight updates to preserve knowledge encoded in parameters deemed important for previous tasks. This family can be subdivided into two categories: **weight regularization** methods that directly penalize changes to important parameters, and **functional regularization** methods that constrain the model's input-output behavior rather than its parameters.

## Weight Regularization

### Elastic Weight Consolidation (EWC)

Kirkpatrick et al. (2017) [@kirkpatrick2017overcoming] proposed EWC, drawing inspiration from synaptic consolidation in neuroscience. The key insight is that not all parameters are equally important for a given task: some encode critical task knowledge while others can be safely modified. EWC adds a quadratic penalty to the loss function that penalizes changes to parameters proportional to their estimated importance for previous tasks:

L_total = L_new(theta) + (lambda / 2) * sum_i F_i * (theta_i - theta_i^*)^2

where F_i is the diagonal of the Fisher information matrix (approximating parameter importance) and theta_i^* are the optimal parameters for the previous task. The Fisher information matrix captures how sensitive the model's output distribution is to each parameter: parameters with high Fisher information are those whose modification would substantially alter the model's predictions, and thus should be protected.

EWC demonstrated that selective parameter protection could substantially mitigate forgetting on sequential Atari game learning, for instance retaining performance on a previously learned game while learning a new one. The method is elegant in its simplicity and connects to a rich theory of natural gradient methods in optimization.

**Key limitations:** (1) The diagonal Fisher is a crude approximation of the full Fisher information matrix, which is prohibitively expensive to store and compute. This approximation ignores parameter interactions, which can be critical. (2) The quadratic penalty assumes a Gaussian posterior over parameters centered at the previous optimum, which becomes increasingly inaccurate as the number of tasks grows. (3) The Fisher information is computed at a single point (the optimum for the previous task), but importance may change as the model moves through parameter space.

**Online EWC** [@schwarz2018progress] addresses the growing memory cost (storing one Fisher matrix per task) by maintaining a running sum of Fisher information matrices rather than storing one per task. This reduces the storage from O(T * |theta|) to O(|theta|) while still approximating the cumulative importance of parameters across all tasks.

### Synaptic Intelligence (SI)

Zenke et al. (2017) [@zenke2017continual] proposed Synaptic Intelligence (SI), which computes parameter importance online during training rather than post-hoc. While EWC estimates importance at the end of training on each task (a single snapshot), SI tracks the contribution of each parameter to the loss reduction along the entire training trajectory. Specifically, SI accumulates the "path integral" of the gradient for each parameter throughout training:

omega_i = sum_t (delta_i(t) * (theta_i(t) - theta_i(t-1))) / (Delta theta_i^2 + epsilon)

where delta_i(t) is the gradient and the numerator tracks how much each parameter contributed to loss reduction. This yields an importance measure that is both cheaper to compute and arguably more representative than the Fisher-based approximation of EWC, as it captures importance across the entire optimization trajectory rather than at a single point.

Empirical comparisons in the proposing paper report that SI and EWC perform comparably on standard benchmarks, with SI being more memory-efficient since importance is accumulated online without storing additional matrices per task [@zenke2017continual]. Independent benchmarks broadly corroborate that the two weight-regularization methods land in a similar accuracy range, while also showing that both trail rehearsal-based approaches in class-incremental settings [@masana2023class]. Both methods share the fundamental limitation of capacity saturation.

### Riemannian Walk (RWalk)

Chaudhry et al. (2018) [@chaudhry2018riemannian] proposed RWalk, which unifies EWC and SI by combining the Fisher information (local curvature) with the path integral (trajectory-based importance). RWalk also introduced the forgetting measure, defined for each task as the difference between the maximum accuracy attained on that task at any earlier step and its accuracy after the final task, averaged across tasks (so that higher values indicate more forgetting), and provided a more principled comparison of regularization methods. The key finding was that combining both sources of importance information (the Fisher's snapshot at the optimum and SI's trajectory-based accumulation) yields better estimates than either alone.

### Memory Aware Synapses (MAS)

Aljundi et al. (2018) [@aljundi2018memory] proposed MAS, which estimates parameter importance based on the sensitivity of the learned function (rather than the loss) to parameter changes. The importance is computed as the magnitude of the gradient of the output with respect to each parameter, averaged over the data:

Omega_i = (1/N) * sum_n |grad_{theta_i} ||F(x_n; theta)||_2^2|

This is a crucial distinction from EWC: while EWC's Fisher information measures sensitivity of the loss (and thus requires labels), MAS measures sensitivity of the model's output (and can be computed in an unsupervised manner). This makes MAS task-agnostic and applicable in settings where task boundaries are unclear or labels are unavailable.

## Functional Regularization

### Learning without Forgetting (LwF)

Li and Hoiem (2017) [@li2017learning] introduced LwF, which uses knowledge distillation [@hinton2015distilling] to preserve the behavior of the network on old tasks while learning new ones. Rather than constraining parameters directly (which makes assumptions about the geometry of parameter space), LwF constrains the network's input-output behavior: when training on new task data, it minimizes a distillation loss that encourages the network to produce the same outputs as the old model on the new task's inputs:

L_total = L_new(theta) + alpha * L_distill(f_theta(x), f_{theta_old}(x))

where f_{theta_old} is the model snapshot before learning the new task. The distillation loss uses soft targets (softmax outputs with temperature scaling), which carry richer information than hard labels: specifically, they encode the model's uncertainty and inter-class relationships.

LwF requires no stored raw exemplars from previous tasks, making it memory-efficient. However, it assumes that new task data is somewhat representative of previous input distributions: if the new data distribution is very different from previous tasks, the distillation targets may not accurately reflect the old model's behavior on its original data. Despite this limitation, the functional regularization paradigm introduced by LwF has been enormously influential, forming a key component of many subsequent methods including DER++ [@buzzega2020dark], FOSTER [@wang2022foster], and LUCIR [@hou2019learning].

### Less-Forgetting Learning and Encoder-Based Distillation

Less-Forgetting Learning [@jung2016less] preceded LwF and proposed a simpler form of functional regularization by constraining intermediate representations rather than final outputs. This idea was later refined in methods like PODNet [@douillard2020podnet], which applies pooled distillation across multiple spatial levels of a convolutional network, capturing both local and global feature statistics. PODNet reports that this multi-scale distillation improves over output-level distillation alone, with the gap reported as most pronounced for long task sequences in class-incremental learning [@douillard2020podnet].

## Bias Correction in Class-Incremental Learning

The methods below are sometimes grouped with regularization because they build on knowledge distillation, but they address a different organizing principle: they are post-hoc classifier calibration techniques that correct the bias of the final classification layer toward recently seen classes. Unlike functional regularizers such as LwF, these methods are rehearsal-adjacent and generally assume access to a small set of stored exemplars (or a held-out balanced subset) for old classes.

### LUCIR

Hou et al. (2019) [@hou2019learning] identified a critical problem in class-incremental learning: the model's classifier becomes biased toward recently learned classes because they dominate the training data. LUCIR (Learning a Unified Classifier Incrementally via Rebalancing) addresses this through three mechanisms: (1) cosine normalization of the classifier to remove the magnitude bias, (2) less-forget constraint that preserves the orientation of feature vectors, and (3) inter-class separation to maintain discrimination between old and new classes. LUCIR highlighted that continual learning requires not just preventing forgetting of features but also maintaining a balanced classification boundary.

### BiC: Bias Correction

Wu et al. (2019) [@wu2019large_bic] proposed BiC (Bias Correction), which explicitly corrects the classifier bias toward new classes by learning a small linear transformation on the output logits using a held-out validation set. Despite its simplicity (just two scalar parameters per incremental step), BiC reports improved class-incremental performance, with the reported gains largest on benchmarks with many incremental steps and large numbers of classes [@wu2019large_bic]. This work demonstrated that a significant portion of the accuracy drop in class-incremental learning comes from classifier bias rather than feature forgetting, a finding that influenced many subsequent methods.

### WA: Weight Alignment

Zhao et al. (2020) [@zhao2020maintaining_wa] proposed WA (Weight Alignment), which corrects the bias in class-incremental learning by aligning the norms of the weight vectors for old and new classes in the final classification layer. After training on a new task, WA normalizes the classifier weights so that old and new classes have comparable norms. This simple post-hoc correction, applied after standard fine-tuning with knowledge distillation, is reported to be competitive with prior bias-correction methods while adding minimal overhead [@zhao2020maintaining_wa].

## Limitations of Regularization Approaches

Regularization methods share a fundamental limitation: as the number of tasks grows, the feasible region of parameter space that satisfies all constraints shrinks, eventually leaving insufficient capacity for new learning [@hsu2018reevaluating]. This phenomenon, sometimes called **capacity saturation**, means regularization methods tend to degrade on long task sequences. Geometrically, each new task adds constraints that restrict the feasible region, and eventually there is no point in parameter space that simultaneously satisfies all constraints well.

Additionally, weight regularization methods generally struggle with **class-incremental learning**, where task identity is not provided at test time [@vandeven2019three]. Without task identity, the model cannot route to task-specific output heads, and the regularization constraints alone are insufficient to maintain a global classification boundary. Functional regularization methods (LwF and descendants) fare better in Class-IL but still face the fundamental challenge of maintaining calibrated decision boundaries across an ever-growing set of classes.

A practical issue is **hyperparameter sensitivity**: the regularization strength lambda requires careful tuning and may need to change across tasks. Too strong regularization prevents new learning; too weak allows forgetting. This balance is difficult to set a priori and may vary across tasks [@delange2021continual].

## Scope and Currency

This chapter focuses on the classical regularization and bias-correction methods (roughly spanning 2016 to 2022) that established the conceptual foundations of regularization-based continual learning. It does not cover the more recent line of work on prompt-based and parameter-efficient continual learning, nor continual learning for large language models and other foundation models, where pretrained representations and adapter or prompt tuning change many of the assumptions behind weight and functional regularization. Those developments are treated separately; a recent comprehensive survey [@wang2024comprehensive] should be consulted for an up-to-date picture of the field.
