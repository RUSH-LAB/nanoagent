#!/bin/bash
# ══════════════════════════════════════════════════════════════
# MOCHI LAB — 永不停止的监工脚本
# 每20分钟自动运行测试、找bug、优化代码、提交
# Usage: bash scripts/supervisor.sh
# ══════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")/.."

INTERVAL=${1:-1200}  # 默认20分钟 (1200秒)
LOG="logs/supervisor.log"
mkdir -p logs

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG"; }

# ── 确保服务器运行 ──
ensure_server() {
  if ! curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
    log "${YELLOW}Server down — restarting...${NC}"
    kill $(lsof -ti:3001) 2>/dev/null || true
    sleep 1
    node server.js &
    sleep 3
    log "${GREEN}Server restarted${NC}"
  fi
}

# ── 运行全部测试 ──
run_tests() {
  local passed=0 failed=0 total=0

  for script in scripts/tests/test-*.mjs; do
    [ -f "$script" ] || continue
    local name=$(basename "$script" .mjs)
    local result=$(node "$script" 2>&1 | tail -1)
    local p=$(echo "$result" | grep -oE '[0-9]+' | head -1)
    local f=$(echo "$result" | grep -oE '[0-9]+' | tail -1)

    if echo "$result" | grep -q "passed"; then
      passed=$((passed + p))
      total=$((total + p + f))
      log "  ${GREEN}✓${NC} $name: $p passed"
    else
      failed=$((failed + 1))
      log "  ${RED}✗${NC} $name: failed to run"
    fi
  done

  log "Tests: ${GREEN}$passed${NC} passed / $total total"
  return 0
}

# ── 语法检查 ──
syntax_check() {
  if node -c server.js 2>&1 | grep -q "error"; then
    log "${RED}server.js syntax error!${NC}"
    return 1
  fi
  log "${GREEN}Syntax: OK${NC}"
}

# ── 代码统计 ──
stats() {
  local lines=$(find . -type f \( -name '*.js' -o -name '*.jsx' -o -name '*.tsx' -o -name '*.css' \) \
    -not -path '*/node_modules/*' -exec cat {} + 2>/dev/null | wc -l | tr -d ' ')
  local files=$(find . -type f \( -name '*.js' -o -name '*.jsx' -o -name '*.tsx' -o -name '*.css' \) \
    -not -path '*/node_modules/*' | wc -l | tr -d ' ')
  local pages=$(ls src/pages/*.js 2>/dev/null | wc -l | tr -d ' ')
  local endpoints=$(grep -c "pathname ===" server.js 2>/dev/null || echo 0)

  log "Code: ${CYAN}$lines${NC} lines | $files files | $pages pages | $endpoints endpoints"
}

# ── 自动提交 ──
auto_commit() {
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    git add -A
    local changed=$(git diff --cached --stat | tail -1)
    git commit -m "chore: auto-optimize — $changed" 2>/dev/null || true
    git push origin dev-north-star 2>/dev/null && \
      log "${GREEN}Pushed to git${NC}" || \
      log "${YELLOW}Push failed (will retry)${NC}"
  else
    log "No changes to commit"
  fi
}

# ── 用 Claude Code 自动优化 ──
auto_optimize() {
  # 如果有 claude 命令，用它来自动找bug和优化
  if command -v claude &> /dev/null; then
    log "${CYAN}Launching Claude Code optimization...${NC}"
    claude -p "你是监工。做以下事情：
1. 运行 node scripts/tests/test-api.mjs 确认所有测试通过
2. 如果有失败的测试，修复它们
3. 找一个可以优化的地方（性能、安全、代码质量、新功能）
4. 实现优化
5. 再次运行测试确认没有破坏任何东西
6. 如果有改动，git add -A && git commit && git push
报告你做了什么。" --max-turns 20 2>&1 | tail -20 | tee -a "$LOG"
  else
    log "${YELLOW}Claude CLI not found — running tests only${NC}"
  fi
}

# ══════════════════════════════════════════════════════════════
# 主循环 — 永不停止
# ══════════════════════════════════════════════════════════════

log ""
log "═══════════════════════════════════════════════"
log " MOCHI LAB 监工 — 永不停止"
log " 间隔: ${INTERVAL}秒 | PID: $$"
log " Ctrl+C 停止"
log "═══════════════════════════════════════════════"
log ""

CYCLE=0
while true; do
  CYCLE=$((CYCLE + 1))
  log ""
  log "════════ 第 $CYCLE 轮 ════════"

  # 1. 确保服务器运行
  ensure_server

  # 2. 语法检查
  syntax_check || { log "${RED}Syntax broken — skipping this cycle${NC}"; sleep "$INTERVAL"; continue; }

  # 3. 代码统计
  stats

  # 4. 运行测试
  run_tests

  # 5. 自动优化 (用 Claude Code)
  auto_optimize

  # 6. 自动提交
  auto_commit

  # 7. 等待下一轮
  log ""
  log "下一轮: $(date -v+${INTERVAL}S '+%H:%M:%S' 2>/dev/null || date -d "+${INTERVAL} seconds" '+%H:%M:%S' 2>/dev/null || echo "${INTERVAL}s later")"
  sleep "$INTERVAL"
done
