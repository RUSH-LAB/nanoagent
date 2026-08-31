import Mathlib

-- Associativity of list append.
theorem append_assoc_demo {α : Type} (xs ys zs : List α) :
    (xs ++ ys) ++ zs = xs ++ (ys ++ zs) := by
  exact List.append_assoc xs ys zs
