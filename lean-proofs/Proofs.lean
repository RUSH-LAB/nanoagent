/-
Machine-checked proofs that back the informal proofs on the
"Builder → Components of Textbooks → Formal Proofs" page.

Core-only (no Mathlib). Compile with `lake build`.
-/

-- Commutativity of addition on the natural numbers.
theorem add_comm_demo (n m : Nat) : n + m = m + n := by
  induction n with
  | zero => simp
  | succ n ih => simp only [Nat.succ_add, Nat.add_succ, ih]

-- Transitivity of ≤ on the natural numbers.
theorem le_trans_demo (a b c : Nat) (h1 : a ≤ b) (h2 : b ≤ c) : a ≤ c :=
  Nat.le_trans h1 h2

-- Associativity of list append.
theorem append_assoc_demo {α : Type} (xs ys zs : List α) :
    (xs ++ ys) ++ zs = xs ++ (ys ++ zs) := by
  induction xs with
  | nil => simp
  | cons x xs ih => simp [ih]

-- A trivial definitional equality.
example : 1 + 1 = 2 := rfl
