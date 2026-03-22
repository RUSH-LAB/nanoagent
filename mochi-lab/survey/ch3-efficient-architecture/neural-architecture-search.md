---
sidebar_position: 6
title: "Neural Architecture Search"
---

## Neural Architecture Search

Neural Architecture Search (NAS) automates the design of neural network architectures, potentially discovering designs that human engineers would not consider [@elsken2019neural].

### DARTS

Liu et al. (2019) [@liu2019darts] proposed DARTS (Differentiable Architecture Search), which relaxes the discrete architecture search space to be continuous, enabling gradient-based optimization. DARTS jointly optimizes architecture parameters and model weights using bilevel optimization, reducing search cost from thousands of GPU-days to a single GPU-day.

### EfficientNet

Tan and Le (2019) [@tan2019efficientnet] used NAS to discover EfficientNet, a family of models that uniformly scale width, depth, and resolution using a compound scaling coefficient. EfficientNet-B7 achieved state-of-the-art ImageNet accuracy while being 8.4x smaller and 6.1x faster than the best existing models.

### Once-for-All (OFA)

Cai et al. (2020) [@cai2020onceforall] proposed Once-for-All networks, which train a single large network that supports many sub-networks of different sizes. At deployment time, the appropriate sub-network is selected based on hardware constraints without retraining. This amortizes the NAS cost and enables efficient deployment across diverse hardware.

### Hardware-Aware NAS

Modern NAS increasingly incorporates hardware constraints directly into the search objective [@benmeziane2021comprehensive, @li2022neural]. Rather than optimizing only for accuracy, hardware-aware NAS optimizes for latency, energy consumption, or throughput on specific target devices. This has produced architectures like MobileNet v3 and EfficientNet-EdgeTPU that are specifically tailored for mobile and edge deployment.
