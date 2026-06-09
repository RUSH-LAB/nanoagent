---
sidebar_position: 6
title: "Formal Proofs"
---

# Formal Proofs

This site supports placing machine-checked [Lean 4](https://lean-lang.org/) proofs alongside informal mathematical proofs. The `<LeanProof>` component renders a collapsible code block directly below a `<Proof>` block, letting readers compare the human-readable argument with its formal counterpart.

:::note Every Lean proof on this page compiles
The proofs shown here are not decorative. Each one lives as a real `.lean` file in the `lean-proofs/` Lake project at the repository root and is verified with `lake build`. See [Verifying Proofs](#verifying-proofs) below for the workflow.
:::

:::tip Run proofs in your browser
Every `<LeanProof>` block has a **▶ Run in browser** button. It loads the proof into the [Lean 4 Web](https://live.lean-lang.org/) editor embedded right on this page, where you can compile and edit it live. No local install needed. (The code is sent to the public Lean playground for compilation.)
:::

---

## Why Pair Informal and Formal Proofs

Informal proofs communicate *intuition*: they explain why a result is true in a way that builds understanding. Formal proofs communicate *certainty*: they encode every logical step so a proof assistant can verify correctness mechanically. Presenting both side by side gives readers the best of both worlds.

---

## The `<LeanProof>` Component

`<LeanProof>` wraps a Lean 4 code block in a collapsible panel. It is collapsed by default so formal proofs do not interrupt the reading flow.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `title` | string | `"Formal Proof (Lean 4)"` | Custom header text |
| `runnable` | boolean | `true` | Show the **▶ Run in browser** button |
| `project` | string | — | Lean Web project to compile against (e.g. `"mathlib"`); omit for the default core toolchain |

### Basic Usage

Place a `<LeanProof>` immediately after a `<Proof>` block:

```mdx
<Theorem id="thm-example" name="Example">
Statement of the theorem.
</Theorem>

<Proof>
Informal argument here.
</Proof>

<LeanProof>

` ` `lean4
theorem example : ... := by
  ...
` ` `

</LeanProof>
```

*(Remove the spaces inside the triple backticks above.)*

---

## Live Example

<Theorem id="thm-add-comm-demo" name="Commutativity of Addition">
For all natural numbers $n$ and $m$, we have $n + m = m + n$.
</Theorem>

<Proof>
By induction on $n$.

**Base case** ($n = 0$). We need $0 + m = m + 0$. Both sides equal $m$ by the definition of addition and the identity $m + 0 = m$.

**Inductive step.** Assume $n + m = m + n$. Then

$$
(n + 1) + m = (n + m) + 1 = (m + n) + 1 = m + (n + 1)
$$

where the second equality uses the inductive hypothesis and the third uses the successor property of addition.
</Proof>

<LeanProof>

```lean4
theorem add_comm_demo (n m : Nat) : n + m = m + n := by
  induction n with
  | zero => simp
  | succ n ih => simp only [Nat.succ_add, Nat.add_succ, ih]
```

</LeanProof>

---

## More Examples

### Transitivity of Less-Than-or-Equal

<Theorem id="thm-le-trans-demo" name="Transitivity of ≤">
For all natural numbers $a$, $b$, and $c$, if $a \le b$ and $b \le c$, then $a \le c$.
</Theorem>

<Proof>
If $a \le b$, there exists $k_1 \ge 0$ with $b = a + k_1$. If $b \le c$, there exists $k_2 \ge 0$ with $c = b + k_2$. Substituting, $c = a + (k_1 + k_2)$, so $a \le c$.
</Proof>

<LeanProof>

```lean4
theorem le_trans_demo (a b c : Nat) (h1 : a ≤ b) (h2 : b ≤ c) : a ≤ c :=
  Nat.le_trans h1 h2
```

</LeanProof>

### Associativity of List Append

<Theorem id="thm-append-assoc-demo" name="Associativity of List Append">
For all lists $xs$, $ys$, and $zs$, we have $(xs \mathop{++} ys) \mathop{++} zs = xs \mathop{++} (ys \mathop{++} zs)$.
</Theorem>

<Proof>
By induction on $xs$.

**Base case** ($xs = []$). Both sides equal $ys \mathop{++} zs$.

**Inductive step** ($xs = x :: xs'$). By the inductive hypothesis, $(xs' \mathop{++} ys) \mathop{++} zs = xs' \mathop{++} (ys \mathop{++} zs)$. Prepending $x$ to both sides gives the result, since $x :: (xs' \mathop{++} ys) \mathop{++} zs = x :: xs' \mathop{++} (ys \mathop{++} zs)$.
</Proof>

<LeanProof>

```lean4
theorem append_assoc_demo {α : Type} (xs ys zs : List α) :
    (xs ++ ys) ++ zs = xs ++ (ys ++ zs) := by
  induction xs with
  | nil => simp
  | cons x xs ih => simp [ih]
```

</LeanProof>

---

## Custom Title

Use the `title` prop to override the default header:

<LeanProof title="Lean 4 Formalization">

```lean4
example : 1 + 1 = 2 := rfl
```

</LeanProof>

---

## Standalone Code Blocks

Any ` ```lean4 ` code block placed **outside** a `<LeanProof>` wrapper automatically receives a **▶ Run** button in its top-right corner (visible on hover). Clicking it opens the same Lean 4 Web playground inline, without needing any wrapper component.

This is useful for standalone examples, exercises, or quick demonstrations where the collapsible formal-proof style is unnecessary.

```lean4
#check Nat.add_comm
#eval 2 + 3
```

To suppress the button on a specific block, add `noRun` to the code fence:

````mdx
```lean4 noRun
-- this block will not have a Run button
```
````

---

## Lean 4 Syntax Highlighting

Code blocks tagged with ` ```lean4 ` or ` ```lean ` receive Lean-specific syntax highlighting. The grammar covers keywords, tactics, built-in types, comments, and operators.

<Table id="tab-lean-highlight" caption="Lean 4 syntax highlighting categories.">

| Category | Examples |
|----------|---------|
| Keywords | `theorem`, `def`, `structure`, `class`, `where`, `by`, `match`, `if` |
| Tactics | `simp`, `ring`, `omega`, `exact`, `apply`, `intro`, `induction`, `rw` |
| Built-in types | `Nat`, `Int`, `Bool`, `List`, `Prop`, `Type`, `Option` |
| Comments | `-- line comment`, `/- block comment -/` |

</Table>

---

## Verifying Proofs

The Lean proofs are checked by a self-contained [Lake](https://github.com/leanprover/lean4/tree/master/src/lake) project at `lean-proofs/` in the repository root. It uses Lean core only, so no Mathlib download is required.

```
lean-proofs/
  lean-toolchain      # pins the Lean version (leanprover/lean4:v4.30.0)
  lakefile.toml       # Lake build configuration
  Proofs.lean         # the proofs shown on this page
```

Install the toolchain once with [elan](https://github.com/leanprover/elan), then build:

```bash
# install elan (Lean version manager); installs to ~/.elan
curl -sSfL https://elan.lean-lang.org/elan-init.sh | sh -s -- -y

# compile and type-check every proof
cd lean-proofs
lake build
```

A clean `lake build` (exit code `0`) means every theorem on this page is machine-checked. A code block here should only be published after its `.lean` counterpart compiles.

:::tip Compile before publishing
Writing Lean that *looks* correct is easy; writing Lean that *compiles* is the point. Always run `lake build` before pasting a proof into the docs. For example, an early draft of `append_assoc_demo` omitted the `{α : Type}` binder, and `add_comm_demo` originally used a `simp` set that looped — both were caught only by compiling.
:::

---

## Guidelines for Writing Formal Proofs

1. **Keep the informal proof primary.** The `<Proof>` block should stand on its own. Readers who skip the formal version should still follow the argument.
2. **Collapse by default.** `<LeanProof>` is collapsed so it does not break reading flow. Readers opt in by clicking.
3. **Annotate tactic steps.** Use Lean 4 comments (`--`) to label key steps so readers can map them to the informal proof.
4. **Prefer readable tactics.** Favor `simp`, `omega`, and named lemmas over opaque proof terms when the formal proof serves a pedagogical role.
