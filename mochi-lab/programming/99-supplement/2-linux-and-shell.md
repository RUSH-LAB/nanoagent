---
sidebar_position: 2
---

# Linux and Shell

## Essential Commands

```bash
# File operations
ls -lah                        # List files with human-readable sizes
du -sh *                       # Disk usage per directory
df -h                          # Free disk space
find . -name "*.py" -mtime -1  # Files modified in last day
wc -l train.py                 # Count lines

# Process management
ps aux | grep python           # Find running Python processes
top -u $USER                   # Monitor your processes
kill -9 PID                    # Force kill a process
nohup python train.py &        # Run in background, survive logout

# Text processing
grep -r "learning_rate" .      # Search recursively
head -n 100 log.txt            # First 100 lines
tail -f log.txt                # Follow log output in real time
cat file.jsonl | jq .          # Pretty-print JSON
sort -t',' -k2 -n results.csv  # Sort CSV by 2nd column numerically
```

## Environment Management

```bash
# Conda (recommended for ML)
conda create -n ml python=3.11
conda activate ml
conda install pytorch pytorch-cuda=12.1 -c pytorch -c nvidia
conda env export > environment.yml

# pip with virtual environments
python -m venv .venv
source .venv/bin/activate
pip install torch
pip freeze > requirements.txt

# UV (fast alternative)
uv venv
source .venv/bin/activate
uv pip install torch
```

**Tip:** Pin exact versions in `requirements.txt` for reproducibility. Use `pip install -e .` for editable installs during development.

## SSH and Remote Work

```bash
# SSH config (~/.ssh/config)
Host gpu-server
    HostName 192.168.1.100
    User alice
    IdentityFile ~/.ssh/id_ed25519
    ForwardAgent yes
    LocalForward 6006 localhost:6006   # TensorBoard

# Copy files
scp model.pt gpu-server:~/models/
rsync -avz --progress ./data/ gpu-server:~/data/

# Persistent sessions with tmux
tmux new -s train              # Create named session
tmux attach -t train           # Reattach to session
# Ctrl+B, D to detach (keeps running)
# Ctrl+B, [ to scroll
```

## GPU Management

```bash
# Check GPU status
nvidia-smi                     # Snapshot
nvidia-smi dmon -s u           # Continuous monitoring
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv

# Set visible GPUs
export CUDA_VISIBLE_DEVICES=0,1   # Only use GPUs 0 and 1
CUDA_VISIBLE_DEVICES=2 python train.py  # Single-command override

# Watch GPU memory
watch -n 1 nvidia-smi          # Update every second
```

## SLURM (Cluster Job Scheduling)

```bash
#!/bin/bash
#SBATCH --job-name=train
#SBATCH --nodes=2
#SBATCH --ntasks-per-node=4
#SBATCH --gpus-per-node=4
#SBATCH --cpus-per-task=8
#SBATCH --mem=256G
#SBATCH --time=24:00:00
#SBATCH --partition=gpu
#SBATCH --output=logs/%j.out

module load cuda/12.1
source activate ml

srun torchrun \
    --nnodes=$SLURM_NNODES \
    --nproc_per_node=4 \
    --rdzv_backend=c10d \
    --rdzv_endpoint=$MASTER_ADDR:$MASTER_PORT \
    train.py
```

```bash
# SLURM commands
sbatch train.sh                # Submit job
squeue -u $USER                # Check your jobs
scancel JOB_ID                 # Cancel a job
sacct -j JOB_ID --format=Elapsed,MaxRSS,MaxVMSize  # Job stats
sinfo -p gpu                   # Check partition availability
```

**Tip:** Always write SLURM scripts that are idempotent -- they should handle restarts gracefully with checkpoint loading. Use `--signal=SIGUSR1@120` to get a 2-minute warning before timeout.
