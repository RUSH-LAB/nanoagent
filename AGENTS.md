## Principles

**Zero tolerance for fallbacks.** Never substitute alternate behavior. If the intended path cannot succeed, fail clearly.

**Review every change.** Before finishing a task, review every file you touched and reduce the work to the smallest complete change. Remove unused code, speculative abstractions, and debugging leftovers.

**Nothing is impossible.** If you say something is not possible, I will challenge that. That means you rely on the current tech stack and do not think about new tech stack. We need to achieve the goal, no matter how big changes we need to make.

**No LLM as judge.** A plugin's verifier is deterministic code and decides every case. Never use a model to verify a result, and never design a task whose correctness code cannot check.

**The desktop app is the product.** Members use RUSH Lab, the desktop app, which bundles NanoAgent, the relay (`helpinghands/src/runner/`) and the plugin page kit. A change to any of them is not done until the desktop app is rebuilt with it and checked in that build. To check devmode, run Mochi with `npm start`, then `npm run desktop:dev` (both in `helpinghands/`): it builds RUSH Lab Dev, an app of its own built the same way, installs it in /Applications beside RUSH Lab and opens it, its window titled `RUSH Lab Dev`. RUSH Lab Dev is always on that local site, and RUSH Lab always on rush-lab.org, which runs production.

## Configuration

- All config comes from YAML files and never uses `argparse`.
- Reuse an existing config when its structure fits. Don't copy it.

## Examples

Each example lives in its own directory under `examples/` and is split into numbered steps. Every file for step N starts with `stepN`. For an example in `examples/chat_with_agent/`, the files for step 1 are:

| What | Location | Example |
|---|---|---|
| Script | `stepN_<name>.py` | `examples/chat_with_agent/step1_llm_inference_with_tools.py` |
| Config | `configs/stepN_<name>.yaml` | `examples/chat_with_agent/configs/step1_llm_inference_with_tools.yaml` |
| Run script | `runs/stepN_<name>.sh` | `examples/chat_with_agent/runs/step1_llm_inference_with_tools.sh` |
| Outputs (git-ignored) | `outputs/stepN_<name>/` | `examples/chat_with_agent/outputs/step1_llm_inference_with_tools/` |

## Papers

Our papers live under `docs/paper/<name>/` (e.g. `docs/paper/cyberbench/`). `paper.tex` holds the preamble and inputs each section from `sections/N_<name>.tex`. Citations go in `references.bib`.

To add a related arXiv paper:

1. Download its LaTeX source into `docs/raw/<short_name>_<arxiv_id>/`. The short name is the lowercase benchmark or method name (e.g. `docs/raw/exploitgym_2605.11086/`):
   ```bash
   mkdir -p docs/raw/<short_name>_<arxiv_id>
   curl -sSL -A "Mozilla/5.0" https://arxiv.org/e-print/<arxiv_id> | tar -xz -C docs/raw/<short_name>_<arxiv_id>
   ```
2. Read the source (abstract, method, results, limitations) and summarize it in your own words in the relevant section of our paper. Don't copy text from it.
3. Add a BibTeX entry to `references.bib` using the authors and title from the source.
4. Build from the paper folder with `latexmk -pdf paper.tex`, confirm there are no errors or undefined citations, then run `latexmk -c`.

## Run

Always run commands from the project root. Third-party packages come from `uv`, never from Brazil. Declare them under `dependencies` in `pyproject.toml` (a git source goes in `[tool.uv.sources]`), then sync `.venv`:

```bash
bash install.sh
```

Run an example through its run script:

```bash
bash examples/chat_with_agent/runs/step1_llm_inference_with_tools.sh
```

Every run script moves to the NanoAgent project root (`nanoagent/` in the repo), then runs the step's Python script with `.venv/bin/python`, its config (`config=`), and its output folder (`home=`). Overrides go after `--`; a run script that sweeps a field (e.g. one run per harness) loops over it and gives each run its own folder. The log is always `run.log` in that folder:

```bash
cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/python \
    examples/chat_with_agent/step1_llm_inference_with_tools.py \
    config=examples/chat_with_agent/configs/step1_llm_inference_with_tools.yaml \
    home=examples/chat_with_agent/outputs/step1_llm_inference_with_tools/safeguard \
    -- harness.kind=safeguard
```

A step's run folder is typed: its `Run` declares `layout: <class>` (a slimconfig `Layout`), whose fields are outputs (slimconfig `Output` classes, written as `<field>.json`) and folders (`Folder`, created before `main`). `main` sets the outputs; slimconfig writes them, records the layout in `metadata.json`, and fails the run on anything in the folder the layout does not declare. Read a run back with `slimconfig.load_layout(folder, <class>)`. A chat's layout is `safeguard.harness.chat.ChatLayout`: `messages.json` (the conversation as an ATIF `Trajectory`, Harbor's Agent Trajectory Interchange Format, the same shape for every model and harness) and `workspace/` (what the agent made); a harness's own logs go to a temporary folder outside the run.
