import Mathlib

-- Commutativity of addition on the natural numbers.
theorem add_comm_demo (n m : Nat) : n + m = m + n := by
  exact Nat.add_comm n m
