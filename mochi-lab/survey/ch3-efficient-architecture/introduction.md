---
sidebar_position: 1
title: "Introduction & Motivation"
---

## Introduction & Motivation

The scaling paradigm that has driven the deep learning revolution -- larger models, more data, more compute -- is approaching fundamental limits. Training frontier language models now costs tens of millions of dollars, consumes megawatt-hours of electricity, and requires months on thousands of accelerators [@kaplan2020scaling, @hoffmann2022training]. Inference costs scale with user demand, making deployment of large models prohibitively expensive for many applications. The environmental impact of this trajectory is increasingly scrutinized [@strubell2019energy].

Efficiency in AI architecture design has thus become a first-class objective, no longer a secondary concern to be addressed after accuracy is maximized. The goal is to achieve the same or better performance with fewer FLOPs, less memory, lower latency, or reduced energy consumption. This encompasses a broad spectrum of approaches: from fundamental architectural innovations that reduce the computational complexity of attention mechanisms, to engineering techniques for efficient training and inference, to automated methods for discovering efficient architectures.

This chapter surveys the landscape of efficient architecture design, organized by technique family. We cover efficient attention mechanisms and sub-quadratic alternatives to the Transformer, Mixture-of-Experts models, neural architecture search, model compression, training efficiency, inference optimization, and the rapidly evolving family of state space models. The goal is to provide a comprehensive map of the field that connects theoretical advances to practical deployment considerations.
