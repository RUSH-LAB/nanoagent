import './styles.css';
export * from './components/Math';
import * as mathComponents from './components/Math';

export const components = {
  Theorem: mathComponents.Theorem,
  Lemma: mathComponents.Lemma,
  Proposition: mathComponents.Proposition,
  Corollary: mathComponents.Corollary,
  Definition: mathComponents.Definition,
  Remark: mathComponents.Remark,
  Example: mathComponents.Example,
  Proof: mathComponents.Proof,
  Equation: mathComponents.Equation,
  Figure: mathComponents.Figure,
  Table: mathComponents.Table,
  Code: mathComponents.Code,
  Algorithm: mathComponents.Algorithm,
  Section: mathComponents.Section,
  Ref: mathComponents.Ref,
  PageRef: mathComponents.PageRef,
};
