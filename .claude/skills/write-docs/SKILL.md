---
name: write-docs
description: 'Write or restructure technical documentation (README, guides, API reference, design docs) using the Diataxis framework, which separates docs into tutorials, how-to guides, reference, and explanation. Use when the user wants to write docs, a README, a guide, API reference, or to fix docs that mix concerns. Trigger on: "write docs", "document this", "write a README", "write a guide", "API reference".'
---

# Write Docs

Write technical documentation that serves the reader's actual need. The core method is Diataxis: most weak docs fail because they blend four different jobs into one confusing page. Separate them first, then write each well.

For the line-editing pass once a draft exists, hand off to [[polish-prose]]. The house style rules in [[write-blog]] apply here too: thesis first, no filler, never use `--` or em-dashes.

## The four documentation types

Decide which type you are writing before you write. Each serves a different reader in a different mindset. Never mix two in one document.

| Type | Reader's need | Mindset | Answers |
|---|---|---|---|
| **Tutorial** | Learn by doing | "Teach me" | A guided lesson that builds confidence through a working result |
| **How-to guide** | Accomplish a task | "Show me how" | Numbered steps to solve one real problem |
| **Reference** | Look up a fact | "Tell me the detail" | Precise, exhaustive description of the API, flags, config |
| **Explanation** | Understand why | "Help me understand" | Background, design rationale, trade-offs, context |

Quick test for which you need:
- Practical and study-oriented: **tutorial**.
- Practical and work-oriented: **how-to guide**.
- Theoretical and work-oriented: **reference**.
- Theoretical and study-oriented: **explanation**.

## Rules per type

**Tutorial**
- Guarantee success. Every step must work if followed exactly. Test the whole path yourself.
- One concrete path. Do not branch into options or alternatives.
- Show the expected output after each step so the reader can confirm progress.
- Defer the why. Link to an explanation instead of pausing to theorize.

**How-to guide**
- Title it as a task: "How to deploy to production", "How to rotate the API key".
- Assume basic competence. Skip setup the reader already has.
- Numbered, ordered, action-first steps. State the goal in the first line.
- Address one real-world problem, not a feature tour.

**Reference**
- Mirror the structure of the code. Stay consistent and predictable.
- Be exhaustive and accurate. List every parameter, type, default, return value, and error.
- Describe, do not instruct. State what things are, not how to use them in a workflow.
- Use tables and consistent templates for repeated structures (endpoints, flags, fields).

**Explanation**
- Give the why: design decisions, trade-offs, history, alternatives considered and rejected.
- Make connections to broader concepts and adjacent systems.
- It is fine to express an opinion and admit a limitation here.
- Do not document steps or list every parameter. Link to the how-to and reference instead.

## READMEs

A README is a router, not a manual. Order it so the reader self-selects:

1. **One-line description** of what the project is and the problem it solves.
2. **Quick start**: the shortest path from zero to a running result (a small tutorial).
3. **Usage**: the common tasks (how-to guides, or links to them).
4. **Reference or links** to the full API and config.
5. **Why and context** (explanation, or a link to it).

Lead with what most readers need most often. Push edge cases and deep background down or out to linked pages.

## Workflow

1. **Identify the type.** Ask who reads this and what they are trying to do. Pick one of the four. If the request spans several, plan one document per type and link them.
2. **Find the existing pattern.** Look at how docs are already structured in this repo or project and match it before inventing a new shape.
3. **Outline by type rules.** Use the rules above for the chosen type.
4. **Draft from real behavior.** Read the actual code, run the actual commands, and document what truly happens. Never document remembered or assumed behavior.
5. **Verify every command and code sample.** Each one must run as written. A broken snippet destroys trust in the whole document.
6. **Hand off to [[polish-prose]]** for the editing pass.

## Gotchas

- **Mixing types is the most common failure.** A tutorial that stops to explain architecture, or reference that tries to teach, serves neither reader. If a doc feels muddled, it is usually two types fighting. Split it.
- **Untested commands erode trust fast.** Run every command and snippet before shipping. Watch for steps that silently assume prior setup.
- **Reference drifts from code.** When documenting an API, read the current source, not an older doc or your memory of it.
- **Do not bury the quick start.** Readers scan. Put the fastest path to value near the top.
- **Avoid `--` and em-dashes** throughout, consistent with the repo house style.
