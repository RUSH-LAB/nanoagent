---
sidebar_position: 3
---

# Git for ML

## Branching for Experiments

<Code id="code-git-for-ml-1" caption="Code example.">

```bash
# One branch per experiment
git checkout -b exp/lr-sweep
# Make changes, train, evaluate
git add results/
git commit -m "exp: lr sweep [1e-5, 3e-4, 1e-3], best=3e-4"

# Compare experiments
git diff exp/baseline..exp/lr-sweep -- config.yaml
git log --oneline --graph exp/baseline exp/lr-sweep
```

</Code>

<Remark id="rmk-git-for-ml-1">
**Tip:** Use a consistent naming convention for experiment branches: `exp/<description>`. Include key results in the commit message so `git log` serves as an experiment log.
</Remark>

## Tracking Large Files

ML projects have large binary files (models, datasets) that should not go in regular Git:

<Code id="code-git-for-ml-2" caption="ML projects have large binary files (models, datasets) that should not go in.">

```bash
# Git LFS (Large File Storage)
git lfs install
git lfs track "*.pt"           # Track PyTorch model files
git lfs track "*.bin"          # Track binary weight files
git lfs track "data/*.parquet" # Track data files
git add .gitattributes
git commit -m "Configure git lfs tracking"

# Now git push handles large files automatically
git add model.pt               # Stored via LFS
git commit -m "Add trained model"
git push
```

</Code>

```bash
# Check what LFS is tracking
git lfs ls-files
git lfs status
```

## DVC (Data Version Control)

DVC tracks data and models outside of Git while keeping metadata in Git:

<Code id="code-git-for-ml-3" caption="DVC tracks data and models outside of Git while keeping metadata in Git.">

```bash
pip install dvc dvc-s3

# Initialize DVC
dvc init
dvc remote add -d storage s3://my-bucket/dvc

# Track a dataset
dvc add data/train.parquet
git add data/train.parquet.dvc data/.gitignore
git commit -m "Add training data"

# Push data to remote storage
dvc push

# Reproduce a pipeline
dvc repro                      # Re-run changed stages
```

</Code>

<Code id="code-git-for-ml-4" caption="```.">

```yaml
# dvc.yaml -- define a reproducible pipeline
stages:
  preprocess:
    cmd: python preprocess.py
    deps:
      - data/raw/
      - preprocess.py
    outs:
      - data/processed/

  train:
    cmd: python train.py --config config.yaml
    deps:
      - data/processed/
      - train.py
      - config.yaml
    outs:
      - models/best.pt
    metrics:
      - metrics.json:
          cache: false
```

</Code>

## .gitignore for ML Projects

<Code id="code-git-for-ml-5" caption="Code example.">

```gitignore
# Data
data/raw/
data/processed/
*.parquet
*.csv
*.jsonl

# Models
*.pt
*.bin
*.onnx
*.safetensors
checkpoints/

# Logs
wandb/
runs/
logs/
*.log

# Environment
.venv/
__pycache__/
*.pyc
.env

# System
.DS_Store
*.swp
```

</Code>

## Useful Git Workflows

<Code id="code-git-for-ml-6" caption="Code example.">

```bash
# Stash changes before switching branches
git stash
git checkout main
git checkout -b fix/bug
# Fix the bug
git checkout exp/my-experiment
git stash pop

# Cherry-pick a fix into your experiment branch
git cherry-pick abc123

# Bisect to find which commit broke training
git bisect start
git bisect bad                  # Current commit is broken
git bisect good v1.0            # This tag was working
# Git checks out a midpoint; test and mark good/bad
# Repeat until the breaking commit is found
```

</Code>

<Remark id="rmk-git-for-ml-2">
**Tip:** Commit early and often during experiments. Disk is cheap; lost work is expensive. Use `git stash` liberally when switching between tasks.
</Remark>
