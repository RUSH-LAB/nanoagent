---
sidebar_position: 2
title: "Problem Formulation"
---

## Problem Formulation

### FLOP-Accuracy Tradeoffs

The central problem in efficient architecture design is optimizing the Pareto frontier of computational cost versus task performance [@thompson2020computational]. Given a computational budget B (measured in FLOPs, memory, latency, or energy), the goal is to find architecture A* and parameters theta* that maximize performance:

A*, theta* = argmax_{A, theta} Performance(A, theta) subject to Cost(A, theta) <= B

This formulation applies at multiple levels: architecture design (macro choices like layer types), training (how to use the compute budget most effectively), and inference (how to serve predictions cheaply).

### Scaling Laws

Kaplan et al. (2020) [@kaplan2020scaling] and Hoffmann et al. (2022) [@hoffmann2022training] established scaling laws that relate model size, dataset size, and compute budget to performance. The Chinchilla scaling laws [@hoffmann2022training] showed that many models were over-parameterized relative to their training data, leading to a paradigm shift toward training smaller models on more data. Efficient architecture design can be viewed as changing the constants in these scaling laws -- achieving the same performance curve at lower absolute cost.

### Efficiency Metrics

Key metrics for evaluating efficiency include:
- **FLOPs per token** (training and inference)
- **Wall-clock time** (accounting for hardware utilization)
- **Memory footprint** (peak memory, KV-cache size)
- **Throughput** (tokens/second at given batch size)
- **Energy consumption** (kWh per training run or per inference query)
