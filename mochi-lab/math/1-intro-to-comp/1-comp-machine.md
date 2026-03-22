---
sidebar_position: 1
---

# Computing Machinery and Intelligence

## Turing Machines

A **Turing machine** is the simplest formal model of computation. It consists of:

- An infinite tape divided into cells, each holding a symbol from a finite alphabet $\Sigma$
- A head that reads/writes one cell at a time and moves left or right
- A finite set of states $Q$ with a transition function $\delta: Q \times \Sigma \to Q \times \Sigma \times \{L, R\}$

Despite its simplicity, a Turing machine can compute anything that any physical computer can compute. This is the content of the **Church-Turing thesis**: every effectively computable function is Turing-computable.

**Key insight:** There is no known physical process that computes something a Turing machine cannot. This means the theoretical limits of computation are independent of hardware.

## Computability and Decidability

Not all problems are computable. The **halting problem** -- given a program $P$ and input $x$, does $P$ halt on $x$? -- is undecidable. Turing proved this by diagonalization:

$$
\text{Assume } H(P, x) = \begin{cases} 1 & \text{if } P \text{ halts on } x \\ 0 & \text{otherwise} \end{cases}
$$

Construct $D(P) = \text{loop if } H(P, P) = 1$, else halt. Then $D(D)$ yields a contradiction.

**Key insight:** Some questions about programs are provably unanswerable by any algorithm. In ML, this means we cannot always guarantee that training will converge or that a model will behave correctly on all inputs.

## Complexity Classes

Problems are classified by the resources needed to solve them:

| Class | Description | Example |
|-------|-------------|---------|
| $P$ | Solvable in polynomial time | Sorting, matrix multiplication |
| $NP$ | Verifiable in polynomial time | SAT, graph coloring |
| $NP$-hard | At least as hard as any $NP$ problem | Training optimal neural networks |
| $PSPACE$ | Solvable with polynomial space | Game playing (Go, Chess) |

**Key insight:** Training a neural network to global optimality is $NP$-hard in general. The fact that SGD works well in practice is a deep empirical observation, not a theoretical guarantee.

## Universal Function Approximation

The **universal approximation theorem** (Cybenko 1989, Hornik 1991) states that a feedforward network with a single hidden layer of sufficient width can approximate any continuous function $f: \mathbb{R}^n \to \mathbb{R}$ on a compact set to arbitrary precision:

$$
\forall \epsilon > 0, \; \exists \, N, \, W, \, b: \quad \sup_{x \in K} \left| f(x) - \sum_{i=1}^{N} \alpha_i \, \sigma(w_i^\top x + b_i) \right| < \epsilon
$$

where $\sigma$ is any non-constant, bounded, continuous activation function.

**Key insight:** Neural networks are universal function approximators -- the computational analogue of Turing completeness for function spaces. The challenge is not expressiveness but finding the right parameters efficiently.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\Sigma$ | Finite alphabet of tape symbols |
| $Q$ | Finite set of machine states |
| $\delta$ | Transition function |
| $P, NP$ | Complexity classes |
| $\sigma$ | Activation function |
| $K$ | Compact subset of $\mathbb{R}^n$ |
| $\epsilon$ | Approximation tolerance |
