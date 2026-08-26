#!/usr/bin/env bash
# AI 生成声明:本脚本由 AI 生成,使用前请 review。
#
# 幂等应用 dsh-tenancy 全部补丁:
#   P2 — 事件帧过滤(client-connection WebSocket downlink pump 钩子) → lib/index.js
#   P5 — 域名入口管理放行(client 浏览器端 isLoopback 放宽)         → lib/client.js
#
# 为什么是原地补丁而不是 pnpm patch:
#   dsh 采用两锚解析(dsh 安装优先、profile 兜底),且 $DSH_HOME/profiles/node_modules
#   里每个包只是指向安装目录的符号链接——client-connection 全机只有一份物理副本,
#   profile 的依赖树里也没有它,pnpm patch 看不见。原地改这一份即同时覆盖两个锚。
#   代价:dsh 升级后需重跑本脚本(若上游版本变化导致 .rej,需人工 rebase)。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
LINK="$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection"
PATCH_DIR="$(cd "$(dirname "$0")/.." && pwd)/patches"

# ── 定位 client-connection 物理副本 ──────────────────────────────
if [[ -L "$LINK" ]]; then TARGET="$(readlink -f "$LINK")"
elif [[ -d "$LINK" ]]; then TARGET="$LINK"
else echo "✗ 未找到 client-connection:$LINK 不存在" >&2; exit 1; fi

INDEX="$TARGET/lib/index.js"
CLIENT="$TARGET/lib/client.js"
[[ -f "$INDEX" ]] || { echo "✗ $INDEX 不存在" >&2; exit 1; }
[[ -f "$CLIENT" ]] || { echo "✗ $CLIENT 不存在" >&2; exit 1; }

VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('$TARGET/package.json','utf8')).version")"
PATCH="$PATCH_DIR/dsh-client-connection-$VERSION.patch"
[[ -f "$PATCH" ]] || { echo "✗ 没有对应版本的补丁:$PATCH(升级 dsh 后请 rebase patches/)" >&2; exit 1; }

# ── 幂等检查 ─────────────────────────────────────────────────────
P2_DONE=false; P5_DONE=false
grep -q "__dshTenancy"   "$INDEX"  && P2_DONE=true
grep -q "dsh-tenancy P5" "$CLIENT" && P5_DONE=true

if $P2_DONE && $P5_DONE; then
  echo "✓ 全部补丁已应用($VERSION),无需重复"
  exit 0
fi

# ── 备份 ─────────────────────────────────────────────────────────
cp "$INDEX"  "$INDEX.pristine"
cp "$CLIENT" "$CLIENT.pristine"
trap 'cp "$INDEX.pristine" "$INDEX" 2>/dev/null; cp "$CLIENT.pristine" "$CLIENT" 2>/dev/null' ERR

# ── 从组合补丁中拆出单文件补丁并应用 ────────────────────────────
split_patch() {
  local start="$1" out="$2"
  awk -v s="--- a/$start" '
    $0 == s { found=1; next }
    found && /^--- a\// { exit }
    found { print }
  ' "$PATCH" > "$out"
}

if ! $P2_DONE; then
  tmp=$(mktemp); split_patch "lib/index.js" "$tmp"
  patch -s "$INDEX" < "$tmp"; rm -f "$tmp"
  echo "  ✓ P2 事件帧过滤 → $INDEX"
fi

if ! $P5_DONE; then
  tmp=$(mktemp); split_patch "lib/client.js" "$tmp"
  patch -s "$CLIENT" < "$tmp"; rm -f "$tmp"
  echo "  ✓ P5 域名入口放行 → $CLIENT"
fi

# ── 语法校验 ─────────────────────────────────────────────────────
node --check "$INDEX"
node --check "$CLIENT"

trap - ERR
echo "✓ 补丁已应用($VERSION) —— 重启 dsh 后生效;卸载 = cp .pristine 回去"
