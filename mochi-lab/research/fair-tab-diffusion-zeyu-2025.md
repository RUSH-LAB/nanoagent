---
slug: fair-tab-diffusion-zeyu-2025
title: "Balanced Mixed-Type Tabular Data Synthesis with Diffusion Models"
authors: [zeyu]
tags: [diffusion, fairness, tabular-data, ai-safety]
date: 2025-04-12
---

**Zeyu Yang**, Han Yu, Peikun Guo, Khadija Zanna, Xiaoxue Yang, Akane Sano

*Transactions on Machine Learning Research (TMLR), 2025*

[[arXiv]](https://arxiv.org/abs/2404.08254) [[OpenReview]](https://openreview.net/forum?id=dvRysCqmYQ) [[Code]](https://github.com/comp-well-org/fair-tab-diffusion)

<!-- truncate -->

## Overview

Diffusion models have emerged as a robust framework for various generative tasks, including tabular data synthesis. However, current tabular diffusion models tend to inherit bias in the training dataset and generate biased synthetic data, which may influence discriminatory actions. In this work, we introduce a novel tabular diffusion model that incorporates **sensitive guidance** to generate fair synthetic data with balanced joint distributions of the target label and sensitive attributes, such as sex and race.

## Key Contributions

1. **Fairness-Aware Diffusion Model**: We propose a tabular diffusion framework that explicitly accounts for sensitive attributes during the generation process, producing synthetic data with balanced joint distributions across demographic groups.

2. **Sensitive Guidance Mechanism**: We introduce a guidance strategy that steers the diffusion process to ensure equitable representation across sensitive attributes (e.g., sex, race) and target labels, without sacrificing data quality.

3. **Mixed-Type Data Handling**: Our method handles the unique challenges of tabular data — mixed continuous and categorical features — within a unified diffusion framework.

## Results

Our approach demonstrates strong performance on fairness and data quality:

- Over **10% improvement** on fairness metrics including demographic parity ratio and equalized odds ratio compared to existing methods
- **Maintained data quality** of generated samples despite fairness constraints
- Outperforms existing tabular data synthesis methods across multiple benchmarks

## Why It Matters

Synthetic data is increasingly used for training ML models, augmenting limited datasets, and sharing data under privacy constraints. If the synthetic data generator inherits and amplifies biases from the training data, downstream models will perpetuate discriminatory outcomes. This work provides a principled approach to generating fair synthetic tabular data, making it relevant for applications in healthcare, finance, hiring, and other domains where algorithmic fairness is critical.
