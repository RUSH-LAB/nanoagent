---
sidebar_position: 2
title: "Problem Formulation"
---

# Problem Formulation

This section focuses on supervised continual learning for image classification, where the model learns a sequence of classification tasks over time. We do not cover continual reinforcement learning or continual self-supervised learning, which present distinct challenges and evaluation protocols.

### Task Settings

Continual learning problems are typically categorized into three principal settings, following the taxonomy of van de Ven and Tolias (2019) [@vandeven2019three], later extended by van de Ven et al. (2022) [@vandeven2022three_types]:

**Task-Incremental Learning (Task-IL):** The model learns a sequence of tasks T_1, T_2, ..., T_N, and at test time is told which task a given sample belongs to. This is the easiest setting, as the model can maintain task-specific output heads and only needs to avoid forgetting shared representations. Most regularization-based methods perform well in this setting, achieving near-zero forgetting when task identity is available [@kirkpatrick2017overcoming, @zenke2017continual, @vandeven2019three, @hsu2018reevaluating].

**Class-Incremental Learning (Class-IL):** The model must learn to distinguish among all classes seen so far, without being told which task a test sample comes from. This is significantly harder, as the model must solve both a within-task and a cross-task classification problem. Class-IL has emerged as the most practically relevant and challenging setting, as real-world classifiers rarely have access to task identity at inference. Many methods that excel in Task-IL fail dramatically in Class-IL [@masana2023class, @vandeven2019three]. The class-incremental setting exposes a key challenge: the model must not only avoid forgetting old class representations but must also maintain a calibrated decision boundary across all classes seen so far, a problem that goes beyond mere representation preservation.

**Domain-Incremental Learning (Domain-IL):** The task structure (input-output mapping type) remains the same, but the input distribution shifts over time. For example, a sentiment classifier trained on product reviews must also handle movie reviews without performance degradation. Domain-IL is relevant for deployed models facing distribution shift, such as autonomous driving systems encountering new weather conditions or geographic regions.

**Online Continual Learning:** Beyond these three settings, an increasingly studied paradigm is online continual learning, where data arrives in a stream and each sample may be seen only once (single-pass) [@aljundi2019online, @caccia2022new]. This is significantly more challenging than the offline (multi-epoch) setting assumed by most methods, as the model cannot iterate over the current task's data. Online continual learning is arguably the most realistic setting, as it reflects how data arrives in deployed systems.

**Blurry Task Boundaries:** While most formulations assume clear task boundaries (the model is told when one task ends and another begins), real-world data streams often have gradual distribution shifts without explicit task demarcation. Task-free or task-agnostic continual learning [@aljundi2019taskfree, @lee2020neural_cl] addresses this more realistic but substantially harder setting.

### Formal Framework

Consider a sequence of T tasks, where each task t provides a dataset D_t = {(x_i^t, y_i^t)}. The goal is to learn parameters theta that minimize the expected loss across all tasks seen so far:

min_theta sum_{t=1}^{T} E_{(x,y) ~ D_t} [L(f_theta(x), y)]

subject to constraints on memory, compute, and access to previous task data (which is typically unavailable or limited).

The key tension lies in the constraints. If all data from all tasks were available simultaneously (the "joint training" or "multitask learning" upper bound), standard training would suffice. Continual learning becomes a distinct problem precisely because: (1) data from previous tasks is typically unavailable or severely limited, (2) computational budget may not permit retraining from scratch, and (3) the model must perform well on all tasks seen so far at any point during learning, not just at the end.

### The Stability-Plasticity Spectrum

The core challenge of continual learning can be understood as navigating the **stability-plasticity spectrum** [@grossberg1980how, @mermillod2013stability]. At one extreme, a completely stable model (frozen after initial training) achieves zero forgetting but zero plasticity: it cannot learn new tasks. At the other extreme, a completely plastic model (standard fine-tuning) maximizes learning on new tasks but catastrophically forgets old ones. Every continual learning method can be understood as proposing a particular balance point on this spectrum, and different methods implicitly favor different tradeoffs [@delange2021continual].

### Evaluation Metrics

The field has converged on several standard metrics, with Average Accuracy, Backward Transfer, and Forward Transfer originating from Lopez-Paz and Ranzato (2017) [@lopezpaz2017gradient, @delange2021continual, @diaz2018dont]:

- **Average Accuracy (AA):** Mean accuracy across all tasks after the final task is learned: AA = (1/T) * sum_{i=1}^{T} a_{T,i}, where a_{T,i} is the accuracy on task i after training on all T tasks.
- **Backward Transfer (BWT):** Measures how much learning new tasks affects performance on old tasks: BWT = (1/(T-1)) * sum_{i=1}^{T-1} (a_{T,i} - a_{i,i}). Negative BWT indicates forgetting. A method with BWT = 0 exhibits zero forgetting.
- **Forward Transfer (FWT):** Measures how much learning earlier tasks helps performance on future tasks: FWT = (1/(T-1)) * sum_{i=2}^{T} (a_{i-1,i} - b_i), where b_i is the accuracy of a randomly initialized model on task i. Positive FWT indicates knowledge transfer.
- **Average Incremental Accuracy (AIA):** The average of average accuracies computed after each task is learned: AIA = (1/T) * sum_{t=1}^{T} AA_t. This metric captures performance throughout the learning process, not just at the end, and is particularly important for deployed systems that must perform well at all times.
- **Forgetting Measure (FM):** The average maximum forgetting across tasks: FM = (1/(T-1)) * sum_{i=1}^{T-1} max_{t in {i,...,T-1}} (a_{t,i} - a_{T,i}). This captures the worst-case forgetting for each task [@chaudhry2018riemannian].
- **Learning Accuracy (LA):** The average accuracy on each task immediately after learning it: LA = (1/T) * sum_{i=1}^{T} a_{i,i}. This measures how effectively the model learns new tasks: a high LA with low BWT indicates a method that learns well without forgetting.

The relationship between these metrics reveals important tradeoffs. A method that maximizes AA by simply freezing the model after the first task would have zero forgetting but poor plasticity. Conversely, naive fine-tuning typically achieves high learning accuracy but catastrophic backward transfer. The ideal method achieves high AA through both high LA (plasticity) and low forgetting (stability).
