---
sidebar_position: 7
title: "Agentic Web Search"
---

## Agentic Web Search

The web is the richest information source available to AI systems, but interacting with it requires navigating complex, visually rendered pages with diverse layouts, forms, and interactive elements. Agentic web search goes beyond simple API-based retrieval: the agent must browse web pages, interpret their content, interact with forms and buttons, and extract relevant information from visually complex layouts. This setting tests the full range of agent capabilities: perception, reasoning, planning, and action.

### WebArena

Zhou et al. (2024) [@zhou2024webarena] introduced WebArena, a realistic web-based benchmark for evaluating autonomous web agents. WebArena provides self-hosted, fully functional websites covering e-commerce (shopping), social forums (Reddit-like), content management (GitLab), maps, and knowledge bases (Wikipedia-like). Tasks require complex web interactions: "Find the cheapest office chair with 4+ star rating and add it to the cart" or "Create a new repository on GitLab with a specific configuration."

State-of-the-art LLM agents (GPT-4) achieve only ~15% task success rate on WebArena, highlighting the substantial gap between current agent capabilities and human-level web browsing proficiency. Earlier work on WebShop (Yao et al., 2022) [@yao2022webshop] demonstrated that web-based shopping tasks could serve as a testbed for grounded language agents, finding that even in a simplified web environment, agents struggle with exploration and long-horizon planning. The difficulty lies not in individual web actions but in the **planning and error recovery** required for multi-step web interactions: agents must navigate complex page layouts, handle dynamic content, recover from wrong turns, and maintain coherent task state across many steps.

### BrowserGym and VisualWebArena

**BrowserGym** (Drouin et al., 2024) [@drouin2024browsergym] proposed a unified ecosystem for web agent research that standardizes the observation and action spaces across multiple web benchmarks (WebArena, VisualWebArena, WorkArena, etc.). BrowserGym provides a gym-like interface for training and evaluating web agents, enabling systematic comparison of different agent architectures, observation representations, and training methods.

**VisualWebArena** (Koh et al., 2024) [@koh2024visualwebarena] extended WebArena with tasks that require visual understanding -- interpreting images, charts, and visual layouts to complete tasks. This tests whether agents can operate on the web as humans do (visually) rather than relying on structured HTML/DOM representations. Current vision-language model agents perform significantly worse on visual tasks than on text-based tasks, indicating that visual web understanding remains a key challenge.

### Mind2Web

Deng et al. (2024) [@deng2024mind2web] introduced Mind2Web, a benchmark and dataset for training generalist web agents. Mind2Web covers 2,000+ tasks across 137 real-world websites with diverse designs and functionalities, providing HTML snapshots and human action traces. Unlike simulated environments, Mind2Web uses real websites, capturing the complexity and diversity of the actual web. The dataset enables training models that generalize across websites, rather than overfitting to a specific site's structure.

### Agent Architectures for Web Browsing

Web browsing agents typically combine an LLM "brain" with a browser tool that can navigate pages, click elements, fill forms, scroll, and extract content. Key architectural design choices include:

**Observation representation:** How the web page is presented to the LLM. Options include raw HTML (comprehensive but verbose), simplified DOM trees (more compact but may lose information), accessibility trees (structured and standard), screenshots (visual but requiring vision capabilities), and hybrid representations. The choice of representation significantly affects agent performance: simplified, structured representations generally outperform raw HTML due to reduced context length and noise.

**Action space design:** Low-level actions (click at coordinates, type text) vs. high-level actions (click on element with description, fill form field named X). Higher-level action spaces are easier for the LLM to use but may not cover all possible interactions.

**WebVoyager** (He et al., 2024) [@he2024webvoyager] demonstrated a vision-based web agent that uses screenshots as observations and generates actions based on visual understanding. This approach is more robust to DOM changes (which frequently break text-based agents) but requires strong vision-language capabilities.

**Planning strategies:** Reactive agents (act based on current observation) vs. deliberative agents (plan multiple steps ahead). Deliberative agents generally perform better on complex tasks but are slower and more expensive. Recent work explores hierarchical planning, where a high-level planner decomposes the task into sub-goals and a low-level executor handles individual web interactions.

### GAIA: General AI Assistants

Mialon et al. (2024) [@mialon2024gaia] introduced GAIA, a benchmark designed to evaluate general AI assistants that must use multiple tools (web search, code execution, file manipulation) and multi-step reasoning to answer complex questions. GAIA tasks are specifically designed to be easy for humans (who achieve 92% accuracy) but difficult for AI systems (GPT-4 with plugins achieves ~15% accuracy), highlighting the gap between current AI capabilities and human-level tool use and reasoning. GAIA has become a standard benchmark for evaluating the overall capability of agentic systems.

### Computer-Use Agents

A frontier direction extends web browsing to general computer use: agents that can operate any software through GUI interactions (mouse clicks, keyboard input, screen reading). **Claude Computer Use** (Anthropic, 2024) [@anthropic2024claude_computer] and similar systems allow LLMs to control desktop applications, navigating software UIs, manipulating files, and completing tasks across applications. This represents the most general form of agentic interaction, where the agent has the same interface to the digital world as a human user.

**OS-World** (Xie et al., 2024) [@xie2024osworld] introduced a benchmark for evaluating computer-use agents across real operating systems (Ubuntu, Windows, macOS), requiring agents to complete tasks involving file management, software installation, web browsing, and multi-application workflows. OS-World tasks are substantially harder than web-only benchmarks because they require understanding of OS-level concepts (file systems, permissions, application interactions) and handling diverse GUIs. Current best agents achieve only ~12% task completion on OS-World, compared to ~72% for humans, highlighting the enormous gap remaining in general computer use.

**AgentBench** (Liu et al., 2024) [@liu2024agentbench] provides a multi-dimensional evaluation of LLM agents across 8 diverse environments: operating systems, databases, knowledge graphs, digital card games, lateral thinking puzzles, household environments, web shopping, and web browsing. AgentBench revealed that GPT-4 substantially outperforms open-source models on agentic tasks, even when open-source models are competitive on standard NLP benchmarks, suggesting that agentic capability requires something beyond general language understanding. The o1 reasoning model (OpenAI, 2024) [@openai2024o1] demonstrates that extended chain-of-thought reasoning can substantially improve agent performance on complex tasks requiring multi-step planning and tool use.
