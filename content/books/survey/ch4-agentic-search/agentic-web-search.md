---
sidebar_position: 7
title: "Agentic Web Search"
---

## Agentic Web Search

The web is the richest information source available to AI systems, but interacting with it requires navigating complex, visually rendered pages with diverse layouts, forms, and interactive elements. Agentic web search goes beyond simple API-based retrieval: the agent must browse web pages, interpret their content, interact with forms and buttons, and extract relevant information from visually complex layouts. This setting tests the full range of agent capabilities: perception, reasoning, planning, and action.

### Problem Formulation and Scope

Agentic web browsing can be cast as a partially observable sequential decision process. At each step the agent receives an **observation** of the current page (rendered as HTML, a DOM or accessibility tree, a screenshot, or a hybrid of these), selects an **action** from a browser or GUI action space (click, type, scroll, navigate, submit a form), and transitions to a new page **state**. The episode terminates when the task goal is reached or a budget is exhausted, and **success** is typically measured as exact task completion (the target state is achieved) rather than partial credit. This framing extends the general sequential-decision formulation of Section 4.2 to an environment whose state is a live, visually rendered document rather than a text corpus.

**Scope.** This section covers settings where the agent must *operate a rendered interface*: browse pages, interpret layouts, and act on interactive elements. It deliberately excludes retrieval-augmented generation (covered in Section 4.3) and pure API-based tool use (Section 4.4), where the agent receives clean structured returns and never interacts with a GUI. The boundary is the observation modality: if the agent's effective interface is an API response, it falls under tool-augmented retrieval; if the agent's interface is a page or screen it must perceive and manipulate, it falls in scope here. The frontier of this scope is full computer use, where the "page" becomes the entire desktop.

The benchmarks below trace a progression along two axes: the **environment** (simulated sites, the open real web, or a full operating system) and the **observation modality** (text or DOM, visual, or mixed GUI). The table summarizes the headline human-versus-agent gap that motivates the section.

| Benchmark | Environment | Tasks | Observation modality | Agent vs. human |
|---|---|---|---|---|
| WebArena | Self-hosted simulated sites | ~812 | Text / DOM | 14.41% (GPT-4) vs. 78.24% |
| VisualWebArena | Self-hosted simulated sites | ~910 | Visual | below text-DOM agents |
| Mind2Web | Real websites | 2,000+ | HTML + action traces | n/a (offline traces) |
| GAIA | Tool use + web | ~466 | Mixed | 15% (GPT-4) vs. 92% |
| OSWorld | Full operating system | ~369 | GUI screenshot | 12.24% vs. 72.36% |
| AgentBench | 8 mixed environments | n/a | Mixed | GPT-4 leads open models |

### Simulated Web Environments

The first family fixes the environment so that evaluation is reproducible: self-hosted, fully controllable websites where the same task yields the same result on every run. The tradeoff is fidelity, since simulated sites cannot reproduce the full long-tail diversity of the real web.

#### WebArena

Zhou et al. (2024) [@zhou2024webarena] introduced WebArena, a realistic web-based benchmark for evaluating autonomous web agents. WebArena provides self-hosted, fully functional websites covering e-commerce (shopping), social forums (Reddit-like), content management (GitLab), maps, and knowledge bases (Wikipedia-like). Tasks require complex web interactions: "Find the cheapest office chair with 4+ star rating and add it to the cart" or "Create a new repository on GitLab with a specific configuration."

State-of-the-art LLM agents (GPT-4) achieve only 14.41% task success rate on WebArena versus 78.24% for humans, highlighting the substantial gap between current agent capabilities and human-level web browsing proficiency. Earlier work on WebShop (Yao et al., 2022) [@yao2022webshop] demonstrated that web-based shopping tasks could serve as a testbed for grounded language agents, finding that even in a simplified web environment, agents struggle with exploration and long-horizon planning. The difficulty lies not in individual web actions but in the **planning and error recovery** required for multi-step web interactions: agents must navigate complex page layouts, handle dynamic content, recover from wrong turns, and maintain coherent task state across many steps.

The comparative lesson of WebArena is that its difficulty comes from controllability, not realism: because the sites are deterministic, the roughly 64-point gap to humans isolates planning and error recovery as the bottleneck rather than blaming it on web noise or distribution shift. This is what makes WebArena a cleaner diagnostic than the real-web benchmarks below, at the cost of covering fewer site designs.

#### BrowserGym and VisualWebArena

**BrowserGym** (Drouin et al., 2024) [@drouin2024browsergym] proposed a unified ecosystem for web agent research that standardizes the observation and action spaces across multiple web benchmarks (WebArena, VisualWebArena, WorkArena, etc.). BrowserGym provides a gym-like interface for training and evaluating web agents, enabling systematic comparison of different agent architectures, observation representations, and training methods.

**VisualWebArena** (Koh et al., 2024) [@koh2024visualwebarena] extended WebArena with tasks that require visual understanding, namely interpreting images, charts, and visual layouts to complete tasks. This tests whether agents can operate on the web as humans do (visually) rather than relying on structured HTML/DOM representations. Current vision-language model agents perform significantly worse on visual tasks than on text-based tasks, indicating that visual web understanding remains a key challenge.

Comparing the two siblings exposes the text-DOM versus vision tradeoff directly: because VisualWebArena holds the simulated environment fixed and only swaps the observation modality, the drop relative to WebArena measures the cost of perceiving the page rather than reading its source. The takeaway is that structured DOM access remains the easier interface today, while vision-based observation, though more robust to markup changes, still trails on the same tasks. BrowserGym matters precisely because it standardizes observation and action spaces, making this kind of like-for-like comparison possible across benchmarks.

### Real-Web Environments

The second family trades reproducibility for fidelity by grounding evaluation in the actual web. The principle is generalization across the long tail of real site designs; the tradeoff is that live sites drift and break, so these benchmarks often rely on captured snapshots or offline traces rather than live interaction.

#### Mind2Web

Deng et al. (2024) [@deng2024mind2web] introduced Mind2Web, a benchmark and dataset for training generalist web agents. Mind2Web covers 2,000+ tasks across 137 real-world websites with diverse designs and functionalities, providing HTML snapshots and human action traces. Unlike simulated environments, Mind2Web uses real websites, capturing the complexity and diversity of the actual web. The dataset enables training models that generalize across websites, rather than overfitting to a specific site's structure.

Set against WebArena, Mind2Web makes the reproducibility-versus-fidelity tradeoff concrete: WebArena offers a deterministic harness with a clean success metric but only a handful of site types, whereas Mind2Web spans 137 real sites at the cost of evaluating against frozen snapshots and action traces rather than live success. The two are therefore complementary, the former diagnosing planning depth and the latter measuring cross-site generalization.

### Agent Architectures for Web Browsing

Web browsing agents typically combine an LLM "brain" with a browser tool that can navigate pages, click elements, fill forms, scroll, and extract content. Key architectural design choices include:

**Observation representation:** How the web page is presented to the LLM. Options include raw HTML (comprehensive but verbose), simplified DOM trees (more compact but may lose information), accessibility trees (structured and standard), screenshots (visual but requiring vision capabilities), and hybrid representations. The choice of representation significantly affects agent performance: simplified, structured representations generally outperform raw HTML due to reduced context length and noise.

**Action space design:** Low-level actions (click at coordinates, type text) vs. high-level actions (click on element with description, fill form field named X). Higher-level action spaces are easier for the LLM to use but may not cover all possible interactions.

**WebVoyager** (He et al., 2024) [@he2024webvoyager] demonstrated a vision-based web agent that uses screenshots as observations and generates actions based on visual understanding. This approach is more robust to DOM changes (which frequently break text-based agents) but requires strong vision-language capabilities.

**Planning strategies:** Reactive agents (act based on current observation) vs. deliberative agents (plan multiple steps ahead). Deliberative agents generally perform better on complex tasks but are slower and more expensive. Recent work explores hierarchical planning, where a high-level planner decomposes the task into sub-goals and a low-level executor handles individual web interactions.

### GAIA: General AI Assistants

Mialon et al. (2024) [@mialon2024gaia] introduced GAIA, a benchmark designed to evaluate general AI assistants that must use multiple tools (web search, code execution, file manipulation) and multi-step reasoning to answer complex questions. GAIA tasks are specifically designed to be easy for humans (who achieve 92% accuracy) but difficult for AI systems (GPT-4 with plugins achieves ~15% accuracy), highlighting the gap between current AI capabilities and human-level tool use and reasoning. GAIA has become a standard benchmark for evaluating the overall capability of agentic systems.

What makes GAIA worth comparing to WebArena is that the two land at a strikingly similar ~15% GPT-4 score while measuring different things: WebArena's number reflects executing long action sequences inside a single browsing environment, whereas GAIA's reflects orchestrating multiple tools and modalities to answer one question. The convergence suggests the binding constraint is multi-step planning and reliable execution rather than any single skill (browsing, search, or coding) in isolation, which is why GAIA's much larger human gap (92% versus 15%) reads as a capability ceiling rather than a quirk of one environment.

### Full-Computer Environments

The third family removes the browser boundary entirely: instead of a page, the observation becomes the whole screen, and the action space spans every application. The principle is maximal generality, with the agent sharing the human's interface to the machine; the tradeoff is that OS-level concepts (file systems, permissions, cross-application state) compound the difficulty far beyond web-only tasks.

#### Computer-Use Agents

A frontier direction extends web browsing to general computer use: agents that can operate any software through GUI interactions (mouse clicks, keyboard input, screen reading). **Claude Computer Use** (Anthropic, 2024) [@anthropic2024claude_computer] and similar systems allow LLMs to control desktop applications, navigating software UIs, manipulating files, and completing tasks across applications. This represents the most general form of agentic interaction, where the agent has the same interface to the digital world as a human user.

**OSWorld** (Xie et al., 2024) [@xie2024osworld] introduced a benchmark for evaluating computer-use agents across real operating systems (Ubuntu, Windows, macOS), requiring agents to complete tasks involving file management, software installation, web browsing, and multi-application workflows. OSWorld tasks are substantially harder than web-only benchmarks because they require understanding of OS-level concepts (file systems, permissions, application interactions) and handling diverse GUIs. Current best agents achieve only 12.24% task completion on OSWorld, compared to 72.36% for humans, highlighting the enormous gap remaining in general computer use.

The OSWorld result is best read against WebArena: the agent score barely moves (14.41% to 12.24%) even as the environment expands from a handful of websites to a full desktop, while the human score also stays high (78.24% to 72.36%). The near-constant human-versus-agent gap across both axes indicates that widening the action space does not, by itself, change the bottleneck; the limiting factor remains reliable long-horizon planning, now stressed further by OS-level state that the browser benchmarks never expose.

**AgentBench** (Liu et al., 2024) [@liu2024agentbench] provides a multi-dimensional evaluation of LLM agents across 8 diverse environments: operating systems, databases, knowledge graphs, digital card games, lateral thinking puzzles, household environments, web shopping, and web browsing. AgentBench revealed that GPT-4 substantially outperforms open-source models on agentic tasks, even when open-source models are competitive on standard NLP benchmarks, suggesting that agentic capability requires something beyond general language understanding.

### Comparative Analysis

Read across the three families, the benchmarks form a single progression rather than a list. Moving from simulated sites (WebArena) to the real web (Mind2Web) to the full desktop (OSWorld) widens what the agent must perceive and act on, while the GAIA and AgentBench results cut across all three by testing tool orchestration and cross-environment generality. Two patterns hold throughout. First, the **observation modality** governs the easy-versus-hard split within a fixed environment: structured DOM access beats vision (WebArena over VisualWebArena) even though vision is more robust to markup drift, so the field still pays a measurable tax for perceiving pages as humans do. Second, the **human-versus-agent gap** is remarkably stable, from roughly 64 points on WebArena to 60 on OSWorld to 77 on GAIA, and it tracks task horizon and planning depth more than it tracks environment realism or action-space size. The convergence of GPT-4 near 12 to 15% across otherwise dissimilar benchmarks is the strongest evidence that the binding constraint is reliable long-horizon planning and error recovery.
