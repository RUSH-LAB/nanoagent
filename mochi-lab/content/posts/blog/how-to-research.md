---
slug: how-to-research
title: "What Is Research Taste?"
authors: [zeyu]
tags: [research]
---

Research is not about following a rigid plan. It is about exploring, finding signals, and turning those signals into ideas worth sharing. What follows are the personal heuristics I have come to rely on, not universal laws. Many of them have well-known precedents (Hamming's "You and Your Research" is the obvious one); what I want to add is the reasoning behind each one and how I weigh it when making decisions, rather than treating any of them as a rule to follow blindly.

<!-- truncate -->

## Research Taste

Think from first principles. Find the most fundamental essence.

- **Question everything.** Cultivate a skeptical mind. The things everyone takes for granted are often where the breakthroughs hide.
- **Be your own genius.** Dare to do something different. Following the crowd is safe but forgettable.
- **Demand perfection.** Hold your writing, websites, and presentations to the highest standard. Quality compounds.
- **Keep it simple.** If your idea can be implemented in 300 lines instead of 3,000, I almost always prefer the 300-line version. The caveat matters: this is advice for method and modeling work, where complexity is often incidental. It fails in regimes where the system *is* the contribution (large-scale infrastructure, distributed training, hardware-aware kernels) or where the result genuinely demands heavy theoretical machinery. In those settings, forcing simplicity throws away the essential complexity that makes the work valuable.

In my experience, nobody remembers average work. People remember your best contribution, the one everybody knows. This is not a reason to be paralyzed, but it is a reason to be ambitious. Aim for work that changes how people think about a problem, not work that adds another row to a table.

## Find the Right Problem

Defining the right problem is the most important skill in research. You need a sense for what is both interesting and important: interesting enough to keep you motivated, important enough to ensure your work matters. The best research sits at the intersection of the two.

The competition is real. But the best way to stand out is not to compete on the same problems as everyone else. It is to find better problems.

## Prepare Your Arsenal

**Engineering skills.** Ideas alone are not enough. You need the ability to prototype quickly, reproduce baselines, and iterate on experiments. The faster you can turn an idea into a working system, the more ideas you can explore, and the sharper your intuition becomes.

**Tooling.** A craftsman cannot do great work without great tools. Invest in solid infrastructure, a clean codebase, and the right tooling. These are not distractions from research. They are what make fast, reliable experimentation possible.

**Reading papers.** Reading is essential, but not every section deserves equal attention. Focus on the core contributions, the experimental setup, and the results that reveal something surprising. Skim the rest.

## The Research Cycle

A realistic research cycle looks something like this (tuned to deadline-driven empirical ML, where conference deadlines provide natural milestones):

**Month 1 to 2: Explore and hack.** Know your general direction, but stay loose. Reproduce baselines and try extensions. The goal is not a finished idea. It is a signal. What works? What does not? Let the experiments guide you.

**Month 3 to 5: Make the idea work.** Once you have a signal, commit. Refine the approach, run thorough experiments, and build a convincing story around your results.

**Month 6: Write and publish.** Finish your paper a month before the deadline. The last-minute rush kills clarity. Write it up and put it out into the world.

## Experiment with Intent

**Predict before you run.** Before every experiment, predict what the results will look like. This forces you to clarify your assumptions and sharpen your understanding. When the results match, your mental model is confirmed. When they do not, that gap between expectation and reality is where the most valuable insights live. Every experiment should teach you something, but only if you know what you expected in the first place.

**Chase signals, not ideas.** The most underrated part of research is the exploration phase. When you pay close attention, you start to notice signals: patterns in what works and what does not. These signals are where real ideas come from. Counterintuitively, signals about what does *not* work are often more valuable. They reveal gaps, broken assumptions, and overlooked directions, problems that others have missed.

**Your ceiling is your baseline.** The upper bound of your research is set by your baseline. Push it as high as it can go, and only then try to beat it. My rule of thumb: surpassing a strong baseline is what makes a result convincing, while surpassing a weak one can look impressive (a large margin) and still mean little, because the gain may say more about the baseline's flaws than about your method. This is why I spend disproportionate time strengthening the baseline before claiming any improvement over it.

## What Bad Research Looks Like

If your final paper looks exactly like the idea you started with, the idea was probably boring. Good research evolves. The best papers end up somewhere the author did not fully expect. If your results never surprise you, you are not exploring enough.
