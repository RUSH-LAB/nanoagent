---
sidebar_position: 2
---

# Linux and Shell

ML engineering happens on Linux servers. Whether you are SSHing into a GPU cluster, managing training jobs with SLURM, or debugging a crashed process at 2 AM, fluency with the shell is a force multiplier. This chapter covers the essential commands, environment management, remote work patterns, GPU management, and job scheduling that ML engineers use daily.

## Essential Commands

<Code id="code-linux-essential" caption="Core Linux commands grouped by task.">

```bash
# ── File operations ──
ls -lah                            # List files with permissions, sizes, dates
du -sh * | sort -rh | head -20     # Top 20 directories by size
df -h                              # Free disk space per filesystem
find . -name "*.pt" -size +1G      # Find model files larger than 1 GB
find . -name "*.py" -mtime -1      # Python files modified in last 24 hours
wc -l src/**/*.py                  # Count lines across all Python files

# ── Process management ──
ps aux | grep python               # Find running Python processes
top -u $USER                       # Monitor your processes (CPU, memory)
htop                               # Interactive process viewer (better than top)
kill -SIGTERM PID                  # Graceful shutdown (allows cleanup)
kill -SIGKILL PID                  # Force kill (no cleanup, last resort)
nohup python train.py &            # Run in background, survive logout
disown %1                          # Detach job 1 from current shell

# ── Text processing ──
grep -rn "learning_rate" .         # Search recursively with line numbers
grep -rn "lr" --include="*.py" .   # Search only Python files
head -n 100 log.txt                # First 100 lines
tail -f log.txt                    # Follow log output in real time
tail -n +1000 log.txt | head -100  # Lines 1000-1099
cat file.jsonl | python -m json.tool  # Pretty-print JSON (no jq needed)
sort -t',' -k2 -n results.csv     # Sort CSV by 2nd column numerically
awk -F',' '{sum+=$2} END {print sum/NR}' results.csv  # Average of column 2

# ── Disk cleanup for ML ──
find . -name "__pycache__" -type d -exec rm -rf {} +   # Remove pycache
find . -name "*.pyc" -delete       # Remove compiled Python files
```

</Code>

<Table id="tab-shell-shortcuts" caption="Bash keyboard shortcuts for faster command-line work.">

| Shortcut | Action |
|----------|--------|
| Ctrl+R | Search command history (reverse-i-search) |
| Ctrl+A / Ctrl+E | Jump to beginning / end of line |
| Ctrl+W | Delete word before cursor |
| Ctrl+U | Delete from cursor to beginning of line |
| Ctrl+L | Clear screen (same as `clear`) |
| Alt+. | Insert last argument from previous command |
| `!!` | Repeat last command (`sudo !!` is common) |
| `!$` | Last argument of previous command |

</Table>

## Environment Management

Reproducible environments are essential for ML. A model trained in one environment should produce the same results in another:

<Code id="code-env-management" caption="Python environment management tools for ML.">

```bash
# ── Conda (recommended for ML: handles CUDA, cuDNN, NCCL) ──
conda create -n ml python=3.11
conda activate ml
conda install pytorch pytorch-cuda=12.1 -c pytorch -c nvidia
conda env export > environment.yml           # Full export (platform-specific)
conda env export --from-history > env.yml    # Only explicitly installed packages
conda env create -f environment.yml          # Recreate environment

# ── pip with venv (lightweight, no CUDA management) ──
python -m venv .venv
source .venv/bin/activate
pip install torch
pip freeze > requirements.txt                # Exact versions
pip install -r requirements.txt              # Recreate

# ── UV (fast Rust-based pip replacement, 10-100x faster) ──
uv venv
source .venv/bin/activate
uv pip install torch                         # Fast install
uv pip compile requirements.in -o requirements.txt  # Lock versions
uv pip sync requirements.txt                 # Install exactly what's locked

# ── Docker (full reproducibility including OS, CUDA driver) ──
# Use NVIDIA's base images for GPU support
# FROM nvcr.io/nvidia/pytorch:24.01-py3
```

</Code>

<Table id="tab-env-tools" caption="Environment management tools comparison.">

| Tool | Manages CUDA/cuDNN | Speed | Reproducibility | Best For |
|------|--------------------|-------|----------------|---------|
| conda | Yes (from channel) | Slow (minutes) | Platform-specific export | GPU ML development |
| pip + venv | No (system CUDA) | Medium | requirements.txt | Simple projects |
| uv | No (system CUDA) | Very fast (seconds) | Lock file | Modern Python projects |
| Docker | Yes (NVIDIA base image) | Slow (build), fast (pull) | Complete | Deployment, cluster |
| pixi | Yes (conda-forge) | Fast (Rust) | Lock file | Cross-platform ML |

</Table>

<Remark id="rmk-env-tips">
**Environment tips:**
- **Pin exact versions** in `requirements.txt` for reproducibility: `torch==2.2.0`, not `torch>=2.0`.
- **Use `pip install -e .`** for editable installs during development -- changes to your code take effect immediately without reinstalling.
- **Keep CUDA versions consistent**: `nvidia-smi` shows the driver's max supported CUDA, but `nvcc --version` shows the toolkit version. PyTorch must match the toolkit version.
- **Export minimal specs**: `conda env export --from-history` or a hand-curated `requirements.txt` with only direct dependencies.
</Remark>

## SSH and Remote Work

ML training happens on remote servers. Efficient remote work requires persistent sessions, port forwarding, and fast file transfer:

<Code id="code-ssh-config" caption="SSH configuration and remote work patterns.">

```bash
# ── SSH config (~/.ssh/config) for convenience ──
Host gpu-server
    HostName 192.168.1.100
    User alice
    IdentityFile ~/.ssh/id_ed25519
    ForwardAgent yes                          # Forward SSH keys (for git)
    LocalForward 6006 localhost:6006          # TensorBoard
    LocalForward 8888 localhost:8888          # Jupyter
    ServerAliveInterval 60                    # Keep connection alive
    ServerAliveCountMax 5

Host gpu-cluster-*
    ProxyJump bastion                         # Jump through bastion host
    User alice

# Now just: ssh gpu-server

# ── File transfer ──
scp model.pt gpu-server:~/models/             # Copy single file
rsync -avz --progress ./data/ gpu-server:~/data/  # Sync directory (incremental)
rsync -avz --exclude='__pycache__' --exclude='.git' \
    ./project/ gpu-server:~/project/          # Sync code, skip junk

# ── Persistent sessions with tmux ──
tmux new -s train                             # Create named session
tmux attach -t train                          # Reattach after disconnect
tmux ls                                       # List sessions
# Ctrl+B, D    -> detach (session keeps running)
# Ctrl+B, [    -> scroll mode (q to exit)
# Ctrl+B, %    -> split pane vertically
# Ctrl+B, "    -> split pane horizontally
# Ctrl+B, z    -> zoom/unzoom current pane
```

</Code>

<Table id="tab-tmux-patterns" caption="Useful tmux patterns for ML training sessions.">

| Pattern | Purpose |
|---------|---------|
| `tmux new -s train` then `python train.py` | Training survives SSH disconnect |
| Split pane: train + `watch nvidia-smi` | Monitor GPU while training |
| Split pane: train + `tail -f log.txt` | Monitor logs while training |
| Multiple windows: code, train, eval | Organize different tasks |
| `tmux send-keys -t train "python eval.py" Enter` | Send command to running session from outside |

</Table>

## GPU Management

<Code id="code-gpu-management" caption="GPU monitoring and management commands.">

```bash
# ── Check GPU status ──
nvidia-smi                                    # Snapshot of all GPUs
nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,\
utilization.gpu,temperature.gpu --format=csv  # Structured output

# ── Continuous monitoring ──
watch -n 1 nvidia-smi                         # Update every second
nvidia-smi dmon -s u -d 1                     # GPU utilization every second
nvitop                                        # Interactive GPU monitor (pip install nvitop)

# ── Control GPU visibility ──
export CUDA_VISIBLE_DEVICES=0,1               # Only GPUs 0 and 1 visible
CUDA_VISIBLE_DEVICES=2 python train.py        # Single-command override
CUDA_VISIBLE_DEVICES="" python test.py        # Force CPU only

# ── Check CUDA/driver compatibility ──
nvidia-smi                                    # Shows max supported CUDA version
nvcc --version                                # Shows installed toolkit version
python -c "import torch; print(torch.cuda.is_available(), torch.version.cuda)"

# ── Reset GPU (if stuck) ──
nvidia-smi --gpu-reset -i 0                   # Reset GPU 0 (kills all processes)
fuser -v /dev/nvidia*                         # Find processes using GPUs
```

</Code>

<Remark id="rmk-gpu-env-vars">
**Important GPU environment variables:**

| Variable | Purpose | Example |
|----------|---------|---------|
| `CUDA_VISIBLE_DEVICES` | Restrict visible GPUs | `0,1,2,3` |
| `NCCL_DEBUG` | NCCL logging level | `INFO`, `WARN` |
| `NCCL_P2P_DISABLE` | Disable P2P (PCIe issues) | `1` |
| `TORCH_CUDA_ARCH_LIST` | Target GPU architectures for compilation | `8.0;9.0` |
| `PYTORCH_CUDA_ALLOC_CONF` | Tune CUDA allocator | `expandable_segments:True` |
| `CUDA_LAUNCH_BLOCKING` | Synchronous kernel launch (debugging) | `1` |
</Remark>

## SLURM (Cluster Job Scheduling)

SLURM manages GPU cluster resources. You submit jobs as scripts; SLURM schedules them when resources are available:

<Code id="code-slurm-script" caption="Complete SLURM job script for multi-node distributed training.">

```bash
#!/bin/bash
#SBATCH --job-name=llama-train
#SBATCH --nodes=2                    # 2 nodes
#SBATCH --ntasks-per-node=1          # 1 task per node (torchrun handles GPUs)
#SBATCH --gpus-per-node=4            # 4 GPUs per node
#SBATCH --cpus-per-task=32           # 32 CPU cores per task (for DataLoader)
#SBATCH --mem=256G                   # RAM per node
#SBATCH --time=24:00:00              # Max runtime
#SBATCH --partition=gpu              # GPU partition
#SBATCH --output=logs/%j_%x.out      # stdout (%j=job_id, %x=job_name)
#SBATCH --error=logs/%j_%x.err       # stderr
#SBATCH --signal=SIGUSR1@120         # Signal 120s before timeout (for checkpointing)

# Setup
module load cuda/12.1
source activate ml
export MASTER_ADDR=$(scontrol show hostname $SLURM_NODELIST | head -1)
export MASTER_PORT=29500

# Handle preemption/timeout: save checkpoint on SIGUSR1
trap 'echo "Received SIGUSR1, saving checkpoint..."; kill -SIGUSR1 $PID' SIGUSR1

# Launch distributed training
srun torchrun \
    --nnodes=$SLURM_NNODES \
    --nproc_per_node=4 \
    --rdzv_backend=c10d \
    --rdzv_endpoint=$MASTER_ADDR:$MASTER_PORT \
    train.py \
    --resume_from_checkpoint latest &

PID=$!
wait $PID
```

</Code>

<Code id="code-slurm-commands" caption="SLURM management commands.">

```bash
# ── Job management ──
sbatch train.sh                    # Submit job
squeue -u $USER                    # Check your jobs
squeue -u $USER -o "%.10i %.30j %.8T %.10M %.6D %R"  # Custom format
scancel JOB_ID                     # Cancel a job
scancel -u $USER                   # Cancel all your jobs

# ── Job information ──
sacct -j JOB_ID --format=JobID,Elapsed,MaxRSS,MaxVMSize,State  # Job stats
scontrol show job JOB_ID           # Detailed job info
seff JOB_ID                        # Job efficiency (CPU, memory usage)

# ── Cluster information ──
sinfo -p gpu                       # Check GPU partition availability
sinfo -p gpu -o "%20N %10c %10m %25G %20T"  # Node details
squeue -p gpu | wc -l              # Number of queued jobs

# ── Interactive session ──
srun --partition=gpu --gpus=1 --cpus-per-task=8 --mem=64G \
    --time=4:00:00 --pty bash      # Interactive GPU session
```

</Code>

<Table id="tab-slurm-tips" caption="SLURM best practices for ML training jobs.">

| Practice | Why |
|----------|-----|
| Save checkpoints every N steps | Resume after preemption/timeout without losing work |
| Use `--signal=SIGUSR1@120` | Get 2-minute warning before timeout to save final checkpoint |
| Set `--output=logs/%j.out` | Unique log per job; `%j` = job ID |
| Request exact resources needed | Over-requesting reduces scheduling priority |
| Use `--array=1-10` for sweeps | Submit 10 jobs with different hyperparameters |
| Test with `--time=0:30:00` first | Short test run to catch errors before 24h job |
| Use `--dependency=afterok:JOB_ID` | Chain jobs (e.g., train then evaluate) |

</Table>

<Remark id="rmk-slurm-array">
**SLURM job arrays for hyperparameter sweeps.** Use `--array` to submit multiple jobs that differ by one variable:

```bash
#SBATCH --array=1-5
# In train.py, read SLURM_ARRAY_TASK_ID to select hyperparameters
LEARNING_RATES=(1e-5 3e-5 1e-4 3e-4 1e-3)
LR=${LEARNING_RATES[$SLURM_ARRAY_TASK_ID - 1]}
python train.py --lr $LR
```
</Remark>
