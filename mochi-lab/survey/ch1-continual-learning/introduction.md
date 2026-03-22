---
sidebar_position: 1
title: "Introduction & Motivation"
---

# Introduction & Motivation

Biological neural systems learn continuously throughout their lifetime, seamlessly integrating new knowledge without destroying what was previously learned. Artificial neural networks, by contrast, suffer from **catastrophic forgetting** (also called catastrophic interference) -- the tendency to abruptly lose performance on previously learned tasks when trained on new data [@mccloskey1989catastrophic, @ratcliff1990connectionist]. This phenomenon, first identified by McCloskey and Cohen (1989) [@mccloskey1989catastrophic] and later formalized by French (1999) [@french1999catastrophic], remains one of the central obstacles to building AI systems that can learn and adapt over time.

Continual learning (CL), also referred to as lifelong learning or incremental learning, seeks to endow neural networks with the ability to learn from a non-stationary stream of data, accumulating knowledge over time while maintaining performance on earlier tasks [@parisi2019continual, @delange2021continual]. The importance of this capability cannot be overstated: real-world deployment scenarios -- from autonomous vehicles encountering new road conditions to medical AI systems facing evolving disease patterns -- fundamentally require models that adapt without retraining from scratch.

The field has experienced a renaissance driven by three converging forces. First, the deployment of large-scale AI systems has made the cost of full retraining prohibitive. Second, the success of foundation models has raised questions about how to update these models with new knowledge without degrading existing capabilities. Third, neuroscience research on synaptic consolidation and complementary learning systems has inspired new algorithmic approaches [@kumaran2016what, @zenke2017continual].

This chapter provides a comprehensive review of continual learning methods, organized by algorithmic family rather than chronologically. We cover regularization-based, replay-based, and architecture-based approaches, as well as the emerging intersection of continual learning with large language models. We discuss standard benchmarks and evaluation protocols, and conclude with open problems and connections to other chapters in this survey.
