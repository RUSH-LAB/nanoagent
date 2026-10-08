import Mathlib

-- Transitivity of ≤ on the natural numbers.
theorem le_trans_demo (a b c : Nat) (h1 : a ≤ b) (h2 : b ≤ c) : a ≤ c := by
  exact Nat.le_trans h1 h2
