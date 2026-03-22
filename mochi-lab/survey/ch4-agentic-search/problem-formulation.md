---
sidebar_position: 2
title: "Problem Formulation"
---

## Problem Formulation

### Search as Sequential Decision-Making

Agentic search can be formalized as a sequential decision-making problem [@sutton2018reinforcement]. At each step t, the agent observes a state s_t (comprising the current query, retrieved information, and reasoning context), selects an action a_t (search query, tool call, or reasoning step), and receives an observation o_{t+1}. The process continues until a termination condition is met (answer found, confidence threshold reached, or budget exhausted).

The objective is to maximize the quality of the final answer while minimizing search cost:

maximize Quality(answer) - lambda * Cost(search_trajectory)

where Cost may include the number of search queries, API calls, tokens processed, or wall-clock time.

### Reward Signals

Defining reward signals for agentic search is challenging. Unlike game-playing settings where rewards are well-defined, search quality is often subjective and can only be evaluated after the full search trajectory is complete. Common proxy rewards include: answer accuracy on benchmark questions, faithfulness to retrieved evidence, citation quality, and user satisfaction ratings [@gao2023enabling, @liu2023evaluating].

### Key Challenges

Agentic search must address several fundamental challenges:
- **When to search:** Not all questions require retrieval; the agent must decide when its parametric knowledge is sufficient vs. when external evidence is needed.
- **What to search for:** Query formulation is critical -- the same information need can be expressed as many different queries with vastly different retrieval results.
- **When to stop:** The agent must balance thoroughness against cost, deciding when enough evidence has been gathered.
- **How to synthesize:** Combining information from multiple, potentially contradictory sources into a coherent, faithful answer.
