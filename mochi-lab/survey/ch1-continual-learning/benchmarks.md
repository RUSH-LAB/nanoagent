---
sidebar_position: 9
title: "Benchmarks & Evaluation"
---

# Benchmarks & Evaluation

### Standard Benchmarks

The field has converged on several standard benchmarks [@delange2021continual, @vandeven2019three]:

- **Permuted MNIST:** A sequence of tasks where each task applies a different fixed pixel permutation to MNIST images. Now considered too simple for meaningful evaluation.
- **Split-CIFAR-10/100:** CIFAR-10 or CIFAR-100 classes are divided into sequential groups of tasks. Split-CIFAR-100 with 10 or 20 tasks is a common setting.
- **Split-ImageNet:** ImageNet classes divided into sequential tasks. Much more challenging and realistic.
- **Split-TinyImageNet:** A compromise between CIFAR and full ImageNet complexity.

### Newer Benchmarks

- **CTrL (Continual Transfer Learning):** Veniat et al. (2021) [@veniat2021efficient] proposed CTrL, which evaluates continual learning with diverse task types and controlled transfer relationships, going beyond simple splits of a single dataset.
- **CLUE (Continual Language Understanding Evaluation):** Extends continual learning evaluation to NLP tasks, testing sequential learning of different text classification and NLU tasks.
- **Avalanche:** Lomonaco et al. (2021) [@lomonaco2021avalanche] released Avalanche, an end-to-end library and benchmark suite for continual learning that standardizes experimental protocols.

### Evaluation Challenges

Meaningful evaluation of continual learning remains difficult. Farquhar and Gal (2019) [@farquhar2019towards] identified several pitfalls: many evaluations use only class-incremental settings, which disadvantage certain method families; hyperparameter selection often uses the full test set; and the number of tasks is often too small to reveal long-term trends. More recent evaluations have moved toward longer task sequences, more realistic settings, and standardized protocols [@galashov2023continually, @lomonaco2021avalanche].
