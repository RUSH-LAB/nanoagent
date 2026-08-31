# Lean Proofs

This plugin owns the complete informal-to-formal proof workflow:

- `/lean-proofs` is a browser workbench for a theorem statement, an informal
  argument, generated Lean source, and compiler diagnostics.
- `POST /api/lean-proofs/formalize` asks the configured AI provider for a Lean
  4 + Mathlib candidate. Generated source is never presented as verified.
- `POST /api/lean-proofs/check` sends source over stdin to the pinned Lake
  project and reports Lean's real exit status and diagnostics.
- `<LeanProof name="..." />` renders declarations from the checked-in project.
- Runnable `lean` and `lean4` fences are contributed by `remark.js` and
  `<LeanCode>`, without a theme override under `src/`.

The local project is in `proofs/`. Put one named declaration in each file under
`proofs/Proofs/`, import it from `proofs/Proofs.lean`, then run:

```bash
npm run proofs:check
```

The server process capability can execute only the `lake` command declared in
`plugin.json`, only with a working directory inside this plugin. Proof text is
sent to Lean through stdin, not interpolated into a shell command. Local checks
are loopback-only in development and disabled in production unless the operator
explicitly sets `LEAN_PROOFS_ALLOW_EXEC=true`; the source filter also rejects
Lean commands that can execute arbitrary metaprogramming code.
