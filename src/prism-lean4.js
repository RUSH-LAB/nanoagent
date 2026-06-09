import {Prism} from 'prism-react-renderer';

Prism.languages.lean4 = {
  comment: [
    {pattern: /\/-[\s\S]*?-\//, greedy: true},
    {pattern: /--.*/, greedy: true},
  ],
  string: {pattern: /"(?:[^"\\]|\\.)*"/, greedy: true},
  keyword:
    /\b(?:abbrev|attribute|axiom|by|calc|class|def|deriving|do|else|end|example|extends|forall|fun|have|if|import|in|inductive|instance|let|macro|match|namespace|noncomputable|open|partial|private|protected|return|section|set_option|show|structure|suffices|syntax|then|theorem|lemma|unsafe|variable|where|with)\b/,
  tactic:
    /\b(?:simp|ring|omega|linarith|norm_num|exact|apply|intro|intros|cases|induction|constructor|rw|rewrite|contradiction|trivial|decide|assumption|rfl|sorry|congr|ext|funext|rcases|obtain|use|push_neg|specialize|have|suffices|show|calc|conv|norm_cast|positivity|aesop|tauto|field_simp|ring_nf|simp_all|split|left|right|exfalso|absurd)\b/,
  builtin:
    /\b(?:Nat|Int|Bool|String|List|Array|Option|Type|Prop|Sort|Unit|Fin|Float|Char|IO|Monad|true|false|Pure|Id)\b/,
  number: /\b\d+\b/,
  operator:
    /[+\-*/=<>≤≥≠∧∨¬→←↔⊢⊨∘×⊕⊗]+|:=|::|\.\.|[|]>/,
  punctuation: /[{}()[\]:,;.@#]/,
};

Prism.languages.lean = Prism.languages.lean4;
