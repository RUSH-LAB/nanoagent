---
sidebar_position: 5
title: "Cross Reference"
---

# Cross Reference

Reference any numbered component from any page using `<Ref id="..." />`. All math components (`Theorem`, `Definition`, `Figure`, `Table`, `Code`, `Ref`, etc.) are available globally — no import needed.

---

## Same-Page References

Use `[](#id)` to link to a component on the same page. The link text auto-fills with the correct label and number.

**Syntax:**
```markdown
See [](#def-convex) and [](#eq-cross-entropy).
```

---

## Cross-Page References

Use `<Ref id="..." />` to link to components on other pages. It resolves the correct page URL and label automatically.

### [Math](./2-math.md)

<Table id="tab-ref-math" caption="Cross-page references to Math components.">

| Syntax | Result | Type | Source Page |
|--------|--------|------|-------------|
| `<Ref id="def-convex" />` | <Ref id="def-convex" /> | Definition | Math |
| `<Ref id="thm-jensen" />` | <Ref id="thm-jensen" /> | Theorem | Math |
| `<Ref id="eq-cross-entropy" />` | <Ref id="eq-cross-entropy" /> | Equation | Math |
| `<Ref id="eq-softmax" />` | <Ref id="eq-softmax" /> | Equation | Math |

</Table>

### [Figure and Table](./1-figure-and-table.md)

<Table id="tab-ref-fig" caption="Cross-page references to Figure and Table components.">

| Syntax | Result | Type | Source Page |
|--------|--------|------|-------------|
| `<Ref id="fig-agent-loop" />` | <Ref id="fig-agent-loop" /> | Figure | Figure and Table |
| `<Ref id="fig-retrieval" />` | <Ref id="fig-retrieval" /> | Figure | Figure and Table |
| `<Ref id="tab-agent-types" />` | <Ref id="tab-agent-types" /> | Table | Figure and Table |
| `<Ref id="tab-benchmarks" />` | <Ref id="tab-benchmarks" /> | Table | Figure and Table |

</Table>

### [Code](./3-code.md)

<Table id="tab-ref-code" caption="Cross-page references to Code and Algorithm components.">

| Syntax | Result | Type | Source Page |
|--------|--------|------|-------------|
| `<Ref id="code-transformer" />` | <Ref id="code-transformer" /> | Code | Code |
| `<Ref id="code-train-step" />` | <Ref id="code-train-step" /> | Code | Code |
| `<Ref id="alg-sgd" />` | <Ref id="alg-sgd" /> | Algorithm | Code |

</Table>

Each link points to the correct page and scrolls to the target element.
