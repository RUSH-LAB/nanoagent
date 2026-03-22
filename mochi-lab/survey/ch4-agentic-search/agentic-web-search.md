---
sidebar_position: 7
title: "Agentic Web Search"
---

## Agentic Web Search

### WebArena

Zhou et al. (2024) [@zhou2024webarena] introduced WebArena, a realistic web-based benchmark for evaluating autonomous web agents. WebArena provides self-hosted websites (shopping, forums, maps, GitLab) with hundreds of tasks requiring complex web interactions. State-of-the-art LLM agents (GPT-4) achieve only ~15% success rate, highlighting the substantial gap between current capabilities and human-level web browsing proficiency.

### BrowserGym

Drouin et al. (2024) [@drouin2024browsergym] proposed BrowserGym, a unified ecosystem for web agent research that standardizes the observation and action spaces across multiple web benchmarks. BrowserGym provides a gym-like interface for training and evaluating web agents, enabling systematic comparison of different agent architectures and training methods.

### Mind2Web

Deng et al. (2024) [@deng2024mind2web] introduced Mind2Web, a benchmark and dataset for training generalist web agents. Mind2Web covers 2,000+ tasks across 137 real-world websites, providing HTML snapshots and human action traces. Unlike simulated environments, Mind2Web uses real websites, capturing the complexity and diversity of the actual web.

### Agent Architectures for Web Browsing

Web browsing agents typically combine an LLM "brain" with a browser tool that can navigate pages, click elements, fill forms, and extract content. Key architectural choices include: observation representation (raw HTML, accessibility tree, screenshots), action space design (low-level clicks vs. high-level instructions), and planning strategies (reactive vs. deliberative) [@zheng2023judging, @he2024webvoyager].
