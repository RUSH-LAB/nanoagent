---
sidebar_position: 2
title: "Problem Formulation"
---

# Problem Formulation

### Task Settings

Continual learning problems are typically categorized into three settings, following the taxonomy of van de Ven and Tolias (2019) [@vandeven2019three]:

**Task-Incremental Learning (Task-IL):** The model learns a sequence of tasks T_1, T_2, ..., T_N, and at test time is told which task a given sample belongs to. This is the easiest setting, as the model can maintain task-specific output heads and only needs to avoid forgetting shared representations.

**Class-Incremental Learning (Class-IL):** The model must learn to distinguish among all classes seen so far, without being told which task a test sample comes from. This is significantly harder, as the model must solve both a within-task and a cross-task classification problem.

**Domain-Incremental Learning (Domain-IL):** The task structure (input-output mapping type) remains the same, but the input distribution shifts over time. For example, a sentiment classifier trained on product reviews must also handle movie reviews without performance degradation.

### Formal Framework

Consider a sequence of T tasks, where each task t provides a dataset D_t = {(x_i^t, y_i^t)}. The goal is to learn parameters theta that minimize the expected loss across all tasks seen so far:

min_theta sum_{t=1}^{T} E_{(x,y) ~ D_t} [L(f_theta(x), y)]

subject to constraints on memory, compute, and access to previous task data (which is typically unavailable or limited).

### Evaluation Metrics

The field has converged on several standard metrics [@delange2021continual, @diaz2018dont]:

- **Average Accuracy (AA):** Mean accuracy across all tasks after the final task is learned.
- **Backward Transfer (BWT):** Measures how much learning new tasks affects performance on old tasks. Negative BWT indicates forgetting.
- **Forward Transfer (FWT):** Measures how much learning earlier tasks helps performance on future tasks.
- **Average Incremental Accuracy:** The average of average accuracies computed after each task is learned.
