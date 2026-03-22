---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

Continual learning methods can be organized into four major families [@parisi2019continual, @delange2021continual, @masana2023class]:

1. **Regularization-based methods** add penalty terms to the loss function that discourage changes to parameters important for previous tasks.
2. **Replay-based methods** store or generate exemplars from previous tasks and interleave them with new task data during training.
3. **Architecture-based methods** allocate dedicated parameters or subnetworks for each task, preventing interference by design.
4. **Meta-learning-based methods** learn to learn continually, optimizing for the ability to quickly adapt to new tasks while retaining old knowledge.

These families are not mutually exclusive; many state-of-the-art methods combine elements from multiple families. For instance, a method might use replay with regularization, or architecture expansion with meta-learning.
