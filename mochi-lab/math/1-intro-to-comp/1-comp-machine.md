---
sidebar_position: 1
---

# Computing Machinery and Intelligence

This chapter addresses a foundational question: *what can be computed, and what are the fundamental limits?* These limits are not academic curiosities -- they directly constrain what machine learning can and cannot do.

## Turing Machines

<Definition id="def-turing-machine" name="Turing Machine">
A **Turing machine** is the simplest formal model of general-purpose computation. It consists of:

1. An **infinite tape** divided into cells, each holding a symbol from a finite alphabet $\Sigma$ (including a blank symbol $\sqcup$)
2. A **read/write head** that scans one cell at a time
3. A **finite state register** storing the current state $q \in Q$
4. A **transition function** $\delta: Q \times \Sigma \to Q \times \Sigma \times \{L, R\}$ that, given the current state and symbol under the head, specifies the new state, the symbol to write, and the direction to move
5. Distinguished **accept** and **reject** states $q_{\text{accept}}, q_{\text{reject}} \in Q$

A computation begins with the input written on the tape, the head at the leftmost input symbol, and the machine in a designated start state $q_0$. The machine applies the transition function repeatedly until it reaches an accept or reject state (or runs forever).
</Definition>

<Example id="ex-turing-palindrome">
**Palindrome checker.** A Turing machine can decide whether a binary string is a palindrome by repeatedly: (1) reading and erasing the leftmost symbol, (2) sweeping right to find the rightmost symbol, (3) checking they match, (4) erasing the rightmost symbol, and (5) sweeping back left. This requires $O(n^2)$ steps for a string of length $n$ -- illustrating that even simple problems can be expensive on this model.
</Example>

Despite its simplicity, a Turing machine can compute anything that any physical computer can compute. This is the content of the **Church--Turing thesis** [@turing1936computable]:

<Definition id="def-church-turing" name="Church--Turing Thesis">
Every function that is "effectively computable" by any physical process is computable by a Turing machine. This is a thesis (not a theorem) because "effectively computable" cannot be formally defined independently of the models it is meant to characterize.
</Definition>

<Remark id="rmk-church-turing">
There is no known physical process -- classical, quantum, or otherwise -- that computes something a Turing machine cannot compute (though quantum computers can solve certain problems *faster*). This means the theoretical limits of computability are independent of hardware technology. Every laptop, GPU cluster, and quantum computer computes the same class of functions; they differ only in *efficiency*.
</Remark>

## Computability and Decidability

Not all problems are computable. The most famous example is the **halting problem**.

<Theorem id="thm-halting" name="Undecidability of the Halting Problem">
There is no Turing machine $H$ that, given an arbitrary program $P$ and input $x$, correctly determines whether $P$ halts on $x$ [@turing1936computable].
</Theorem>

**Proof sketch (by diagonalization).** Suppose such a machine $H$ exists:

<Equation id="eq-halting">

$$H(P, x) = \begin{cases} 1 & \text{if } P \text{ halts on } x \\ 0 & \text{if } P \text{ loops forever on } x \end{cases}$$

</Equation>

Construct a new program $D$ that takes a program $P$ as input:
- If $H(P, P) = 1$, then $D$ loops forever
- If $H(P, P) = 0$, then $D$ halts

Now consider $D(D)$: if $D$ halts on $D$, then $H(D,D)=1$, so $D$ loops -- contradiction. If $D$ loops on $D$, then $H(D,D)=0$, so $D$ halts -- contradiction. Therefore $H$ cannot exist. $\square$

<Remark id="rmk-undecidability-ml">
Undecidability has concrete implications for machine learning:

- **Convergence:** We cannot build a general-purpose tool that determines whether a given training procedure will converge.
- **Verification:** We cannot build a general-purpose verifier that proves a neural network satisfies a given specification on all inputs (though restricted verifiers exist for specific architectures and properties [@katz2017reluplex]).
- **Architecture search:** There is no algorithm that, given a dataset, finds the provably optimal architecture in finite time.

These are not engineering limitations to be overcome -- they are mathematical impossibilities.
</Remark>

## Complexity Classes

Even among computable problems, some are fundamentally harder than others. Complexity theory classifies problems by the resources (time and space) required to solve them.

<Definition id="def-big-o" name="Asymptotic Notation">
We say $f(n) = O(g(n))$ if there exist constants $c > 0$ and $n_0$ such that $f(n) \leq c \cdot g(n)$ for all $n \geq n_0$. Similarly, $f(n) = \Omega(g(n))$ is the lower-bound analogue, and $f(n) = \Theta(g(n))$ means both $O(g(n))$ and $\Omega(g(n))$.
</Definition>

<Table id="tab-complexity-classes" caption="Computational complexity classes and their relevance to ML.">

| Class | Definition | ML Example |
|-------|-----------|------------|
| $P$ | Decidable in $O(n^k)$ time for some constant $k$ | Matrix multiplication, sorting, linear regression (via normal equations) |
| $NP$ | A "yes" certificate is verifiable in polynomial time | Boolean satisfiability, graph coloring |
| $NP$-hard | At least as hard as every problem in $NP$ | Training a 2-layer ReLU network to global optimality [@blum1989training] |
| $NP$-complete | In $NP$ and $NP$-hard | Feature selection with cardinality constraints |
| $\#P$ | Counting the number of solutions to an $NP$ problem | Computing the partition function of a Boltzmann machine |
| $PSPACE$ | Decidable with polynomial space (possibly exponential time) | Game playing (Go, chess with generalized board) |
| $BPP$ | Decidable in polynomial time with bounded error probability | Approximate sampling from intractable distributions |

</Table>

<Remark id="rmk-np-hard-training">
Training a neural network to global optimality is $NP$-hard in general [@blum1989training]. The remarkable fact that SGD works well in practice is an empirical observation about the loss landscape geometry of overparameterized networks -- not a theoretical guarantee. Understanding *why* gradient descent finds good solutions despite non-convexity is one of the central open problems in deep learning theory.
</Remark>

<Remark id="rmk-complexity-practical">
Complexity matters in practice. Matrix multiplication is $O(n^3)$ naively, $O(n^{2.37})$ theoretically [@alman2021refined], and effectively $O(n^{2.8})$ using Strassen's algorithm in libraries like cuBLAS. For attention in transformers, the naive $O(n^2 d)$ cost has driven research into sub-quadratic alternatives like FlashAttention [@dao2022flashattention], which reduces *memory* from $O(n^2)$ to $O(n)$ while keeping the same FLOP count.
</Remark>

## Universal Function Approximation

A central theoretical justification for neural networks is their expressiveness: they can approximate any continuous function.

<Theorem id="thm-universal-approx" name="Universal Approximation Theorem (Cybenko, 1989)">
Let $\sigma: \mathbb{R} \to \mathbb{R}$ be any continuous, non-constant, bounded activation function (e.g., sigmoid, tanh). For any continuous function $f: K \to \mathbb{R}$ on a compact set $K \subset \mathbb{R}^n$ and any $\epsilon > 0$, there exists an integer $N$ and parameters $\alpha_i, b_i \in \mathbb{R}$, $w_i \in \mathbb{R}^n$ such that:

<Equation id="eq-universal-approx">

$$\sup_{x \in K} \left| f(x) - \sum_{i=1}^{N} \alpha_i \, \sigma(w_i^\top x + b_i) \right| < \epsilon$$

</Equation>

[@cybenko1989approximation]
</Theorem>

<Remark id="rmk-universal-approx-extensions">
The theorem has been extended in several important directions:

1. **Unbounded activations.** Hornik (1991) showed the result holds for any non-polynomial activation, including ReLU [@hornik1991approximation].
2. **Width vs. depth.** A single hidden layer of width $N$ suffices, but $N$ may need to be exponentially large. Deep networks can approximate the same functions with polynomially many parameters [@telgarsky2016benefits; @eldan2016power].
3. **Approximation rate.** For Lipschitz functions on $[0,1]^n$, a ReLU network with $W$ parameters achieves error $O(W^{-2/n})$ -- exhibiting the **curse of dimensionality** [@yarotsky2017error]. Compositional structure in the target function can break this curse.
4. **Practical caveat.** The theorem is existential: it guarantees *some* network exists, but says nothing about whether gradient descent can *find* it, how much data is needed, or whether the required width is feasible.
</Remark>

<Example id="ex-relu-piecewise">
**ReLU networks as piecewise linear functions.** A single-hidden-layer ReLU network with $N$ neurons computes a piecewise linear function with at most $N+1$ linear pieces in one dimension. Each additional hidden layer can exponentially increase the number of linear regions: a depth-$L$, width-$N$ ReLU network can produce $O(N^L)$ linear regions [@montufar2014number]. This is a concrete illustration of the "depth efficiency" phenomenon.
</Example>

## Computational Complexity of Common ML Operations

<Table id="tab-ml-complexity" caption="Time and space complexity of common ML operations for inputs of size $n$, model dimension $d$, sequence length $T$, and vocabulary size $V$.">

| Operation | Time | Space | Notes |
|-----------|------|-------|-------|
| Matrix multiply ($n \times d$) $\times$ ($d \times m$) | $O(ndm)$ | $O(nm)$ | Dominated by memory bandwidth on GPUs |
| Self-attention (sequence length $T$, head dim $d$) | $O(T^2 d)$ | $O(T^2)$ | FlashAttention reduces space to $O(T)$ |
| Softmax (length $V$) | $O(V)$ | $O(V)$ | Numerically: subtract max first |
| Backprop through $L$ layers | $O(L \cdot C_{\text{fwd}})$ | $O(L \cdot A)$ | $A$ = activation memory per layer |
| SVD of $m \times n$ matrix | $O(mn \min(m,n))$ | $O(mn)$ | |
| Gradient descent step | $O(P)$ | $O(P)$ | $P$ = number of parameters |

</Table>

## The Relationship Between Theory and Practice

<Remark id="rmk-theory-practice">
A recurring theme in ML is the gap between worst-case theory and average-case practice:

- **Optimization:** Training is $NP$-hard in the worst case, yet SGD finds good solutions reliably on real data.
- **Generalization:** Classical learning theory (VC dimension, Rademacher complexity) predicts overparameterized models should overfit catastrophically, yet they generalize well -- the "double descent" phenomenon [@belkin2019reconciling].
- **Approximation:** The universal approximation theorem requires exponential width in general, yet practical networks with modest width solve hard problems.

Understanding these gaps is an active area of research. The takeaway for practitioners: theoretical limits inform algorithm design but should not be mistaken for practical limits.
</Remark>

## Notation Summary

<Table id="tab-notation-comp" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\Sigma$ | Finite alphabet of tape symbols |
| $Q$ | Finite set of machine states |
| $\delta$ | Transition function |
| $q_0, q_{\text{accept}}, q_{\text{reject}}$ | Start, accept, and reject states |
| $O(\cdot), \Omega(\cdot), \Theta(\cdot)$ | Asymptotic upper, lower, and tight bounds |
| $P, NP, NP\text{-hard}$ | Complexity classes |
| $\sigma$ | Activation function |
| $K$ | Compact subset of $\mathbb{R}^n$ |
| $\epsilon$ | Approximation tolerance |
| $N$ | Number of hidden neurons |
| $L$ | Number of layers (depth) |

</Table>
