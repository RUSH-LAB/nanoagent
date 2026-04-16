---
sidebar_position: 3
---

# Git for ML

Version control for ML projects is harder than for typical software because ML projects produce large binary artifacts (model checkpoints, datasets, embeddings) that do not belong in Git, and because experiments branch in ways that do not follow the usual feature-branch workflow. This chapter covers experiment branching strategies, large file management with Git LFS and DVC, proper `.gitignore` configuration, and Git workflows adapted for ML research.

## Branching for Experiments

The key insight for ML experiment management: each experiment should be a branch, and the commit message should include the result. This turns `git log` into an experiment logbook:

<Code id="code-git-for-ml-1" caption="Using Git branches as an experiment tracking system.">

```bash
# ── One branch per experiment ──
git checkout -b exp/lr-sweep
# Make changes to config, train, evaluate
git add config.yaml results/
git commit -m "exp: lr sweep [1e-5, 3e-4, 1e-3], best=3e-4, val_loss=0.42"

# ── Compare experiments ──
git diff exp/baseline..exp/lr-sweep -- config.yaml    # What changed?
git log --oneline --graph exp/baseline exp/lr-sweep    # Visual comparison

# ── View all experiments ──
git branch --list "exp/*"          # List experiment branches
git log --oneline --all --grep="exp:"  # All experiment commits

# ── Tag successful experiments ──
git tag -a v1.0-best -m "Best model: val_loss=0.42, lr=3e-4"
```

</Code>

<Table id="tab-branch-naming" caption="Branch naming conventions for ML projects.">

| Pattern | Purpose | Example |
|---------|---------|---------|
| `exp/<description>` | Experiment branch | `exp/lr-sweep`, `exp/larger-model` |
| `feat/<description>` | New feature | `feat/flash-attention`, `feat/data-pipeline` |
| `fix/<description>` | Bug fix | `fix/nan-loss`, `fix/dataloader-oom` |
| `refactor/<description>` | Code cleanup | `refactor/training-loop` |
| `data/<description>` | Data processing changes | `data/add-validation-split` |

</Table>

<Remark id="rmk-git-commit-messages">
**Commit message format for experiments.** Include quantitative results in commit messages so `git log` serves as an experiment log:

```
exp: <what you tried> -> <key metric>=<value>

exp: lr=3e-4, bs=64, warmup=1000 -> val_loss=0.42, ppl=12.3
exp: add dropout=0.1 to attention -> val_loss=0.39 (3% improvement)
exp: switch to BF16 training -> same loss, 1.8x faster, 40% less memory
```

This makes it trivial to search experiment history: `git log --grep="val_loss" --oneline`
</Remark>

## Tracking Large Files

ML projects generate large binary files -- model checkpoints (hundreds of MB to hundreds of GB), datasets, and embeddings. These must not go in regular Git (it stores full copies of every version, bloating the repository):

<Code id="code-git-for-ml-2" caption="Git LFS for tracking large binary files alongside your code.">

```bash
# ── Setup Git LFS ──
git lfs install                    # One-time setup per user

# ── Track file patterns ──
git lfs track "*.pt"               # PyTorch model files
git lfs track "*.bin"              # Binary weight files
git lfs track "*.safetensors"      # SafeTensors format
git lfs track "*.onnx"             # ONNX models
git lfs track "data/*.parquet"     # Data files
git add .gitattributes             # LFS config stored here
git commit -m "Configure git-lfs tracking"

# ── Use normally -- LFS handles the rest ──
git add model.pt                   # Stored via LFS (pointer in Git, file on LFS server)
git commit -m "Add trained model checkpoint"
git push                           # Uploads to LFS server

# ── Inspect LFS state ──
git lfs ls-files                   # List tracked files
git lfs status                     # Show pending LFS operations
git lfs fetch --all                # Download all LFS files (useful after clone)
```

</Code>

<Table id="tab-large-file-tools" caption="Comparison of large file management tools for ML.">

| Tool | What It Stores | Where Files Live | Git Integration | Best For |
|------|---------------|-----------------|----------------|---------|
| Git LFS | Pointers in Git, files on LFS server | GitHub LFS, S3, or custom server | Transparent (just `git push`) | Model files, small datasets |
| DVC | Metadata in Git, files on remote storage | S3, GCS, Azure, SSH, local | Separate commands (`dvc push`) | Large datasets, pipelines |
| Weights & Biases | Artifacts and metadata | W&B cloud | API-based | Experiment artifacts |
| Hugging Face Hub | Models and datasets | HF Hub | Git-based (via `huggingface-cli`) | Sharing pretrained models |

</Table>

## DVC (Data Version Control)

DVC extends Git with data and pipeline versioning. It stores small metadata files (`.dvc`) in Git while keeping the actual data on remote storage:

<Code id="code-git-for-ml-3" caption="DVC for data versioning and reproducible pipelines.">

```bash
pip install dvc dvc-s3    # Install DVC with S3 backend

# ── Initialize DVC ──
dvc init
dvc remote add -d storage s3://my-bucket/dvc-store
git add .dvc .dvcignore
git commit -m "Initialize DVC"

# ── Track a dataset ──
dvc add data/train.parquet         # Creates data/train.parquet.dvc (metadata)
git add data/train.parquet.dvc data/.gitignore
git commit -m "data: add training dataset v1"
dvc push                           # Upload actual data to S3

# ── Reproduce pipeline ──
dvc repro                          # Re-run only changed stages

# ── Switch between data versions ──
git checkout v1.0                  # Switch to old code
dvc checkout                       # Restore matching data version
```

</Code>

<Code id="code-dvc-pipeline" caption="DVC pipeline definition for reproducible ML experiments.">

```yaml
# dvc.yaml -- define a reproducible pipeline (DAG of stages)
stages:
  preprocess:
    cmd: python preprocess.py --input data/raw/ --output data/processed/
    deps:                              # If any dep changes, stage re-runs
      - data/raw/
      - preprocess.py
    outs:                              # Outputs tracked by DVC
      - data/processed/

  train:
    cmd: python train.py --config config.yaml
    deps:
      - data/processed/
      - train.py
      - config.yaml
    outs:
      - models/best.pt
    metrics:                           # Tracked but not stored in DVC
      - metrics.json:
          cache: false
    plots:                             # Visualization data
      - plots/loss_curve.csv:
          cache: false

  evaluate:
    cmd: python evaluate.py --model models/best.pt --data data/test/
    deps:
      - models/best.pt
      - evaluate.py
      - data/test/
    metrics:
      - eval_metrics.json:
          cache: false
```

</Code>

<Remark id="rmk-dvc-vs-lfs">
**DVC vs Git LFS: when to use which.**
- **Git LFS**: Use for model checkpoints and small-to-medium binary files (< 10 GB total) that change infrequently. Simpler workflow (just `git push`).
- **DVC**: Use for large datasets (10+ GB), data pipelines, and when you need to version data independently from code. More powerful but requires separate `dvc push/pull` commands.
- **Both can coexist** in the same repository if needed.
</Remark>

## .gitignore for ML Projects

A proper `.gitignore` prevents accidentally committing large files, credentials, or environment-specific artifacts:

<Code id="code-git-for-ml-5" caption="Comprehensive .gitignore for ML projects.">

```gitignore
# ── Data (use DVC or LFS for these) ──
data/raw/
data/processed/
*.parquet
*.csv
*.jsonl
*.h5
*.hdf5
*.tfrecord

# ── Models (use DVC or LFS) ──
*.pt
*.pth
*.bin
*.onnx
*.safetensors
checkpoints/
outputs/

# ── Logs and experiment tracking ──
wandb/
runs/
logs/
tb_logs/
*.log
mlruns/

# ── Python ──
.venv/
__pycache__/
*.pyc
*.pyo
*.egg-info/
dist/
build/
.eggs/

# ── Jupyter ──
.ipynb_checkpoints/

# ── Secrets (NEVER commit these) ──
.env
*.key
*.pem
credentials.json
secrets.yaml

# ── System ──
.DS_Store
Thumbs.db
*.swp
*.swo
*~

# ── IDE ──
.vscode/settings.json
.idea/
*.code-workspace
```

</Code>

<Remark id="rmk-gitignore-template">
**Create your .gitignore first.** Before writing any code, set up `.gitignore`. It is much easier to prevent large files from entering the repository than to remove them after committing (removing a 10 GB model checkpoint from Git history requires `git filter-branch` or BFG Repo-Cleaner, which rewrites history).
</Remark>

## Useful Git Workflows

<Code id="code-git-for-ml-6" caption="Git workflows commonly used in ML development.">

```bash
# ── Stash changes while switching context ──
git stash                          # Save uncommitted changes
git checkout main
git checkout -b fix/nan-loss       # Fix a bug
git add . && git commit -m "fix: handle NaN in loss computation"
git checkout exp/my-experiment
git stash pop                      # Restore changes

# ── Cherry-pick a fix into your experiment ──
git cherry-pick abc123             # Apply specific commit to current branch

# ── Find which commit broke training ──
git bisect start
git bisect bad                     # Current commit is broken
git bisect good v1.0               # This tag was working
# Git checks out a midpoint commit; test and mark good/bad
# Repeat until the breaking commit is found
git bisect reset                   # Return to original state

# ── See what changed in a file over time ──
git log --oneline -p -- train.py   # All changes to train.py
git blame train.py                 # Who changed each line and when

# ── Clean up experiment branches ──
git branch --merged main | grep "exp/" | xargs git branch -d
```

</Code>

<Table id="tab-git-practices" caption="Git best practices for ML projects.">

| Practice | Why |
|----------|-----|
| Commit early and often | Disk is cheap; lost work is expensive |
| Include results in commit messages | `git log` becomes an experiment logbook |
| Tag successful experiments | Easy to return to known-good states |
| Never commit large files without LFS/DVC | Repository bloat is permanent and painful to fix |
| Keep config separate from code | Change experiments without modifying Python files |
| Use `.gitignore` from day one | Prevention is 100x easier than cleanup |
| Sign your commits (`git commit -S`) | Required for some organizations; good practice |

</Table>

<Remark id="rmk-experiment-tracking">
**Git vs dedicated experiment trackers.** Git with good commit messages gives you basic experiment tracking for free. For serious experiment management, complement Git with a dedicated tool:
- **Weights & Biases**: Logs metrics, hyperparameters, artifacts, and system metrics automatically. Best for team collaboration.
- **MLflow**: Open-source, self-hosted. Tracks experiments, packages models, supports deployment.
- **TensorBoard**: Lightweight, built into PyTorch. Best for loss curves and debugging training dynamics.
- **DVC + Git**: Version data and pipelines alongside code. Best for reproducibility.

Use Git for code versioning, and a tracking tool for metrics, hyperparameters, and artifacts. They are complementary, not competing.
</Remark>
