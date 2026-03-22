---
sidebar_position: 1
---

# Computing Machinery and Intelligence

## Turing Machines

<Definition id="def-turing-machine" name="Turing Machine">
A **Turing machine** is the simplest formal model of computation. It consists of:

- An infinite tape divided into cells, each holding a symbol from a finite alphabet $\Sigma$
- A head that reads/writes one cell at a time and moves left or right
- A finite set of states $Q$ with a transition function $\delta: Q \times \Sigma \to Q \times \Sigma \times \{L, R\}$
</Definition>

Despite its simplicity, a Turing machine can compute anything that any physical computer can compute. This is the content of the **Church-Turing thesis** [@turing1936computable]: every effectively computable function is Turing-computable.

<Remark id="rmk-church-turing">
There is no known physical process that computes something a Turing machine cannot. This means the theoretical limits of computation are independent of hardware.
</Remark>

## Computability and Decidability

Not all problems are computable. The **halting problem** -- given a program $P$ and input $x$, does $P$ halt on $x$? -- is undecidable. Turing proved this by diagonalization [@turing1936computable]:

<Equation id="eq-halting">

$$\text{Assume } H(P, x) = \begin{cases} 1 & \text{if } P \text{ halts on } x \\ 0 & \text{otherwise} \end{cases}$$

</Equation>

Construct $D(P) = \text{loop if } H(P, P) = 1$, else halt. Then $D(D)$ yields a contradiction.

<Remark id="rmk-undecidability-ml">
Some questions about programs are provably unanswerable by any algorithm. In ML, this means we cannot always guarantee that training will converge or that a model will behave correctly on all inputs.
</Remark>

## Complexity Classes

Problems are classified by the resources needed to solve them:

<Table id="tab-complexity-classes" caption="Computational complexity classes and their relevance to ML.">

| Class | Description | Example |
|-------|-------------|---------|
| $P$ | Solvable in polynomial time | Sorting, matrix multiplication |
| $NP$ | Verifiable in polynomial time | SAT, graph coloring |
| $NP$-hard | At least as hard as any $NP$ problem | Training optimal neural networks |
| $PSPACE$ | Solvable with polynomial space | Game playing (Go, Chess) |

</Table>

<Remark id="rmk-np-hard-training">
Training a neural network to global optimality is $NP$-hard in general. The fact that SGD works well in practice is a deep empirical observation, not a theoretical guarantee.
</Remark>

## Universal Function Approximation

<Theorem id="thm-universal-approx" name="Universal Approximation Theorem">
A feedforward network with a single hidden layer of sufficient width can approximate any continuous function $f: \mathbb{R}^n \to \mathbb{R}$ on a compact set to arbitrary precision [@cybenko1989approximation; @hornik1991approximation]:

<Equation id="eq-universal-approx">

$$\forall \epsilon > 0, \; \exists \, N, \, W, \, b: \quad \sup_{x \in K} \left| f(x) - \sum_{i=1}^{N} \alpha_i \, \sigma(w_i^\top x + b_i) \right| < \epsilon$$

</Equation>

where $\sigma$ is any non-constant, bounded, continuous activation function.
</Theorem>

<Remark id="rmk-universal-approx">
Neural networks are universal function approximators -- the computational analogue of Turing completeness for function spaces. The challenge is not expressiveness but finding the right parameters efficiently.
</Remark>

## Notation Summary

<Table id="tab-notation-comp" caption="Notation used in computing machinery and intelligence.">

| Symbol | Meaning |
|--------|---------|
| $\Sigma$ | Finite alphabet of tape symbols |
| $Q$ | Finite set of machine states |
| $\delta$ | Transition function |
| $P, NP$ | Complexity classes |
| $\sigma$ | Activation function |
| $K$ | Compact subset of $\mathbb{R}^n$ |
| $\epsilon$ | Approximation tolerance |

</Table>
