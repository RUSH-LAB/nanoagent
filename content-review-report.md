# Content Review Sweep Report

> Generated from a 157-file rubric review (review-draft skill). The REVIEW findings below are useful triage. The automated REPAIR edits from the same run are NOT trustworthy: several agents fabricated new files and renamed a book directory. Treat every edit as suspect until inspected via git diff. See the WARNING section.

## Summary

- Files reviewed: 157
- Final verdicts: ACCEPT 134, REVISE 23, REJECT 0
- Files the agents edited: 151
- Em-dash / "--" occurrences flagged: 1787
- Missing-citekey instances flagged: 104

## WARNING: untrusted automated changes

Agents exceeded the conservative-repair scope. Confirmed problems:

- Renamed the entire `books/build-with-ai/` book to `books/builder/` (breaks docusaurus.config.js, navbar, math-registry).
- Created fabricated files describing nonexistent features: `builder/components-of-textbooks/6-formal-proofs.md` (a `<LeanProof>` component that does not exist), `builder/how-to/burn-100k-on-tokens.md`, `builder/how-to/fleet-setup.md`, `builder/how-to/knowledge-engine-harness.md`, `posts/research/knowledge-engine.md`.
- 151 files edited in place; some agents demonstrably hallucinated, so none of these edits can be trusted without review.

Recommended: revert automated edits, keep the sidecars (`_*.review.md`) and this report as triage, then fix deliberately.

## Files still REVISE after repair

| File | Type | Orig | Final | Edited | Em-dash | Broken keys |
|---|---|---|---|---|---|---|
| books/math/1-intro-to-comp/3-assembly-cuda-torch.md | textbook | REJECT | REVISE | yes | 4 | 1 |
| books/math/1-intro-to-comp/4-hpc.md | textbook | REJECT | REVISE | yes | 5 | 1 |
| books/math/3-linear-algebra/2-matrix-operations.md | textbook | REVISE | REVISE | yes | 4 | 0 |
| books/math/3-linear-algebra/3-eigendecomposition.md | textbook | REJECT | REVISE | yes | 0 | 1 |
| books/math/4-calculus-and-optimization/1-multivariable-calculus.md | textbook | REJECT | REVISE | yes | 3 | 5 |
| books/math/5-probability-and-statistics/2-distributions.md | textbook | REJECT | REVISE | yes | 6 | 3 |
| books/math/6-advanced-ml-math/2-diffusion-models.md | textbook | REJECT | REVISE | yes | 5 | 10 |
| books/programming/1-intro-to-comp/2-cpu-and-gpu.md | textbook | REJECT | REVISE | yes | 14 | 0 |
| books/programming/1-intro-to-comp/3-assembly-cuda-torch.md | textbook | REJECT | REVISE | yes | 24 | 0 |
| books/survey/ch1-continual-learning/architecture-methods.md | literature-review | REVISE | REVISE | yes | 11 | 0 |
| books/survey/ch2-world-models/benchmarks.md | literature-review | REVISE | REVISE | yes | 0 | 0 |
| books/survey/ch2-world-models/index.md | literature-review | REJECT | REVISE | yes | 100 | 0 |
| books/survey/ch2-world-models/reasoning.md | literature-review | REVISE | REVISE | yes | 10 | 0 |
| books/survey/ch2-world-models/reinforcement-learning.md | literature-review | REVISE | REVISE | yes | 0 | 0 |
| books/survey/ch2-world-models/taxonomy.md | literature-review | REVISE | REVISE | yes | 3 | 0 |
| books/survey/ch3-efficient-architecture/connections.md | literature-review | REVISE | REVISE | yes | 2 | 0 |
| books/survey/ch4-agentic-search/agentic-web-search.md | literature-review | REJECT | REVISE | yes | 0 | 0 |
| books/survey/ch4-agentic-search/multi-hop-reasoning.md | literature-review | REJECT | REVISE | yes | 8 | 0 |
| books/survey/ch5-randomized-signal/benchmarks.md | literature-review | REJECT | REVISE | yes | 23 | 0 |
| books/survey/ch5-randomized-signal/random-projections.md | literature-review | REVISE | REVISE | yes | 8 | 0 |
| posts/blog/wikipedia-category-graph.md | research-post | REVISE | REVISE | yes | 27 | 0 |
| posts/research/compress-or-not-zeyu-2025/index.mdx | research-post | REVISE | REVISE | yes | 0 | 0 |
| posts/research/swarms.md | research-post | REVISE | REVISE | yes | 10 | 0 |

## Missing citekeys (not found in references.yaml)

These were flagged by reviewers; spot-check before trusting, as some flags may be false positives.

- **books/math/0-intro.md**: strang2006linear, boyd2004convex, bishop2006pattern, goodfellow2016deep, cover2006elements
- **books/math/1-intro-to-comp/1-comp-machine.md**: katz2017reluplex, blum1989training, alman2021refined, telgarsky2016benefits, eldan2016power, yarotsky2017error, montufar2014number, belkin2019reconciling
- **books/math/1-intro-to-comp/3-assembly-cuda-torch.md**: ansel2024pytorch2
- **books/math/1-intro-to-comp/4-hpc.md**: shoeybi2019megatron
- **books/math/1-intro-to-comp/index.md**: katz2017reluplex, blum1989training, alman2021refined, telgarsky2016benefits, eldan2016power, yarotsky2017error, montufar2014number, belkin2019reconciling, ansel2024pytorch2, shoeybi2019megatron
- **books/math/2-ml-basics/1-loss-functions.md**: radford2021clip, chen2020simclr, oord2018representation, szegedy2016rethinking
- **books/math/2-ml-basics/2-rl-algs.md**: schulman2016gae, deepseekai2025r1, guo2024direct
- **books/math/2-ml-basics/3-gradient-descent.md**: keskar2017large, goyal2017accurate, nesterov1983method, loshchilov2017sgdr
- **books/math/2-ml-basics/4-backpropagation.md**: lecun2012efficient
- **books/math/2-ml-basics/5-regularization.md**: zhang2021understanding, ioffe2015batch, ba2016layer, belkin2019reconciling, bishop2006pattern
- **books/math/3-linear-algebra/3-eigendecomposition.md**: dauphin2014identifying
- **books/math/4-calculus-and-optimization/1-multivariable-calculus.md**: amos2017optnet, bai2019deep, chen2018neural, choromanska2015loss, draxler2018essentially
- **books/math/4-calculus-and-optimization/2-convex-optimization.md**: nesterov1983method
- **books/math/4-calculus-and-optimization/3-non-convex-optimization.md**: jin2017escape, keskar2017large, draxler2018essentially, garipov2018loss, frankle2020linear, cohen2021gradient, li2018visualizing, jastrzebski2020break, mcallester1999pac, du2019gradient, ioffe2015batch, santurkar2018does, gunasekar2018characterizing, loshchilov2017sgdr, foret2021sam
- **books/math/4-calculus-and-optimization/4-constrained-optimization.md**: duchi2008simplex
- **books/math/5-probability-and-statistics/2-distributions.md**: jang2017categorical, maddison2017concrete, rezende2015variational
- **books/math/5-probability-and-statistics/3-bayesian-inference.md**: ritter2018scalable
- **books/math/5-probability-and-statistics/4-information-theory.md**: csiszar1967information, ali1966general, nowozin2016fgan, tishby2000information, belghazi2018mine, tishby2015deep
- **books/math/5-probability-and-statistics/5-statistical-learning.md**: bartlett2019nearly, bartlett2020benign, belkin2019reconciling, dziugaite2017computing, gunasekar2018characterizing
- **books/math/6-advanced-ml-math/1-attention-and-transformers.md**: shazeer2020glu, peng2023yarn, press2022train, liu2023ring
- **books/math/6-advanced-ml-math/2-diffusion-models.md**: hyvarinen2005estimation, lipman2023flow, liu2023flow, lu2022dpm, nichol2021improved, peebles2023dit, rombach2022ldm, song2021denoising, song2021score, song2023consistency
- **books/math/6-advanced-ml-math/3-graph-neural-networks.md**: defferrard2016convolutional, gilmer2017neural, xu2019how, brody2022how, morris2019weisfeiler, xu2018representation
- **books/math/6-advanced-ml-math/4-optimal-transport.md**: gulrajani2017improved, miyato2018spectral, lipman2023flow, liu2023flow

## Full verdict table

| File | Type | Final | Edited | Em-dash | Broken | Findings |
|---|---|---|---|---|---|---|
| books/build-with-ai/0-intro.md | docs | ACCEPT | yes | 0 | 0 | 5 |
| books/build-with-ai/components-of-textbooks/1-figure-and-table.md | docs | ACCEPT | yes | 1 | 0 | 2 |
| books/build-with-ai/components-of-textbooks/2-math.md | docs | ACCEPT | yes | 2 | 0 | 4 |
| books/build-with-ai/components-of-textbooks/3-code.md | docs | ACCEPT | yes | 0 | 0 | 3 |
| books/build-with-ai/components-of-textbooks/4-paper-citation.md | docs | ACCEPT | no | 0 | 0 | 3 |
| books/build-with-ai/components-of-textbooks/5-cross-reference.md | docs | ACCEPT | yes | 1 | 0 | 3 |
| books/build-with-ai/components-of-textbooks/index.md | docs | ACCEPT | no | 0 | 0 | 2 |
| books/build-with-ai/how-to/index.md | docs | ACCEPT | no | 0 | 0 | 1 |
| books/build-with-ai/how-to/notification-sound.md | docs | ACCEPT | yes | 6 | 0 | 4 |
| books/math/0-intro.md | textbook | ACCEPT | yes | 8 | 5 | 9 |
| books/math/1-intro-to-comp/1-comp-machine.md | textbook | ACCEPT | yes | 50 | 8 | 8 |
| books/math/1-intro-to-comp/2-cpu-and-gpu.md | textbook | ACCEPT | yes | 23 | 0 | 6 |
| books/math/1-intro-to-comp/3-assembly-cuda-torch.md | textbook | REVISE | yes | 4 | 1 | 4 |
| books/math/1-intro-to-comp/4-hpc.md | textbook | REVISE | yes | 5 | 1 | 7 |
| books/math/1-intro-to-comp/index.md | textbook | ACCEPT | yes | 381 | 10 | 7 |
| books/math/2-ml-basics/1-loss-functions.md | textbook | ACCEPT | yes | 8 | 4 | 6 |
| books/math/2-ml-basics/2-rl-algs.md | textbook | ACCEPT | yes | 16 | 3 | 9 |
| books/math/2-ml-basics/3-gradient-descent.md | textbook | ACCEPT | yes | 4 | 4 | 11 |
| books/math/2-ml-basics/4-backpropagation.md | textbook | ACCEPT | yes | 2 | 1 | 6 |
| books/math/2-ml-basics/5-regularization.md | textbook | ACCEPT | yes | 0 | 5 | 8 |
| books/math/2-ml-basics/index.md | textbook | ACCEPT | yes | 5 | 0 | 2 |
| books/math/3-linear-algebra/1-vectors-and-matrices.md | textbook | ACCEPT | yes | 10 | 0 | 6 |
| books/math/3-linear-algebra/2-matrix-operations.md | textbook | REVISE | yes | 4 | 0 | 5 |
| books/math/3-linear-algebra/3-eigendecomposition.md | textbook | REVISE | yes | 0 | 1 | 7 |
| books/math/3-linear-algebra/4-svd-and-pca.md | textbook | ACCEPT | yes | 11 | 0 | 5 |
| books/math/3-linear-algebra/5-matrix-calculus.md | textbook | ACCEPT | yes | 2 | 0 | 4 |
| books/math/3-linear-algebra/index.md | textbook | ACCEPT | yes | 0 | 0 | 3 |
| books/math/4-calculus-and-optimization/1-multivariable-calculus.md | textbook | REVISE | yes | 3 | 5 | 11 |
| books/math/4-calculus-and-optimization/2-convex-optimization.md | textbook | ACCEPT | yes | 4 | 1 | 7 |
| books/math/4-calculus-and-optimization/3-non-convex-optimization.md | textbook | ACCEPT | yes | 0 | 15 | 18 |
| books/math/4-calculus-and-optimization/4-constrained-optimization.md | textbook | ACCEPT | yes | 60 | 1 | 5 |
| books/math/4-calculus-and-optimization/index.md | textbook | ACCEPT | yes | 0 | 0 | 2 |
| books/math/5-probability-and-statistics/1-probability-basics.md | textbook | ACCEPT | yes | 0 | 0 | 6 |
| books/math/5-probability-and-statistics/2-distributions.md | textbook | REVISE | yes | 6 | 3 | 9 |
| books/math/5-probability-and-statistics/3-bayesian-inference.md | textbook | ACCEPT | yes | 3 | 1 | 7 |
| books/math/5-probability-and-statistics/4-information-theory.md | textbook | ACCEPT | yes | 10 | 6 | 11 |
| books/math/5-probability-and-statistics/5-statistical-learning.md | textbook | ACCEPT | yes | 5 | 5 | 10 |
| books/math/5-probability-and-statistics/index.md | textbook | ACCEPT | yes | 5 | 0 | 3 |
| books/math/6-advanced-ml-math/1-attention-and-transformers.md | textbook | ACCEPT | yes | 6 | 4 | 8 |
| books/math/6-advanced-ml-math/2-diffusion-models.md | textbook | REVISE | yes | 5 | 10 | 6 |
| books/math/6-advanced-ml-math/3-graph-neural-networks.md | textbook | ACCEPT | yes | 3 | 6 | 12 |
| books/math/6-advanced-ml-math/4-optimal-transport.md | textbook | ACCEPT | yes | 3 | 4 | 8 |
| books/math/6-advanced-ml-math/index.md | textbook | ACCEPT | yes | 4 | 0 | 3 |
| books/programming/0-intro.md | textbook | ACCEPT | yes | 26 | 0 | 5 |
| books/programming/1-intro-to-comp/1-comp-machine.md | textbook | ACCEPT | yes | 146 | 0 | 6 |
| books/programming/1-intro-to-comp/2-cpu-and-gpu.md | textbook | REVISE | yes | 14 | 0 | 7 |
| books/programming/1-intro-to-comp/3-assembly-cuda-torch.md | textbook | REVISE | yes | 24 | 0 | 7 |
| books/programming/1-intro-to-comp/4-hpc.md | textbook | ACCEPT | yes | 0 | 0 | 7 |
| books/programming/1-intro-to-comp/index.md | textbook | ACCEPT | yes | 4 | 0 | 3 |
| books/programming/2-torch/1-tensors.md | textbook | ACCEPT | yes | 0 | 0 | 7 |
| books/programming/2-torch/2-autograd.md | textbook | ACCEPT | yes | 8 | 0 | 3 |
| books/programming/2-torch/3-nn-module.md | textbook | ACCEPT | yes | 3 | 0 | 8 |
| books/programming/2-torch/4-data-loading.md | textbook | ACCEPT | yes | 4 | 0 | 7 |
| books/programming/2-torch/5-training-loop.md | textbook | ACCEPT | yes | 4 | 0 | 5 |
| books/programming/2-torch/6-debugging.md | textbook | ACCEPT | yes | 3 | 0 | 5 |
| books/programming/2-torch/index.md | textbook | ACCEPT | yes | 0 | 0 | 2 |
| books/programming/3-cuda-and-gpu/1-first-kernel.md | textbook | ACCEPT | yes | 0 | 0 | 5 |
| books/programming/3-cuda-and-gpu/2-memory-model.md | textbook | ACCEPT | no | 0 | 0 | 4 |
| books/programming/3-cuda-and-gpu/3-optimization.md | textbook | ACCEPT | yes | 0 | 0 | 7 |
| books/programming/3-cuda-and-gpu/4-triton.md | textbook | ACCEPT | yes | 3 | 0 | 5 |
| books/programming/3-cuda-and-gpu/5-custom-ops.md | textbook | ACCEPT | yes | 3 | 0 | 6 |
| books/programming/3-cuda-and-gpu/index.md | textbook | ACCEPT | yes | 5 | 0 | 3 |
| books/programming/4-assembly/1-x86-basics.md | textbook | ACCEPT | yes | 6 | 0 | 5 |
| books/programming/4-assembly/2-memory-and-stack.md | textbook | ACCEPT | yes | 5 | 0 | 5 |
| books/programming/4-assembly/3-simd.md | textbook | ACCEPT | yes | 9 | 0 | 9 |
| books/programming/4-assembly/index.md | textbook | ACCEPT | yes | 3 | 0 | 3 |
| books/programming/5-ml-systems/1-distributed-training.md | textbook | ACCEPT | yes | 0 | 0 | 7 |
| books/programming/5-ml-systems/2-mixed-precision.md | textbook | ACCEPT | yes | 4 | 0 | 8 |
| books/programming/5-ml-systems/3-inference-optimization.md | textbook | ACCEPT | yes | 5 | 0 | 7 |
| books/programming/5-ml-systems/4-profiling.md | textbook | ACCEPT | yes | 4 | 0 | 6 |
| books/programming/5-ml-systems/index.md | textbook | ACCEPT | yes | 4 | 0 | 3 |
| books/programming/99-supplement/1-python-tips.md | textbook | ACCEPT | yes | 1 | 0 | 6 |
| books/programming/99-supplement/2-linux-and-shell.md | textbook | ACCEPT | yes | 0 | 0 | 5 |
| books/programming/99-supplement/3-git-for-ml.md | textbook | ACCEPT | yes | 72 | 0 | 6 |
| books/programming/99-supplement/index.md | textbook | ACCEPT | yes | 0 | 0 | 2 |
| books/survey/ch1-continual-learning/architecture-methods.md | literature-review | REVISE | yes | 11 | 0 | 6 |
| books/survey/ch1-continual-learning/benchmarks.md | literature-review | ACCEPT | yes | 0 | 0 | 5 |
| books/survey/ch1-continual-learning/connections.md | literature-review | ACCEPT | yes | 9 | 0 | 7 |
| books/survey/ch1-continual-learning/index.md | literature-review | ACCEPT | yes | 0 | 0 | 4 |
| books/survey/ch1-continual-learning/introduction.md | literature-review | ACCEPT | yes | 0 | 0 | 5 |
| books/survey/ch1-continual-learning/llm-continual-learning.md | literature-review | ACCEPT | yes | 15 | 0 | 7 |
| books/survey/ch1-continual-learning/meta-continual-learning.md | literature-review | ACCEPT | yes | 9 | 0 | 8 |
| books/survey/ch1-continual-learning/open-problems.md | literature-review | ACCEPT | yes | 11 | 0 | 6 |
| books/survey/ch1-continual-learning/problem-formulation.md | literature-review | ACCEPT | yes | 3 | 0 | 5 |
| books/survey/ch1-continual-learning/prompt-based-methods.md | literature-review | ACCEPT | yes | 6 | 0 | 7 |
| books/survey/ch1-continual-learning/regularization-methods.md | literature-review | ACCEPT | yes | 7 | 0 | 8 |
| books/survey/ch1-continual-learning/replay-methods.md | literature-review | ACCEPT | yes | 3 | 0 | 6 |
| books/survey/ch1-continual-learning/taxonomy.md | literature-review | ACCEPT | yes | 0 | 0 | 5 |
| books/survey/ch2-world-models/benchmarks.md | literature-review | REVISE | yes | 0 | 0 | 7 |
| books/survey/ch2-world-models/classic-world-models.md | literature-review | ACCEPT | yes | 10 | 0 | 6 |
| books/survey/ch2-world-models/connections.md | literature-review | ACCEPT | yes | 6 | 0 | 5 |
| books/survey/ch2-world-models/foundation-world-models.md | literature-review | ACCEPT | yes | 12 | 0 | 8 |
| books/survey/ch2-world-models/index.md | literature-review | REVISE | yes | 100 | 0 | 9 |
| books/survey/ch2-world-models/introduction.md | literature-review | ACCEPT | yes | 12 | 0 | 5 |
| books/survey/ch2-world-models/open-problems.md | literature-review | ACCEPT | yes | 8 | 0 | 6 |
| books/survey/ch2-world-models/problem-formulation.md | literature-review | ACCEPT | yes | 4 | 0 | 7 |
| books/survey/ch2-world-models/reasoning.md | literature-review | REVISE | yes | 10 | 0 | 9 |
| books/survey/ch2-world-models/reinforcement-learning.md | literature-review | REVISE | yes | 0 | 0 | 9 |
| books/survey/ch2-world-models/robotics.md | literature-review | ACCEPT | yes | 0 | 0 | 7 |
| books/survey/ch2-world-models/taxonomy.md | literature-review | REVISE | yes | 3 | 0 | 9 |
| books/survey/ch2-world-models/video-prediction.md | literature-review | ACCEPT | yes | 0 | 0 | 7 |
| books/survey/ch3-efficient-architecture/benchmarks.md | literature-review | ACCEPT | yes | 2 | 0 | 8 |
| books/survey/ch3-efficient-architecture/connections.md | literature-review | REVISE | yes | 2 | 0 | 6 |
| books/survey/ch3-efficient-architecture/efficient-attention.md | literature-review | ACCEPT | yes | 9 | 0 | 8 |
| books/survey/ch3-efficient-architecture/efficient-training.md | literature-review | ACCEPT | yes | 11 | 0 | 6 |
| books/survey/ch3-efficient-architecture/index.md | literature-review | ACCEPT | yes | 96 | 0 | 6 |
| books/survey/ch3-efficient-architecture/inference-optimization.md | literature-review | ACCEPT | yes | 0 | 0 | 7 |
| books/survey/ch3-efficient-architecture/introduction.md | literature-review | ACCEPT | yes | 9 | 0 | 7 |
| books/survey/ch3-efficient-architecture/mixture-of-experts.md | literature-review | ACCEPT | yes | 0 | 0 | 7 |
| books/survey/ch3-efficient-architecture/model-compression.md | literature-review | ACCEPT | yes | 0 | 0 | 5 |
| books/survey/ch3-efficient-architecture/neural-architecture-search.md | literature-review | ACCEPT | yes | 0 | 0 | 6 |
| books/survey/ch3-efficient-architecture/open-problems.md | literature-review | ACCEPT | yes | 0 | 0 | 6 |
| books/survey/ch3-efficient-architecture/peft.md | literature-review | ACCEPT | yes | 5 | 0 | 8 |
| books/survey/ch3-efficient-architecture/problem-formulation.md | literature-review | ACCEPT | yes | 11 | 0 | 5 |
| books/survey/ch3-efficient-architecture/state-space-models.md | literature-review | ACCEPT | yes | 5 | 0 | 6 |
| books/survey/ch3-efficient-architecture/sub-quadratic-architectures.md | literature-review | ACCEPT | yes | 0 | 0 | 5 |
| books/survey/ch3-efficient-architecture/taxonomy.md | literature-review | ACCEPT | yes | 4 | 0 | 6 |
| books/survey/ch4-agentic-search/agentic-web-search.md | literature-review | REVISE | yes | 0 | 0 | 7 |
| books/survey/ch4-agentic-search/benchmarks.md | literature-review | ACCEPT | yes | 8 | 0 | 10 |
| books/survey/ch4-agentic-search/code-and-math.md | literature-review | ACCEPT | yes | 2 | 0 | 6 |
| books/survey/ch4-agentic-search/connections.md | literature-review | ACCEPT | yes | 9 | 0 | 6 |
| books/survey/ch4-agentic-search/index.md | literature-review | ACCEPT | yes | 3 | 0 | 4 |
| books/survey/ch4-agentic-search/introduction.md | literature-review | ACCEPT | yes | 13 | 0 | 4 |
| books/survey/ch4-agentic-search/mcts-llms.md | literature-review | ACCEPT | yes | 0 | 0 | 6 |
| books/survey/ch4-agentic-search/multi-hop-reasoning.md | literature-review | REVISE | yes | 8 | 0 | 8 |
| books/survey/ch4-agentic-search/open-problems.md | literature-review | ACCEPT | yes | 0 | 0 | 6 |
| books/survey/ch4-agentic-search/problem-formulation.md | literature-review | ACCEPT | yes | 9 | 0 | 7 |
| books/survey/ch4-agentic-search/retrieval-augmented-generation.md | literature-review | ACCEPT | yes | 6 | 0 | 7 |
| books/survey/ch4-agentic-search/self-improving-search.md | literature-review | ACCEPT | yes | 3 | 0 | 8 |
| books/survey/ch4-agentic-search/taxonomy.md | literature-review | ACCEPT | yes | 5 | 0 | 7 |
| books/survey/ch4-agentic-search/tool-augmented-retrieval.md | literature-review | ACCEPT | yes | 11 | 0 | 7 |
| books/survey/ch5-randomized-signal/benchmarks.md | literature-review | REVISE | yes | 23 | 0 | 8 |
| books/survey/ch5-randomized-signal/bloom-filters.md | literature-review | ACCEPT | yes | 6 | 0 | 8 |
| books/survey/ch5-randomized-signal/connections.md | literature-review | ACCEPT | yes | 2 | 0 | 5 |
| books/survey/ch5-randomized-signal/fourier-spectral.md | literature-review | ACCEPT | yes | 7 | 0 | 8 |
| books/survey/ch5-randomized-signal/hashing.md | literature-review | ACCEPT | yes | 0 | 0 | 7 |
| books/survey/ch5-randomized-signal/index.md | literature-review | ACCEPT | yes | 133 | 0 | 9 |
| books/survey/ch5-randomized-signal/introduction.md | literature-review | ACCEPT | yes | 13 | 0 | 4 |
| books/survey/ch5-randomized-signal/open-problems.md | literature-review | ACCEPT | yes | 11 | 0 | 5 |
| books/survey/ch5-randomized-signal/probabilistic-data-structures.md | literature-review | ACCEPT | yes | 0 | 0 | 6 |
| books/survey/ch5-randomized-signal/problem-formulation.md | literature-review | ACCEPT | yes | 0 | 0 | 6 |
| books/survey/ch5-randomized-signal/random-projections.md | literature-review | REVISE | yes | 8 | 0 | 7 |
| books/survey/ch5-randomized-signal/randomized-linear-algebra.md | literature-review | ACCEPT | yes | 3 | 0 | 8 |
| books/survey/ch5-randomized-signal/randomized-regularization.md | literature-review | ACCEPT | yes | 10 | 0 | 7 |
| books/survey/ch5-randomized-signal/signal-processing-transformers.md | literature-review | ACCEPT | yes | 9 | 0 | 5 |
| books/survey/ch5-randomized-signal/sketching-streaming.md | literature-review | ACCEPT | yes | 9 | 0 | 7 |
| books/survey/ch5-randomized-signal/taxonomy.md | literature-review | ACCEPT | yes | 1 | 0 | 6 |
| books/survey/ch5-randomized-signal/wavelet-multiresolution.md | literature-review | ACCEPT | yes | 7 | 0 | 12 |
| books/survey/intro.md | literature-review | ACCEPT | yes | 2 | 0 | 5 |
| posts/blog/ai-first-search.md | research-post | ACCEPT | no | 0 | 0 | 5 |
| posts/blog/browsecomp.md | research-post | ACCEPT | no | 0 | 0 | 5 |
| posts/blog/how-to-research.md | research-post | ACCEPT | yes | 9 | 0 | 5 |
| posts/blog/recent-progress-on-ir/index.mdx | research-post | ACCEPT | yes | 0 | 0 | 4 |
| posts/blog/scalable-synth-datagen.md | research-post | ACCEPT | yes | 7 | 0 | 8 |
| posts/blog/wikipedia-category-graph.md | research-post | REVISE | yes | 27 | 0 | 7 |
| posts/research/compress-or-not-zeyu-2025/index.mdx | research-post | REVISE | yes | 0 | 0 | 6 |
| posts/research/swarms.md | research-post | REVISE | yes | 10 | 0 | 5 |

## Items the agents left for a human

### books/build-with-ai/0-intro.md
- The page is still fundamentally a roadmap stub rather than a real introduction. I marked it draft:true to keep it out of the published build, but to actually ship it as a book introduction a human needs to write real content: what the 'Build with AI' section covers, its intended audience, and how it relates to the math/survey/research books on the site. I did not invent this content because it cannot be verified from the file or sources.
- Verify that `draft: true` is the desired exclusion mechanism for this Docusaurus setup (Docusaurus excludes draft docs from production builds but shows them in dev). If you prefer the page to remain visible but flagged, switch to `unlisted: true` or remove the flag once real intro content is added.

### books/build-with-ai/components-of-textbooks/3-code.md
- The remaining '--' character sequences in the file are all structural markdown that cannot be removed without breaking rendering: the YAML frontmatter delimiters (lines 1/4), the horizontal-rule separators ('---') between sections, and the table header separator row ('----------|-----|...'). None are em-dashes or prose dashes, so I left them unchanged. If the reviewer's count specifically targets the horizontal-rule lines, a human should decide whether to drop the stylistic '---' rules, since that is a formatting/style choice rather than a writing fix.

### books/math/0-intro.md
- I did not add the five book entries to references.yaml (Strang Linear Algebra and Its Applications; Boyd & Vandenberghe Convex Optimization 2004; Bishop PRML 2006; Goodfellow/Bengio/Courville Deep Learning 2016; Cover & Thomas Elements of Information Theory 2006). Creating full entries would require fabricating verifiable details (exact year, venue/publisher, URL/DOI) that I cannot confirm from the file or its sources. I removed the dangling [@citekey] markers so the page renders, but a human should add proper entries to references.yaml and restore the [@key] citations if formal citation linking is desired.

### books/math/1-intro-to-comp/1-comp-machine.md
- All eight previously broken citekeys now resolve. The seven I added (and the belkin entry added concurrently) use bibliographic details from my own knowledge of these well-known papers; please confirm the venue/year/URL fields match your house citation conventions, particularly blum1989training (NeurIPS 1988 proceedings vol., often cited as 'Training a 3-node neural network is NP-complete') and alman2021refined (SODA 2021).
- references.yaml is being edited concurrently by other processes during this session (file grew from 7532 to ~7820 lines); I appended the seven new entries at end-of-file to avoid edit collisions. A final dedup/lint pass on references.yaml after all concurrent jobs finish is advisable.

### books/math/1-intro-to-comp/3-assembly-cuda-torch.md
- Please verify the ansel2024pytorch2 reference fields I added (author list, url) against your preferred citation source/style; I supplied accurate but standard metadata for the ASPLOS 2024 PyTorch 2 paper and a canonical URL, but you may prefer the official ACM DOI (10.1145/3620665.3640366) or arXiv link if your bibliography conventions favor those.

### books/math/1-intro-to-comp/4-hpc.md
- Bandwidth correction assumed A100 (600 GB/s) per the reviewer's guidance, consistent with the surrounding LLaMA/A100 context; if the author actually intended H100s, the figure should instead be set to 900 GB/s and the time recomputed as 245/450 ~= 0.54 s.

### books/math/1-intro-to-comp/index.md
- The 381 em-dash count, the 10 broken citekeys (katz2017reluplex, blum1989training, alman2021refined, telgarsky2016benefits, eldan2016power, yarotsky2017error, montufar2014number, belkin2019reconciling, ansel2024pytorch2, shoeybi2019megatron), and the cuBLAS/Strassen factual error do NOT appear in index.md. They are in the chapter's sibling files (1-comp-machine.md, 2-cpu-and-gpu.md, 3-assembly-cuda-torch.md, 4-hpc.md). Since the task named only index.md as the file to edit, these were left untouched and should be addressed by re-running the fixer against those sub-files.
- Citekey correction note for the human: ansel2024pytorch2 DOES resolve in references.yaml (line 2500), and shoeybi2019megatron should be corrected to the existing key shoeybi2020megatronlm (line 5197). The other 8 citekeys appear absent from references.yaml and need new bib entries; do not invent references.

### books/math/2-ml-basics/1-loss-functions.md
- The 4 remaining '--' occurrences in the target markdown are required syntax (frontmatter delimiters on lines 1/3 and Markdown table header separator rows on lines 94, 143, 186, 207). The reviewer acknowledged table dashes 'are Markdown syntax and may be acceptable'; removing them would break the tables and frontmatter, so they were intentionally left.
- references.yaml is a shared file that appeared to be edited concurrently by other processes during this session (line count changed between reads). The three new entries were appended via shell to avoid clobbering concurrent edits; a human should confirm the final references.yaml has no merge/duplicate-key issues after all concurrent writers finish.
- I added the three bibliography entries using canonical, well-known metadata (titles, authors, venues, arXiv IDs) for CLIP, SimCLR, and the Szegedy Inception paper. These are widely-known references and not fabricated, but a human may wish to double-check the arXiv IDs and author lists against the canonical sources before publishing.

### books/math/2-ml-basics/2-rl-algs.md
- Verify the three newly added references.yaml entries (schulman2016gae, deepseekai2025r1, guo2024direct) for exact author lists/venues; I populated them from the metadata given in the reviewer findings (titles + arXiv IDs are accurate, but full author lists and venue labels were filled to match the file's existing schema and should be spot-checked).

### books/math/2-ml-basics/3-gradient-descent.md
- nesterov1983method has no `url` field: the 1983 Doklady Akademii Nauk SSSR paper has no canonical/verifiable online URL, so I did not fabricate one. The BibliographyItem renderer guards `entry.url && (...)`, so the entry renders cleanly without a link. If a verified URL/DOI is desired, a human should add it.
- I did not add momentum-vs-momentum or Nesterov trajectory worked examples; demonstrating momentum's advantage cleanly over a few hand-computed steps requires careful tuning to avoid presenting it unfavorably. The GD-conditioning example sets up that gap and the existing momentum remarks cover the qualitative speedup. A human could add a momentum trajectory example if a second optimizer-specific worked example is wanted.

### books/math/2-ml-basics/4-backpropagation.md
- Verify the added references.yaml entry for lecun2012efficient matches the site's preferred citation format/fields (I followed the existing article-entry structure but used type: incollection with a Springer chapter URL; confirm the URL and venue string render correctly in the bibliography component).

### books/math/2-ml-basics/5-regularization.md
- Verify the chosen reference metadata if you maintain strict house style: I used the CACM 2021 venue for zhang2021understanding (consistent with the 2021 key) rather than the original ICLR 2017 publication; both are the same paper. Adjust venue/year if you prefer the ICLR 2017 citation.
- The four added references.yaml entries were created from canonical, well-known publication details (titles, authors, arXiv IDs, venues). They were not fetched live from the sources, so a quick confirmation against the originals before publishing is advisable.

### books/math/3-linear-algebra/3-eigendecomposition.md
- The graph-Laplacian rename to $L_{\text{graph}}$ and $W$ for adjacency is self-consistent within this chapter, but if other chapters in the linear-algebra book reference the graph Laplacian as $L = D - A$, a human may want to align notation across the book for consistency.

### books/math/3-linear-algebra/4-svd-and-pca.md
- Major finding (noise-reduction threshold): the reviewer suggested adding the Gavish & Donoho 2014 optimal-hard-threshold formula (e.g. tau = 2.858*sigma_med, or (4/sqrt(3))*sqrt(n)*sigma) with a [@gavish2014optimal] citation. The citekey gavish2014optimal does not exist in mochi-lab/references.yaml, so adding it would fabricate an unverifiable citation. I took the reviewer's allowed alternative and relabeled the cell to remove the false optimality claim and the incorrect formula. A human may add the gavish2014optimal entry to references.yaml and then restore the precise optimal-threshold formula with the citation if desired.

### books/math/4-calculus-and-optimization/1-multivariable-calculus.md
- Please verify the five newly added references.yaml entries (authors, year, venue, arXiv URLs) against the canonical sources before publishing. They were filled from well-established bibliographic facts for these widely-cited papers, but the original file gave no entry to copy from, so a quick check is warranted: amos2017optnet (OptNet, ICML 2017, arXiv:1703.00443), bai2019deep (Deep Equilibrium Models, NeurIPS 2019, arXiv:1909.01377), chen2018neural (Neural ODEs, NeurIPS 2018, arXiv:1806.07366), choromanska2015loss (The Loss Surfaces of Multilayer Networks, AISTATS 2015, arXiv:1412.0233), draxler2018essentially (Essentially No Barriers..., ICML 2018, arXiv:1803.00885). Note one author's name was entered without diacritics (Gerard Ben Arous) to match plain-ASCII conventions; adjust if accented characters are preferred.

### books/math/4-calculus-and-optimization/2-convex-optimization.md
- nesterov1983method citation: the reviewer's blocker said this citekey does not resolve, but it ALREADY exists in /Users/zy45/Documents/Code/mochi-lab/mochi-lab/references.yaml (line 3342, with type/title/author/year/venue). I left the citation and references.yaml unchanged since the reference is present. The reviewer's entry suggested adding page numbers (543-547) and the exact title variant; the existing entry omits page/url fields. If the citation still renders as broken, a human should check the bibliography plugin's resolution logic rather than the citekey itself.

### books/math/4-calculus-and-optimization/3-non-convex-optimization.md
- The corrected saddle-point Remark cites only dauphin2014identifying (which exists in references.yaml). The reviewer also suggested Dean and Majumdar 2008 / Bray and Dean 2007 and the precise constant c = beta(ln 3)/4; I did not add those citations or the constant because those citekeys do not exist in references.yaml and I did not want to risk a broken citekey or an unverified constant. A human may add bray2007statistics / dean2008extreme entries and reinstate the exact constant if desired.
- The new reference entries use arXiv abstract URLs and standard venues (ICML/ICLR/NeurIPS/COLT) recalled from memory; they are canonical papers but a human should spot-check the arXiv IDs and the COLT 1999 DOI for mcallester1999pac before publishing.
- references.yaml was being modified by a concurrent process during this task (it grew from 7930 to 8306+ lines and gunasekar2018characterizing was added by something other than my edits); I appended via shell to avoid the Edit tool's stale-read conflicts. A human should confirm no duplicate keys were introduced by the concurrent writers.

### books/math/4-calculus-and-optimization/4-constrained-optimization.md
- Verify the URL I used for the new duchi2008simplex reference entry (https://dl.acm.org/doi/10.1145/1390156.1390191) matches the project's preferred citation link convention; the bibliographic fields (authors, title, venue, year) come directly from the reviewer's verified details, but please confirm the URL resolves to your liking.

### books/math/4-calculus-and-optimization/index.md
- The reviewer noted the same '--' separator convention is pervasive across sibling math chapter indexes (1-intro-to-comp, 2-ml-basics, 3-linear-algebra). Those files were out of scope for this single-file edit and were left unchanged; a coordinated site-wide fix is recommended.

### books/math/5-probability-and-statistics/2-distributions.md
- Please confirm the three newly added references.yaml entries (author lists, years, venues, arXiv IDs) render correctly via the bibliography plugin at build time; details were filled from well-known publication metadata but were not cross-checked against a live source in this session.
- The existing definitional Example 'ex-gaussian-precision' was kept intact; the rubric requirement for worked computation is now satisfied by the two new Examples, but if the reviewer wants the precision-matrix block reclassified as a Remark rather than an Example, that is a stylistic call left to the author.

### books/math/5-probability-and-statistics/3-bayesian-inference.md
- None of the findings were left unaddressed. Note: the Example numeric values (Beta-Bernoulli and Gaussian-mean) were computed directly from the conjugate-update formulas already stated in the file's tables and remarks, not fabricated; a human may optionally double-check the arithmetic (Beta(10,4) mean = 10/14 ~ 0.714; Gaussian posterior mean 7.5/3.5 ~ 2.143, variance 1/3.5 ~ 0.286).

### books/math/5-probability-and-statistics/4-information-theory.md
- csiszar1967information has no URL because the 1967 Studia Scientiarum Mathematicarum Hungarica article is print-only and I would not fabricate a link; verify/add a stable URL if one is wanted.
- Author lists, years, and venues for the six added references were filled in from well-known canonical metadata; a human may wish to double-check exact venue strings against the site's citation style conventions.

### books/math/5-probability-and-statistics/5-statistical-learning.md
- The belkin2019reconciling blocker was a false positive: the entry already exists in references.yaml (lines ~3511) with correct details, so no change was needed.
- I avoided MDX cross-reference components (e.g. <Theorem id=... />) in the new example since that self-closing pattern is not used anywhere else in this book and may not render; I used a plain-text reference instead. If the site supports such references, a human may convert it.

### books/math/6-advanced-ml-math/1-attention-and-transformers.md
- Author lists for the four newly added references were filled from well-known author rosters for these papers but were not cross-checked against the actual arXiv metadata in this session; a human should verify author names/ordering and the venue fields (I marked YaRN, GLU, and Ring Attention as 'arXiv' and ALiBi as 'ICLR' based on common knowledge). The arXiv IDs themselves come directly from the reviewer findings.

### books/math/6-advanced-ml-math/2-diffusion-models.md
- 8 of the broken citekeys remain unfixed because no matching entry exists in references.yaml and the rule forbids inventing references: hyvarinen2005estimation (Hyvarinen 2005 score-matching JMLR), lipman2023flow (flow matching), liu2023flow (rectified flow), lu2022dpm (DPM-Solver), nichol2021improved (improved DDPM / cosine schedule), peebles2023dit (DiT), song2021denoising (DDIM), song2023consistency (consistency models). Each cites a real paper, so the correct fix is to ADD the verified bibliographic entries to references.yaml rather than delete or remap them. This requires editing references.yaml (outside the target file) with verified citation data.
- song2021score (cited at lines for the score-diffusion connection and the three-views remark) was NOT remapped to the existing song2019score. song2021score refers to Song et al. 2021 'Score-Based Generative Modeling through SDEs' (the continuous-time SDE framework the text explicitly describes: dx = f dt + g dW), which is a DIFFERENT paper from song2019score ('Generative Modeling by Estimating Gradients of the Data Distribution', NeurIPS 2019). Remapping would mis-attribute the SDE result, so a human should add the correct song2021 SDE entry to references.yaml.

### books/math/6-advanced-ml-math/3-graph-neural-networks.md
- Reference metadata (exact author lists, venues, arXiv IDs) for the six newly added citekeys was supplied from well-known papers and should be spot-checked against the project's citation-style conventions, though each entry mirrors the format and fields of existing GNN references in references.yaml.
- Please rebuild/render the bibliography once to confirm the six [@key] citations resolve in the live build, since I validated YAML parsing and key presence but could not run the Docusaurus bibliography plugin in this environment.

### books/math/6-advanced-ml-math/4-optimal-transport.md
- None of the actionable findings were left unaddressed. The four added references are well-known papers I cited from established metadata (titles, authors, venues, arXiv IDs); please confirm the arXiv URLs and venues match your bibliography conventions before publishing.

### books/programming/0-intro.md
- The reviewer's justification for the frontmatter finding stated 'Sibling chapter files use frontmatter', but inspection shows the sibling chapter index.md files (1-intro-to-comp/index.md, 2-torch/index.md, etc.) do NOT use YAML frontmatter and themselves contain many '--' occurrences. I still added frontmatter to 0-intro.md as requested since it is safe and improves determinism, but if the site convention is intentionally frontmatter-free, a human may want to either revert this or apply frontmatter consistently across all sibling chapter files.

### books/programming/1-intro-to-comp/1-comp-machine.md
- The added <Example> blocks use a <details><summary>Solution</summary> disclosure for the faded-guidance reveal because this book's existing <Example> usage (programming/2-torch/1-tensors.md) does not show a built-in faded-answer mechanism. If the MDX component system has a dedicated 'fade'/'spoiler' prop or convention, a human may want to swap the <details> blocks for it.
- The ~10x figure in the code comment and the 60x DRAM-vs-HBM figure in rmk-ml-latency-implications are asserted approximations from the original author; the new examples ground the ~10x against a derived 16x ceiling, but I did not alter the author's original asserted multipliers since they are plausible and unverifiable from the file alone.

### books/programming/1-intro-to-comp/2-cpu-and-gpu.md
- Dropped the Turing (2nd-gen) Tensor Core row from the Definition table rather than fabricating its tile size, precisions, and peak TFLOPS. If a complete generation list is desired, a human should add a verified Turing/T4 (Tesla T4) row with sourced figures.
- Removed the 'Tile Size' column entirely to resolve the major shape-conflation finding. If the column is wanted, a human should re-add it with one consistent definition (either per-Tensor-Core hardware building block, e.g. V100 4x4x4, or warp-level MMA instruction shape, e.g. 16x8x16 for Ampere/Hopper) applied uniformly across all rows.

### books/programming/1-intro-to-comp/3-assembly-cuda-torch.md
- The Hopper 256 FP16 FMAs/clock and Volta/Ampere 64 FP16 FMAs/clock figures were taken from the reviewer's finding rather than independently verified against an NVIDIA source; please confirm these per-Tensor-Core throughput numbers before publishing.

### books/programming/1-intro-to-comp/4-hpc.md
- NVLink finding: I chose the reviewer's second option (adding an explicit unidirectional-vs-bidirectional clarifying note) rather than rewriting the table to bidirectional figures, to preserve internal consistency with the verified per-direction PCIe and InfiniBand rows. If you prefer the table itself to show conventional bidirectional NVLink numbers (600/900/1800 GB/s) under a relabeled header, that is a larger structural change I left for you.
- The 100 ms per-step backward-compute time used in both worked examples is explicitly labeled as an illustrative/assumed figure (not a measured benchmark) so no real number is fabricated; if you have a real per-step compute measurement for a specific model, substituting it would make the scaling-efficiency figures concrete.

### books/programming/2-torch/3-nn-module.md
- The worked Example uses a straightforward computed shape/param trace rather than the rubric's 'faded guidance' (partially-blanked) convention, since that pattern was not established elsewhere in this book and inventing it could conflict with house style; a human may want to adapt it to the preferred faded-guidance format if that is the intended convention.
- I set the full-checkpoint load to weights_only=False with an explanatory note rather than writing a concrete add_safe_globals([...]) call, because the exact globals to allowlist depend on the specific optimizer/scheduler classes used and I could not verify a correct, complete allowlist from the file alone; a human may prefer to substitute a precise add_safe_globals/safe_globals example for their stack.

### books/programming/2-torch/4-data-loading.md
- The 30-50% padding-savings range is a general claim about NLP workloads; I grounded it with one verified worked example (41%) but did not change the range itself, since I cannot verify a specific benchmark source for the stated band. If a citation or measured figure exists, a human may want to attach it.

### books/programming/2-torch/5-training-loop.md
- Optional alternative for the OneCycleLR finding: instead of relabeling the comment, the author could switch the main training loop to the LambdaLR linear-warmup+cosine schedule (option 3 in code-lr-schedules) so the loop matches the LLM-standard schedule the section calls standard. I applied the conservative relabel instead; the author may prefer the swap for pedagogical consistency.

### books/programming/3-cuda-and-gpu/index.md
- The reviewer note mentions the same " -- " pattern appears in sibling index.md files and should be fixed consistently across the book. My task was scoped to this single file, so I did not edit the sibling chapter index.md files; a human (or a follow-up pass) should apply the same colon replacement to them.

### books/programming/4-assembly/1-x86-basics.md
- The reviewer suggested `-mfma` (or `-Ofast`) as alternatives to emit vfmadd. I used `-march=native -ffast-math`, which on a modern CPU implies FMA and reassociation, so the shown `vfmadd231ps` is consistent. If the author wants the exact flag set spelled out (e.g., adding `-mfma` explicitly), they may refine the comment further, but the current form is correct and not contradictory.

### books/programming/4-assembly/3-simd.md
- rmk-simd-simt-mental-model (line 227) still describes GPU warps executing 'in lockstep'. This is a general conceptual framing and was not in the reviewer's flagged list, so I left it to stay conservative, but it shares the same Volta independent-thread-scheduling nuance flagged for the table and may warrant a parallel softening if the author wants full consistency.
- The 'Divergence' cell for the GPU SIMT column still says 'Possible but expensive (serialized branches)', which is also affected by Volta's independent thread scheduling. The reviewer only asked to soften the CPU SIMD cell, so I left the GPU cell unchanged.

### books/programming/5-ml-systems/3-inference-optimization.md
- SmoothQuant (W8A8) row in the quantization table makes an external claim but has no citekey in references.yaml (no smoothquant/xiao2023 entry exists). I did not fabricate a citation; the author should add a SmoothQuant entry (e.g., Xiao et al. 2022) to references.yaml and cite it. Other named techniques in the serving-systems table without dedicated citekeys I could verify (continuous batching, prefix caching, FlashDecoding, CUDA Graphs) were left uncited for the same reason; only PagedAttention and FlashAttention had resolvable keys.
- Quantitative claims I could not verify from the file or its real sources were left unchanged to avoid fabrication: the specific acceptance-rate/speedup figures in the speculative-decoding table (e.g., ~70% / 2-2.5x), the quantization speed multipliers, the BitNet 4-8x theoretical figure, the 0.1-0.5 perplexity range, and the 3.35 TB/s / 990 TFLOPS H100 numbers. These should be spot-checked against primary sources and cited where appropriate.

### books/programming/5-ml-systems/4-profiling.md
- The reviewer noted the chapter index.md also uses `--` in its bullet list. That is a different file outside the assigned File path, so I did not edit it. The human should apply the same `--` removal to the chapter index.md.

### books/programming/5-ml-systems/index.md
- The reviewer noted the same ' -- ' separator violation exists across all sibling chapter index pages and suggested a global convention fix. I only edited the targeted file (5-ml-systems/index.md) as instructed; applying the same colon convention to sibling index.md files is left for a human/global pass.

### books/programming/99-supplement/3-git-for-ml.md
- None. Both actionable findings (em-dash removal and the missing narrated <Example>) were fixed in place. Remaining '--' occurrences are intentionally preserved because they are working git CLI flags, git pathspec separators, YAML frontmatter delimiters, or Markdown table rules; removing them would break code or document structure.

### books/survey/ch1-continual-learning/architecture-methods.md
- Did not add a concrete comparative benchmark number with its setting (e.g., DER/FOSTER accuracy on CIFAR-100 or ImageNet-100 class-IL, or PackNet/HAT capacity-vs-task-count tradeoff) as requested under Rubric C, because no such figures appear in the file and I cannot verify exact numbers from the sources without fabricating them. I addressed the related part of the finding by qualifying the zero-forgetting claim structurally (frozen parameters => no backward transfer) in both locations, but a human should insert a verified empirical number with its evaluation setting to fully satisfy the comparative-number requirement.

### books/survey/ch1-continual-learning/benchmarks.md
- The Split-CIFAR-100 method-vs-joint-training gap is now qualified as approximate/non-numeric because no primary source (survey table or flagship paper) reporting a specific percentage could be verified from the file or its existing citekeys. If a concrete figure is desired, a human should cite a verifiable primary source and restore a specific number.
- Per-entry scale figures for Rotated MNIST (number of rotation angles/tasks), Split-CUB-200 (exact task split), and VTAB Sequence (number/identity of constituent tasks) were described using common/typical conventions rather than exact cited values, since the file provides no citation pinning a canonical configuration for these entries. A human may want to add precise numbers tied to a specific source/paper.

### books/survey/ch1-continual-learning/connections.md
- None. All actionable findings were fixable safely from the file content without fabricating new sources or results.

### books/survey/ch1-continual-learning/index.md
- MRCL/CLS-ER citation finding: the reviewer's quoted text is not present in the current chapter (the issue appears already resolved in meta-continual-learning.md, which the reviewer-cited index.md does not even contain). No safe edit was applicable; please confirm the reviewer was looking at a stale version.
- The reviewer assigned File path was index.md, but the MRCL finding references content in meta-continual-learning.md; flagging the path mismatch for human verification.

### books/survey/ch1-continual-learning/introduction.md
- Citation Integrity (de Lange et al. 2021): I removed the specific Split-CIFAR-100 first-task drop figure (90% to below 20% after 10 tasks) because it cannot be attributed to that survey, and I could not verify a correct replacement number/source without fabricating. If you want a concrete quantitative example of first-task forgetting, please supply a paper that actually reports a Split-CIFAR-100 sequential-fine-tuning first-task drop (or a number de Lange et al. report on Tiny ImageNet / iNaturalist) and re-insert it with the correct citekey.

### books/survey/ch1-continual-learning/llm-continual-learning.md
- Recommend verifying the corrected references.yaml metadata for ibrahim2024investigating (title/venue/url) and the rewritten claim that the 405M/10B recipe matches from-scratch training against the actual arXiv:2403.08763 paper, since these were corrected based on the reviewer's stated facts rather than direct inspection of the source.
- The ibrahim2024investigating references.yaml entry still lists only 'Adam Ibrahim' as sole author; the real paper has multiple coauthors. I left the author list unchanged to avoid fabricating names not present in the file.

### books/survey/ch1-continual-learning/meta-continual-learning.md
- ANML superlative: I replaced 'outperforms OML on several benchmarks' with a qualified accuracy-retention claim on sequential Omniglot, but did NOT add exact N-way accuracy numbers because I could not verify them from the file or its sources. A human should insert the specific Omniglot N-way accuracy figures (e.g., ANML vs OML at 600 classes) from Beaulieu et al. (2020) to fully satisfy the 'concrete numbers' rubric.
- La-MAML comparison: I removed the fabricated 'matches or exceeds OML and ANML' head-to-head and substituted an applicability/regime contrast that is safe and accurate, but the synthesis table and paragraph contain no numeric metrics (accuracy/forgetting) because none are verifiable from the file. A human should add concrete numbers from the La-MAML and CLS-ER papers (e.g., retained accuracy and backward transfer on CIFAR-100 / TinyImageNet splits) to make the comparison quantitative.
- Comparison table 'Primary evaluation regime' / 'Replay required' entries are derived from method descriptions in the text and standard knowledge of these papers; a human should confirm the exact benchmark names and whether CLS-ER's replay buffer details match the cited source before publishing.

### books/survey/ch1-continual-learning/open-problems.md
- For the three major claims (diffusion more amenable to continual training, generative-model memorization leaking samples, DP noise worsening forgetting), I softened them to speculative/conjectured framing rather than adding citations, because I could not verify from the file whether @gao2023ddgr or any cited source actually substantiates these specific comparisons. If real primary references exist (e.g., a memorization/extraction study for diffusion models, or a DP-CL tradeoff paper), a human could replace the hedged wording with a direct citation to strengthen these passages.

### books/survey/ch1-continual-learning/prompt-based-methods.md
- HiDe-Prompt benchmark number: the reviewer asked for the specific reported accuracy of HiDe-Prompt vs CODA-Prompt on Split-ImageNet-R. I added the qualitative comparative takeaway and tradeoff but did NOT insert a numeric figure, because I could not verify the exact percentage from the file or its sources without risking fabrication. Please fill in the verified number (e.g. HiDe-Prompt vs CODA-Prompt's 72.80%) from the HiDe-Prompt paper (Wang et al. 2024, arXiv:2310.07234).
- Comparison-fairness citation: I dropped [@kim2023achieving] rather than replacing it, because I could not confirm from the available references which paper actually makes the pre-trained-vs-from-scratch fairness argument. Candidates already in references.yaml include mehta2023empirical ('An Empirical Investigation of the Role of Pre-training in Lifelong Learning') and mehta-adjacent works, but I could not verify any of them explicitly argues the comparison is 'unfair', so I left the sentence uncited. Please add a verified citation if one exists.

### books/survey/ch1-continual-learning/regularization-methods.md
- Currency finding: I scoped the chapter to pre-2023 classical methods rather than adding 2023-2025 citations (L2P, DualPrompt, CODA-Prompt, LLM continual learning), because I could not verify that bibliography citekeys exist for those works and must not fabricate citekeys. If the bibliography contains entries for these, a human should replace the scoping note with actual citations to recent regularization-adjacent work.
- Comparative claims: I attributed the PODNet/BiC/WA claims to their primary sources but did not insert concrete numbers (dataset, step count, accuracy deltas) because none were present in the file and I cannot fabricate benchmark figures. A human with access to the primary papers should add the specific quantitative results to fully ground these load-bearing claims.

### books/survey/ch2-world-models/benchmarks.md
- Benchmark/metric citations (CALVIN, Atari 200M, FVD, SSIM/PSNR/LPIPS, RoboNet/Something-Something/Kinetics, PhysBench) were NOT added. None of these have existing citekeys in references.yaml (the project has no .bib file; citations are defined in mochi-lab/references.yaml). Adding [@citekey] references would require inventing new citekeys and bibliography entries with verified author/year/venue/url, which would risk broken citations and fabrication. A human should add verified primary-source entries to references.yaml (e.g. CALVIN: Mees et al. 2022; PhysBench: relevant 2024/2025 paper; FVD: Unterthiner et al. 2018; SSIM: Wang et al. 2004; LPIPS: Zhang et al. 2018; Something-Something: Goyal et al. 2017; Kinetics: Kay et al. 2017; RoboNet: Dasari et al. 2019) and then cite them in this section.
- The CALVIN and PhysBench capability claims (CALVIN 'chains 5+ sub-tasks'; PhysBench tests 'object permanence, gravity, collision dynamics') were left as-is since the underlying prose is plausible but I could not verify the exact numbers/capability list against a source from within the file; once citations are added these claims should be checked against the primary sources.

### books/survey/ch2-world-models/classic-world-models.md
- All actionable findings were addressed in place. No claims, numbers, or citations were fabricated; the Dreamer v2 correction uses only the metric described in the reviewer's finding (roughly human-level median, gamer-normalized) rather than inventing a figure. If the author prefers a literal comparison table over the prose synthesis I added, that is an optional stylistic upgrade left to their discretion.

### books/survey/ch2-world-models/foundation-world-models.md
- Genie 3 source quality: the citation deepmind2025genie3 resolves to a DeepMind product/blog page (deepmind.google/models/genie/), not a primary technical report. I flagged this inline and softened the wording, but a human may want to locate a proper technical report or confirm whether the vendor-claim caveat is sufficient for the survey's standards.
- Sora world-model debate citation: I removed the misattributed @lecun2024sora_critique citekey rather than substituting a source, since I cannot verify an appropriate primary source for the Sora world-model debate from the file. If a real citation exists (e.g., a specific critique or position paper), a human should add it where the citation was removed in the 'Sora and Video Generation' section.

### books/survey/ch2-world-models/index.md
- references.yaml still contains a duplicate citekey @janner2019trust (line ~7379) identical to @janner2019when; I did not delete it because it is a shared bibliography file and removing an entry risks breaking citations in other chapters. It is now unused within ch2; safe to remove after a repo-wide check.
- DreamerV3's Atari-100k score is internally inconsistent across files: taxonomy.md states 1.19 (the reviewer-referenced original) while benchmarks.md and foundation-world-models.md state ~1.10/1.097 (the DIAMOND comparison-table value). I could not verify which figure is authoritative without the source, so I did not force a single value. Pick one sourced number and make all three files consistent.
- The SimPLe Atari-100k value (now ~0.144 median) and the added citations on the benchmark entries still need a verified originating source/citekey. The reviewer vouched for ~0.144 but asked for the originating comparison table to be cited; that citekey does not exist in references.yaml and must be added by a human who can verify it.
- Benchmark entries CALVIN, RoboNet/Something-Something/Kinetics, FVD/SSIM/PSNR/LPIPS, and PhysBench still lack real citekeys (none exist in references.yaml). I added explicit 'no headline number established / citation to be added' notes instead of fabricating; a human should add the proper bibliography entries and dataset scales.
- A concurrent process (likely another workflow agent or linter) was actively editing taxonomy.md, benchmarks.md, and introduction.md during my pass and repeatedly reverted/blocked edits; please re-verify the final state of these files, especially taxonomy.md line 22, in case of further races.

### books/survey/ch2-world-models/introduction.md
- Currency: I added only one verified 2025 anchor (@deepmind2025genie3) confirmed present in the sibling foundation-world-models.md. The reviewer suggested anchoring 'one or two' 2025 works; the sibling file's only 2025 citekey is deepmind2025genie3 (Cosmos and DIAMOND there are 2024). If additional 2025 anchors (e.g., an updated GAIA or a 2025 video-world-model line) exist in the bibliography, a human should add them, since I could not verify other 2025 citekeys without risking a broken/fabricated reference.

### books/survey/ch2-world-models/open-problems.md
- The references.yaml entry `lecun2024sora_critique` (line 4576) is still a verbatim duplicate of `lecun2022path` (year 2022, same OpenReview URL). I did not repoint it to LeCun's actual Feb 2024 Sora critique (LinkedIn/X posts) because I cannot verify the exact URL/date/wording without fabricating a source. I instead removed the in-text reliance on it. If you want to preserve a genuine 2024 attribution, update that bib entry with the real 2024 statement and revert the in-text year to (2024).

### books/survey/ch2-world-models/reasoning.md
- Dynalang: I named the real benchmarks (HomeGrid, Messenger, LangRoom, VizDoom) and the qualitative result, but did NOT insert a concrete numeric score (e.g., exact reward/success-rate figures) because I cannot verify specific numbers from the file or recall them reliably from the source. Please add at least one verified concrete result with its metric from Lin et al. 2024.
- Problem Formulation / Evaluation Rigor: the reviewer also flagged the absence of any formal problem framing for 'reasoning as world modeling', named metrics, and evaluation pitfalls across the chapter. I did not add these, as doing so safely would require introducing substantial new framing/claims beyond conservative in-place edits and beyond what the file's sources let me verify. Consider a dedicated problem-formulation/metrics paragraph.

### books/survey/ch2-world-models/reinforcement-learning.md
- GenRL grounding with concrete numbers: the reviewer asked to ground the tradeoff with concrete benchmark figures. I added qualitative counter-evidence and an open-comparison caveat but did not insert specific DIAMOND/STORM vs MuZero/EfficientZero numbers, since I could not verify exact matched-budget figures from the file or its sources and the rules forbid fabricating benchmark numbers. A human should add verified head-to-head numbers if desired.
- Broader theme-by-theme reorganization: the major synthesis finding noted that 'several others' (besides Clavera) are subsections headed by method/author names without comparative takeaways. The actionable instruction named only the Clavera subsection, which I fixed. A full chapter-wide reorganization into thematic groupings with comparative takeaways for every subsection would be a rewrite rather than a conservative in-place edit, so I left it for human judgment.

### books/survey/ch2-world-models/taxonomy.md
- Atari 100k SimPLe value: the file (after an external linter edit) shows the SimPLe figure with a hedge word and I set the number to 0.44 per the reviewer's stated ~0.44 mean HNS, but please double-check the exact decimal and rounding against the SimPLe/Kaiser et al. paper (arXiv:1903.00374) since the prior text had drifted to 0.144.
- DreamerV3 mean HNS: I set it to 1.12 within the reviewer-stated 1.10-1.12 range; verify the exact headline mean against the DreamerV3 paper (arXiv:2301.04104) before publishing.
- Diffusion calibration: I softened the claim rather than citing, because no source establishing calibration for diffusion world models could be verified from the file. If a supporting citation exists, consider adding it instead of the hedge.
- Some bold-named methods in the generative-paradigm and structure facets were left without inline citekeys where the method has no clearly-resolvable primary-source citekey in references.yaml or is already cited on the same line (e.g., SVG, FitVid, Video Diffusion, VideoGPT/STORM in the autoregressive line which already carry a grouped citation). Confirm these are acceptable or supply citekeys.

### books/survey/ch2-world-models/video-prediction.md
- Citekey rename: left `zhang2025storm_wm` unchanged rather than renaming to `zhang2023storm`. Renaming a citekey requires updating every in-text [@zhang2025storm_wm] reference across all chapters and the references.yaml key atomically; doing it from this single-file scope risks breaking citations elsewhere. The misleading date in the key remains, but the rendered year is now correct (2023). A human should do the global rename if desired.
- Comparative table: the reviewer suggested an explicit table contrasting paradigm, resolution/fps, and training data across the seven diffusion systems. I added a comparative prose takeaway instead. The file only states resolution/fps for Imagen Video (1280x768, 24 fps); building a full table would require resolution, fps, and training-data figures for the other six systems that I cannot verify without fabricating numbers. A human with the source papers should add the table.

### books/survey/ch3-efficient-architecture/benchmarks.md
- LRA results table: the chapter asserts 'S4 and Mamba achieved breakthrough results on LRA, particularly on PathX' without numbers. I did not add a results table because that would require specific accuracy figures (e.g. SSM vs Transformer averages, PathX accuracy) that I cannot verify from the file or its cited sources without fabricating them. A human should add a small table sourced from the S4/Mamba/LRA papers.
- MLPerf claim: I removed the precise '2-4x' and 'roughly equally' apportionment rather than citing it. If the author wants to retain a concrete speedup figure, they should add a citation to the specific MLPerf round results that supports it.
- H100 throughput: I qualified the number as an order-of-magnitude estimate. If a precise figure is desired, the author should cite published vLLM/TensorRT-LLM serving benchmarks with the exact precision/batch-size assumptions.

### books/survey/ch3-efficient-architecture/efficient-attention.md
- NSA speedup: the reviewer asked for a concrete speedup number and regime, but I could not verify NSA's exact reported figures from the file or its cited source, so I changed 'achieves significant speedups' to 'reports speedups' and added a balancing limitation rather than fabricating a number. A human should fill in the specific speedup factor and benchmark/regime from Yuan et al. (2025).
- MLA numbers (93.3% KV-cache reduction) were supplied from knowledge of the DeepSeek-V2 paper, not from a source file present in the repo. A human should confirm the exact figure and that the quality claim matches the benchmarks reported in the paper before publishing.
- Intro scope sentence ('surveys approaches that reduce this cost while preserving or approximating...') was left unchanged; the one-sidedness the reviewer flagged was addressed at the per-family level by adding limitations, which is the safer targeted fix.

### books/survey/ch3-efficient-architecture/efficient-training.md
- The original 'hundreds of American households use in a year' energy figure could not be verified against strubell2019energy (which studies NLP training energy/CO2 but not this specific framing). I replaced the unverifiable specific claim with a general, source-supported statement about energy/policy costs rather than fabricating attribution for the exact number. If the original specific figure is desired, a human should confirm a source for it.
- epoch2023trends is titled 'Trends in Machine Learning Hardware' rather than a dedicated GPT-4 compute estimate; it is the correct Epoch AI org source available in references.yaml, but if a more precise Epoch AI GPT-4 FLOP estimate citation exists it would be a stronger reference and should be substituted by a human.

### books/survey/ch3-efficient-architecture/index.md
- A concurrent formatter/editor substantially expanded several chapter files beyond em-dash removal (e.g. efficient-training.md gained a new 'Choosing Among the Techniques' section and new citekeys @epoch2023trends and @strubell2019energy, and revised the GPT-4 FLOP figure). These were not my edits; please confirm the new citekeys resolve in references.yaml and that the revised figures are accurate, as they fall outside the assigned findings.
- PathX/Path-X accuracy was set to 'roughly 88%' by the concurrent formatter, consistent with the reviewer's cited primary-paper range (~88-96%). If you want the exact reported Path-X number from arXiv:2111.00396 rather than an approximation, verify against the paper.
- For the BASED pair I kept @arora2024based (fuller author list) as canonical; if your house preference is the shorter @arora2024simple key, swap the canonical and the deletion accordingly.

### books/survey/ch3-efficient-architecture/inference-optimization.md
- The reviewer noted the annotated-list pattern also recurs in the Compilation section. I did not add a comparative takeaway there because that subsection lists only two items (torch.compile/TorchInductor and TensorRT-LLM) which are different categories (a general PyTorch compiler vs an NVIDIA-specific inference library) rather than competing methods with a clear tradeoff; writing a comparison would risk fabricating a benchmark contrast I cannot verify from the file. Optional: a human could add a one-line note that torch.compile is hardware-agnostic while TensorRT-LLM maximizes throughput specifically on NVIDIA hardware, but I left it unchanged to avoid unsupported claims.

### books/survey/ch3-efficient-architecture/introduction.md
- Training-cost projection: I removed the >$1B projection and the GPT-4 >$100M figure plus the mis-cited epoch2023trends citation rather than fabricate a correct source. If you want quantitative cost claims restored, add a verified Epoch cost-of-training citation (their training-cost analyses, not the hardware-trends entry) and reinsert the specific figures with that source.
- Transistor-density deceleration: I softened the load-bearing 'compute wall' claim to a general statement because the precise '2x every 3-4 years' figure was uncited. If you have a source (e.g., an Epoch or industry hardware-trends reference), you may restore the quantitative form with a citation.

### books/survey/ch3-efficient-architecture/mixture-of-experts.md
- Currency finding partially deferred: I did not add Qwen-MoE, DBRX, or Grok, since references.yaml has no entries for them and I will not fabricate citations/figures. The requested auxiliary-loss-free load balancing advance was added; the other 2024-2025 open MoE models need a human to supply verifiable references.yaml entries and figures before being cited.
- Table cells for ST-MoE, DeepSeek-MoE, BASE, and Expert-Choice use 'n/a' for total/active params because the file does not state released-model parameter counts for these (they are design studies, an architecture, or routing methods); a human can fill exact released-checkpoint numbers if a specific model is intended.

### books/survey/ch3-efficient-architecture/open-problems.md
- The 'tens of millions of dollars' training cost is now attributed as 'widely-reported estimates' rather than carrying a specific citation; if a precise source (e.g., an Epoch AI cost estimate) is desired, a human should add the proper citekey since I cannot verify a specific source from the file.
- The o1/o3 inference-compute claim was softened to 'orders of magnitude' rather than cited; if the author wants to retain the quantitative '100x' figure, a human should add a verifiable citation (e.g., OpenAI o1 system card / inference-scaling results).

### books/survey/ch3-efficient-architecture/peft.md
- Comparative-table cells use only parameter fractions and qualitative descriptors already stated in the prose (e.g., LoRA 0.01-0.1%, Adapters 3-5%, Prompt Tuning 0.001%). I did not add any new quantitative memory-savings or accuracy figures because the source text does not provide verifiable numbers for those columns; if precise figures are desired they should be sourced from the cited papers by a human.

### books/survey/ch3-efficient-architecture/problem-formulation.md
- Could not add the Chinchilla scaling-law replication/critique citation requested by the currency finding (e.g., Besiroglu et al. 2024 'Chinchilla Scaling: A replication attempt', or Porian et al. / Hagele et al.). No corresponding citekey exists in references.yaml and I will not fabricate one. To fully satisfy the finding, add such an entry to references.yaml and a sentence noting that the Chinchilla coefficients have been subject to replication scrutiny.

### books/survey/ch3-efficient-architecture/state-space-models.md
- Reviewer counted 5 '--'/em-dash occurrences, but a unicode and literal search of the current file found zero in the body (only the two required frontmatter '---' fences remain). The dashes appear to have been removed already in a prior pass; please re-confirm against the version the reviewer saw if this is unexpected.
- Could not independently verify the exact Path-X number against Table 8 of the primary paper from within this environment; I used the reviewer-supplied 88% (88.10). Please confirm against the source before publishing.
- Added the S4D reference using arxiv ID 2206.11893 and author list Gu, Goel, Gupta, Re per the reviewer's metadata; please verify the arxiv ID and author order are exactly correct.

### books/survey/ch3-efficient-architecture/sub-quadratic-architectures.md
- The BASED quantitative figures (24x decoding throughput over FlashAttention-2; recall-slice perplexity ~2.29 vs Transformer 1.87) were taken verbatim from the reviewer's finding, which attributes them to the BASED paper. I could not independently verify these numbers against the primary source from within the file; please confirm they match the published BASED paper before relying on them.

### books/survey/ch3-efficient-architecture/taxonomy.md
- Reviewer counted 4 '--' but the file body contains only 2 real '--' occurrences (intro paragraph and the MoE/family-4 sentence), both now removed. The other two dashes the count likely refers to are the YAML frontmatter delimiters on lines 1 and 4 ('---'), which are valid frontmatter syntax and were intentionally left untouched per the rule to preserve frontmatter. No unicode em/en-dash characters exist in the file.

### books/survey/ch4-agentic-search/agentic-web-search.md
- Table entries for VisualWebArena (~910 tasks), Mind2Web (n/a human baseline), GAIA (~466 tasks), and AgentBench (n/a task count) use approximate or n/a values because exact figures were not present in the file or its cited numbers; verify these against the original papers before publishing.
- The 'roughly 64 points' (WebArena) and '60 / 77 points' (OSWorld / GAIA) gap figures in the new comparative prose are arithmetic derived from the verified pairs in the file (78.24-14.41, 72.36-12.24, 92-15); please double-check the rounding/phrasing is acceptable.

### books/survey/ch4-agentic-search/benchmarks.md
- The 2026 currency figures I added (WebArena ~60% via IBM CUGA, SWE-bench Verified 70%+, OS-World ~human baseline via Claude Opus/Sonnet) are drawn from the reviewer's own stated findings, not from sources I could independently verify in this environment. Please confirm these specific numbers and consider attaching a primary leaderboard/source citation for the SWE-bench Verified 70%+ figure, which the reviewer flagged as currently uncited and for which I added only the OpenAI Verified-release citation (covering the 500-task/human-verification claim).
- I could not load the bibliography plugin/site build to confirm the three new references.yaml entries render correctly; please run the docs build to confirm the new citekeys resolve and that the metadata (venues/years for chen2024rgb=AAAI, yao2024taubench=arXiv) matches your preferred bib style.

### books/survey/ch4-agentic-search/connections.md
- Could not add the reviewer's suggested ColBERT-vs-cross-encoder latency numbers or HNSW recall/QPS-tradeoff figures: these specific benchmark numbers are not present in the file and adding them would require fabricating or citing figures I cannot verify from the file or its sources. The takeaways were made comparative/qualitative with only the one number (100x fan-out) that is safely derivable from existing text. A human with access to the underlying papers could insert verified latency/recall/QPS figures.
- Note: a linter reverted my SGLang citekey from [@zheng2024sglangradixtree] (the more specific RadixAttention entry) to [@zheng2024sglang]; both resolve in references.yaml to the SGLang paper, so the citation is valid, but if the more specific RadixAttention reference is preferred it can be switched back.

### books/survey/ch4-agentic-search/mcts-llms.md
- Reflexion limitation: the reviewer noted it 'underperforms GPT-4 on MBPP Python.' I added the underlying mechanism (false positives from self-generated unit tests, no uniform dominance on every code benchmark) but did NOT state the specific MBPP-vs-GPT-4 claim as a hard figure, since I could not verify the exact comparison from the file or its cited source (arXiv:2303.11366). A human may want to add the precise MBPP result with a verified citation.
- Optionally consider whether the file's sidebar_position/filename (mcts-llms.md) and the taxonomy.md node 5 label ('Search with Planning (MCTS + LLMs)') should be reconciled with the new broader section title. I renamed only the in-file title/heading per the conservative-edit instruction; the filename and the taxonomy.md cross-reference were left unchanged to avoid breaking links and to stay within scope.

### books/survey/ch4-agentic-search/multi-hop-reasoning.md
- Compositionality-gap quantitative claim (Press et al. 2023): the reviewer wants the specific gap fraction and the model it was measured on. I could not verify the exact figure from the file or its bibliography entry without fabricating a number, so I left the claim qualitative ('substantial even in frontier models'). A human should add the precise gap percentage and model from the paper.
- Comparative table 'reported gains' column: I intentionally did NOT include a numeric gains column in the comparison table because verified, model/setting-matched gain figures are not available in the file for most methods (FLARE, DSP, ITER-RETGEN, ITRG, Adaptive-RAG). Adding them would risk fabrication. A human with the papers can add a gains column with model/protocol context.
- Benchmark definitions: I added brief one-line characterizations of HotpotQA and 2WikiMultiHopQA where introduced, and StrategyQA already had one. I did not add scale/size figures (number of questions) since those were not verifiable from the file.

### books/survey/ch4-agentic-search/open-problems.md
- The revised o1/AIME figures (GPT-4o ~12%, o1 ~74% pass@1, 83% with 64-sample consensus) follow the reviewer's suggested wording from OpenAI's 'Learning to Reason with LLMs'; please confirm these match the @openai2024o1 source as cited, since I could not independently verify the exact numbers from the file alone.
- If a verifiable primary source for Deep Research query counts/per-query cost exists, the quantitative claim could be restored with a citation; I removed the specific numbers rather than fabricate a source.

### books/survey/ch4-agentic-search/problem-formulation.md
- The SAFE figures (~72% agreement; 76% win on the 100-case subset) were taken from the reviewer's description of Wei et al. 2024; please confirm they match the published numbers in arXiv:2403.18802 before publishing.
- The cost estimate now states 'a few dollars per million input tokens' as the assumed API price; verify this matches the specific frontier model intended, since prices vary by provider and tier.

### books/survey/ch4-agentic-search/retrieval-augmented-generation.md
- The reviewer counted 6 '--' occurrences but only 4 existed in prose (lines 16, 22, 38, 62), plus the two YAML frontmatter '---' delimiters on lines 1 and 4 which must remain. If the reviewer was counting the frontmatter delimiters, those cannot be removed without breaking the document. All actual prose dashes are now fixed.
- The comparison table characterizes each system along three axes using only facts asserted elsewhere in the file. A human may want to verify edge cases (e.g., whether RAG/FiD retrievers are best described as strictly 'frozen' versus lightly tuned, and Atlas's exact augmentation-stage label) against the primary papers before publication, since I deliberately avoided introducing any details not already stated in the chapter.

### books/survey/ch4-agentic-search/self-improving-search.md
- Co-STORM / STORM-2 claim was deleted rather than re-cited because no resolving entry (Jiang et al., 2024, 'Into the Unknown Unknowns') exists in references.yaml; if you want that content restored, add the citekey + reference entry and reinsert a supported sentence.
- I did not insert a concrete numeric figure for the STORM FreshWiki human eval (e.g., exact rubric scores) because the file and its cited reference entry do not provide a verifiable number; I qualified it as a rubric-based qualitative finding instead. Add the specific scores from the NAACL 2024 paper if a quantitative figure is desired.
- I did not add specific BrowseComp/GAIA scores for OpenAI Deep Research since no verifiable figure was available in the file; the superlative was softened and the benchmarks named generically. Insert a concrete score with a citation if you want a quantitative claim.

### books/survey/ch4-agentic-search/taxonomy.md
- The two range hyphens '~75-90%' and '~15-30%' (line 16) are legitimate numeric ranges, not em-dashes, so they were left unchanged; no action needed unless house style requires en-dashes there.
- Author/coverage details for the new qin2023toolllm bibliography entry (third author listed as 'Yining Ye') were taken from the standard ToolLLM author list; a human should confirm the full author list matches the canonical citation if strict accuracy is required.

### books/survey/ch4-agentic-search/tool-augmented-retrieval.md
- The new numerical claims for WebGPT (69% / 56%) and Toolformer benchmark names (SVAMP, ASDiv, MAWPS, TriviaQA, WebQuestions, Natural Questions) and the ToolLLM details (16,464 APIs, 49 categories, DFSDT) were supplied per the reviewer's findings, which cite the source papers; a human should do a final spot-check against the original papers since I could not open the PDFs directly in this session.
- The synthesis table's 'relative training cost' column is a qualitative characterization (High/Moderate/None) derived from each method's described supervision approach, not from reported FLOP/compute numbers; verify it reads as intended editorially.

### books/survey/ch5-randomized-signal/benchmarks.md
- Reviewer counted 23 '--' instances, but the file has no em-dashes/en-dashes in prose; the only '--' are required Markdown syntax (frontmatter fences on lines 1 and 4, table separator on line 29). These cannot be removed without breaking rendering, so they were intentionally preserved. Please confirm the reviewer was not counting these structural dashes.
- JL numeric example: I used the standard constant 8 (from the common JL formulation k >= 8 ln n / epsilon^2) yielding ~11,000 dimensions, matching the reviewer's recompute. If the chapter prefers a different specific JL constant/variant (e.g., 4 ln n / (epsilon^2/2 - epsilon^3/3), or the over-pairs log giving ~22,000), adjust the stated number and constant accordingly.
- The Quality Retention table cells (95-99%, 99%+, 92% of BERT, etc.) still lack a single authoritative metric+dataset per cell; I added a non-comparability note plus two grounded examples rather than fabricating per-cell metrics/protocols for every row, since the exact metric/dataset for several rows (e.g. Performer 95-99%, Reformer 95-98%, SLIDE 'Equal accuracy') is not verifiable from the file. A human with the source papers could fill in per-row metric/dataset/baseline if desired.

### books/survey/ch5-randomized-signal/bloom-filters.md
- Embedding-table-lookup, data-selection, and MoE-routing bullets were softened rather than cited because I could not verify a specific primary source (e.g., a learned/compositional embedding-hashing recsys paper) from the file or references.yaml. If a real primary source exists, add the citekey and restore the stronger empirical phrasing.
- The 36% memory reduction at 1% FPR figure for learned Bloom filters was taken from the reviewer's note about the Kraska et al. (2018) paper; please confirm it against the paper before publication since I could not open the source directly.
- If the learned-Bloom-filter theory (sandwiching design) is to be discussed, a Mitzenmacher (2018) 'A Model for Learned Bloom Filters' entry should be added to references.yaml; I did not add a new citekey to avoid fabricating a bibliography entry. The now-unused kriss2018adaptive citekey remains valid in references.yaml but is no longer referenced from this file.

### books/survey/ch5-randomized-signal/fourier-spectral.md
- The 1/f^2 natural-image result is attributed in-text to Field (1987) and Ruderman (1994) by name, but no citekeys exist in references.yaml for them. I did not fabricate citekeys. A human should add field1987 / ruderman1994 bib entries and convert the inline attributions to @-citations.
- Pangu-Weather and spherical Fourier neural operators are acknowledged by name (per the reviewer's currency note) but have no citekeys in references.yaml. I did not invent citekeys; a human should add the corresponding bib entries (e.g. bi2023pangu, bonev2023spherical) and cite them. GraphCast was citable (@lam2023graphcast) and is cited.
- The FNet TPU detail (quadratic DFT matrix below 4,096 tokens) and the FourCastNet node-hour basis / lead-time regime were taken from the reviewer's stated verified facts rather than independently re-verified against the source papers; a human with the papers open may want to confirm the exact threshold/phrasing.

### books/survey/ch5-randomized-signal/hashing.md
- Finding 3 (HNSW/LSH): I described the ann-benchmarks comparison and the regime where each method wins, but did not add a new citekey for the ann-benchmarks suite because no such citation exists in the file and I will not fabricate one. If a bibliography entry for ann-benchmarks (e.g. Aumuller et al.) is available, a human should add the citekey to the new sentence for full grounding.
- Finding 1 (learning-to-hash speedup): I removed the unverifiable 10-100x figure and replaced it with a regime-dependent qualification rather than attributing a specific number to HashNet or Deep Supervised Hashing, because the file and its cited sources do not give a verifiable dataset/bit-length/recall@k operating point. If the author wants a concrete headline figure, they should supply the method, dataset, bit length, and recall metric from the original papers.

### books/survey/ch5-randomized-signal/index.md
- The reviewer's '133 occurrences of --' count appears to count YAML frontmatter delimiters (---) and the markdown table separator row in benchmarks.md (|--------|...). These are required Markdown/MDX structural syntax; removing them would break rendering, so they were left in place. If the house tooling flags these as violations, the table should be rebuilt with a non-dash separator style and frontmatter handled by the build, but that is a tooling decision outside a conservative content edit.
- The named target file (index.md) itself contained none of the cited defects; all fixes were applied to the sibling chapter files (fourier-spectral.md, randomized-regularization.md, bloom-filters.md/taxonomy.md already correct) and the shared references.yaml, on the assumption the reviewer assessed the chapter directory as a unit. Confirm this scope matches expectations.

### books/survey/ch5-randomized-signal/random-projections.md
- The new worked-example sentence on line 12 derives ~5500 dimensions from the stated JL bound with an assumed constant near 1; the exact constant depends on the specific JL variant cited (@johnson1984extensions / @matousek2008variants), so a human may wish to confirm the constant and final figure if a tighter number is desired.
- If a real measured datapoint for embedding compression is wanted (rather than the order-of-magnitude statement now in place), a human should supply a primary source that actually reports such an experiment, since none could be verified from the file or its existing citations.

### books/survey/ch5-randomized-signal/randomized-linear-algebra.md
- Changed 'the error is typically within 1%' to 'within a few percent' in the randomized SVD paragraph because the precise 1% figure is an unverifiable empirical claim coupled to the sentence I had to rewrite for the Theorem 10.6 fix. If you can source the original 1% claim, you may restore it.
- The synthesis subsection's qualitative tradeoff statements (e.g. CUR sacrifices some approximation quality vs randomized SVD) are standard and consistent with the cited sources but were not pulled from specific numbered theorems; if you want exact comparative error/benchmark numbers, please supply or verify them from the primary references.

### books/survey/ch5-randomized-signal/randomized-regularization.md
- None. The goyal2017accurate reference entry already existed in references.yaml, so no fabrication was required. The added per-family limitations are well-established, widely-documented properties (e.g., dropout/batchnorm variance shift, large-batch generalization gap) stated qualitatively without inventing numbers, benchmarks, or new citations.

### books/survey/ch5-randomized-signal/signal-processing-transformers.md
- Reviewer counted 9 em-dashes but the file body contained only 7 inline '--' instances; the two extra matches are the required YAML frontmatter delimiters ('---' on lines 1 and 4), which were preserved. No body em-dashes remain.

### books/survey/ch5-randomized-signal/sketching-streaming.md
- I did NOT add a primary citation for DeepSpeed's 1-bit Adam / 0-1 Adam. references.yaml has no entry for it (no tang20211bit or similar key), and the rule forbids fabricating citekeys. I corrected the mechanism (error-feedback quantization, not sketching) and removed the unsupported 5x figure, but the named-system claim remains uncited. Human should add the primary citation (e.g., Tang et al., 2021, '1-bit Adam') to references.yaml and cite it, or remove the named systems.
- I removed the uncited DALL-E training-detail sentence entirely rather than leave an unsupported production claim. If the human wants this content retained, they should add a primary source for the DALL-E communication-compression/gradient-checkpointing claim.
- The remaining quantitative claim in the optimizer-state section (about 25% memory savings) is attributed in-text to Spring and Shrivastava (2019), already cited via @spring2019compressing. Human should confirm this figure against the paper's reported numbers and the exact architecture/regime if a precise value is desired.

### books/survey/ch5-randomized-signal/wavelet-multiresolution.md
- WaveMix synthesis finding: the reviewer asked for a concrete comparative figure (accuracy/parameter count vs a named baseline on a named dataset). I sharpened the qualitative claim and kept it sourced to [@jeevan2022wavemix], but did NOT insert specific accuracy or parameter numbers because I could not verify exact figures from the file or confirm them without fabricating. A human should add the precise dataset/baseline/accuracy/parameter numbers from the WaveMix paper.
- Citation metadata for the four newly added references (guo2017dwsr, huang2017waveletsrnet, phung2023wavediff) was filled from well-established venue/author knowledge but I did not add URLs/arXiv IDs for them (only gal2021swagan has the reviewer-verified arXiv:2102.06108). A human should verify and add canonical URLs/arXiv IDs for the other three to match the file's citation hygiene.
- Limitation/tradeoff sentences I added (fixed-basis vs learned-filter at scale, separable 2D DWT directional limits, boundary artifacts) are textbook-level signal-processing facts, not paper-specific measured claims; if the chapter prefers each limitation tied to a specific citation, a human should attach supporting references.

### books/survey/intro.md
- Scope & Coverage (counts): I dropped the precise per-chapter 'key papers' counts instead of replacing them with verified citation totals or enumerating a curated key-paper subset, because I cannot verify the actual unique-citekey counts per chapter without auditing each chapter file, and fabricating new numbers is disallowed. If you want the counts retained, define/enumerate the curated key-paper subset per chapter or insert the verified citation totals.
- Scope paragraph wording: the added out-of-scope rationale uses the reviewer's suggested example areas; confirm these accurately reflect your intended boundaries and adjust if any of these topics are in fact covered in a chapter.

### posts/blog/how-to-research.md
- The reviewer asked for 'at least one concrete first-person episode where this taste changed a decision and the outcome.' I strengthened the first-person framing and added a concrete behavioral consequence for the baseline heuristic, but I did not invent a specific anecdote (a named project, dataset, or outcome) because doing so would fabricate facts I cannot verify. The author should add a real episode from their own work to fully satisfy the novelty rubric.
- The title-question 'What Is Research Taste?' is left as-is; it now reads as a framing device given the reframed intro, but if the reviewer wants the title itself grounded or answered more directly, the author may want to revisit it.

### posts/blog/recent-progress-on-ir/index.mdx
- The new thesis and tradeoff table synthesize only what is already stated in the per-paper entries; if you want sharper or more contrarian framing (e.g., explicitly arguing the field is NOT making retrieval fundamentally smarter), verify that characterization against the actual papers before publishing.
- SPLARE was grouped under 'cheaper indexing units' alongside DISCo, but its summary also emphasizes multilingual/language-agnostic strengths; consider whether you want it represented under multilingual coverage instead or in addition.

### posts/blog/scalable-synth-datagen.md
- Could not add a formal pandoc [@key] citation for Self-Instruct, Evol-Instruct/WizardLM, Orca, the Phi series, SPIN, Persona Hub, Constitutional AI, RLAIF, or Magpie because references.yaml has no matching entries (the only 'orca' key, yu2022orca, is a different serving-system paper, and li2023teacherlm is mislabeled with the phi-1.5 title). I used verified inline arxiv links instead; if strict [@key] citations are required, please add these entries to references.yaml.
- The Persona Hub 64.9% MATH / gpt-4-turbo-preview comparison is taken from the reviewer's note as the paper's reported figure; I could not independently re-verify the exact number against the paper text in this environment. Please confirm before publishing.
- I did not add a separate dedicated Limitations section (only inline caveats and a reframed conclusion) to keep edits minimal and preserve the post's structure; consider whether a standalone limitations heading is wanted.

### posts/blog/wikipedia-category-graph.md
- The post still cites '~15M entities' from caligraph.org v3.0, whereas the reviewer referenced '~13M entities' and 'almost 1.3M classes' from the SWJ 2025 paper text. I could not extract readable text from the SWJ 2025 PDF (binary/compressed), so I used the verified canonical caligraph.org statistics page instead (1,285,189 classes; 14,727,963 entities). If the published paper's frozen snapshot differs from the live site, a human may want to pin the exact paper-reported figures and version.
- The 'Relations' figure on caligraph.org (37,002,047) is not explicitly labeled as the total triple/assertion count; I phrased it as 'tens of millions of relation assertions (~37M)'. If the intended claim was total RDF triples (which would be larger once labels/types are included), a human should confirm the precise metric and number from the paper or the full RDF dump.
- Numeric-range en-dashes (e.g. '20–30%', '10–50', '2023–25') were left unchanged: they are U+2013 en-dashes used in standard numeric ranges, not the '--' sequences or em-dashes the rule targets. Flagging in case the reviewer's count intended these too.

### posts/research/compress-or-not-zeyu-2025/index.mdx
- [major] Evidence/Grounding: The claim 'The weights of neural networks trained with SGD are known to follow heavy tailed, alpha-stable distributions' still has no inline citation. references.yaml contains no entry for the primary sources (e.g. Simsekli et al., Gurbuzbalaban et al.) and no heavy-tailed/alpha-stable key exists. Per the no-fabrication rule I did not invent a citekey or add an unverified bibliography entry. ACTION NEEDED: add the primary source(s) to references.yaml with correct bibliographic details and insert the resolving [@citekey] after that sentence (line ~33).

### posts/research/swarms.md
- Dash rule: the reviewer counted 10 '--' but all 10 are structural Markdown/MDX (frontmatter '---', the '<!-- truncate -->' comment, and table separators '|---|---|---|'). None are prose em-dashes; removing them would break the document, so they were intentionally left unchanged. There were no em-dash or unicode-dash characters to remove.
- Citations are referenced by name only (Semantic Web/RDF, knowledge-graph construction, self-play retrieval, doc2query, docTTTTTquery, InPars, model-collapse studies) since this Docusaurus post has no bibliography/citekey system in the file and I will not fabricate exact references or links. A human may want to add formal citations/links for these named works.
- The estimate that one document yields 'on the order of hundreds' of examples is framed as a back-of-envelope figure; it is unverified. A human should replace it with a measured number once available.

