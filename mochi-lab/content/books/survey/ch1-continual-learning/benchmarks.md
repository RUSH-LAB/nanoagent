---
sidebar_position: 9
title: "Benchmarks & Evaluation"
---

# Benchmarks & Evaluation

### Standard Benchmarks

The field has converged on several standard benchmarks, organized roughly by complexity [@delange2021continual, @vandeven2019three]:

**Image Classification Benchmarks:**
- **Permuted MNIST:** A sequence of tasks where each task applies a different fixed pixel permutation to MNIST images. Now considered too simple for meaningful evaluation, as even naive methods achieve near-perfect accuracy. However, its simplicity makes it useful for rapid prototyping and theoretical analysis. Typically evaluated with 10-20 permutations.
- **Rotated MNIST:** Similar to Permuted MNIST but with rotations instead of permutations, creating a smoother domain shift. Used primarily for Domain-IL evaluation.
- **Split-CIFAR-10/100:** CIFAR-10 or CIFAR-100 classes are divided into sequential groups of tasks. Split-CIFAR-100 with 10 tasks (10 classes each) or 20 tasks (5 classes each) is a common setting. This is the most widely used benchmark for method comparison, though the gap between methods and joint training remains substantial (often 10-20%).
- **Split-TinyImageNet:** 200 classes of 64x64 images divided into sequential tasks. A compromise between CIFAR and full ImageNet complexity, with more realistic visual content.
- **Split-ImageNet:** ImageNet-1K classes divided into sequential tasks (typically 10 tasks of 100 classes). Much more challenging and realistic than CIFAR-based benchmarks. Split-ImageNet-R (using the ImageNet-R dataset with diverse renditions) has become standard for evaluating prompt-based methods.
- **CORe50:** Lomonaco and Maltoni (2017) [@lomonaco2017core50] introduced CORe50, an object recognition benchmark with 50 objects in 11 sessions with different backgrounds and conditions. Designed specifically for evaluating domain-incremental and class-incremental learning with realistic domain shifts.

**NLP Benchmarks:**
- **Continual task sequences from standard NLP benchmarks** (e.g., sequential learning of SuperGLUE tasks) test continual learning in the language domain, where task diversity is much greater than in image classification.
- **Continual pre-training benchmarks** evaluate how well a language model retains general capabilities while learning domain-specific knowledge through continued pre-training [@jang2022towards].

### Benchmarks for Pre-Trained Models

The rise of prompt-based and adapter-based continual learning methods has created demand for benchmarks specifically designed for the pre-trained model setting:

- **Split-ImageNet-R:** ImageNet-R (renditions) with 200 classes split into tasks. This is the standard benchmark for prompt-based methods (L2P, DualPrompt, CODA-Prompt), as the diverse renditions (art, cartoons, sketches) test the robustness of the pre-trained features.
- **Split-CUB-200:** Fine-grained bird classification (200 species) split into sequential tasks. Tests whether pre-trained features support fine-grained discrimination in a continual setting.
- **VTAB Sequence:** Tasks from the Visual Task Adaptation Benchmark presented sequentially, testing continual learning across diverse visual domains (natural, specialized, structured images).

### Comprehensive Benchmark Suites and Libraries

- **CTrL (Continual Transfer Learning):** Veniat et al. (2021) [@veniat2021efficient] proposed CTrL, which evaluates continual learning with diverse task types and controlled transfer relationships, going beyond simple splits of a single dataset. CTrL allows researchers to construct task sequences with known forward and backward transfer properties.
- **Avalanche:** Lomonaco et al. (2021) [@lomonaco2021avalanche] released Avalanche, an end-to-end library and benchmark suite for continual learning that standardizes experimental protocols, data handling, and metric computation. Avalanche supports all major continual learning settings and has been widely adopted.
- **Sequoia:** Normandin et al. (2022) [@normandin2022sequoia] proposed Sequoia, a unified software framework for continual learning research that supports a wider range of settings than Avalanche, including reinforcement learning and unsupervised continual learning.

### Evaluation Challenges and Pitfalls

Meaningful evaluation of continual learning remains difficult. Farquhar and Gal (2019) [@farquhar2019towards] identified several critical pitfalls in continual learning evaluation:

1. **Setting mismatch:** Many papers evaluate only in the easiest setting (Task-IL) and claim general continual learning progress. van de Ven and Tolias (2019) [@vandeven2019three] showed that the relative ranking of methods changes dramatically across settings: EWC, which appears competitive in Task-IL, fails completely in Class-IL.

2. **Hyperparameter selection:** Many evaluations tune hyperparameters using the full test set (or a validation set that includes data from all tasks), leaking information about future tasks. Proper evaluation should tune hyperparameters only on data available at the time of selection.

3. **Number of tasks:** Most evaluations use only 5-20 tasks, which is too few to reveal long-term trends (capacity saturation, buffer management degradation). Methods that work well for 10 tasks may fail completely for 100.

4. **Task ordering:** Results can be sensitive to the order in which tasks are presented, but most papers report results for only a single (often convenient) ordering. Robust evaluation should average over multiple random orderings.

5. **Missing baselines:** Many papers do not compare against simple baselines like well-tuned experience replay, which Chaudhry et al. (2019) [@chaudhry2019tiny] showed to be surprisingly competitive.

6. **Pre-training confound:** For methods using pre-trained models, the pre-training dataset may overlap with or contain the benchmark data. Evaluations should carefully control for this [@kim2023achieving].

More recent evaluations have moved toward longer task sequences, more realistic settings, standardized protocols, and comprehensive baselines [@galashov2023continually, @lomonaco2021avalanche, @boschini2022class]. The field is gradually converging on best practices, but there is still no universally accepted evaluation protocol.
