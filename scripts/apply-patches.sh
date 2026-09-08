#!/usr/bin/env bash
# AI 生成声明:本脚本由 AI 生成,使用前请 review。
#
# 幂等应用 dsh-tenancy 全部补丁(按安装版本匹配 patches/<pkg>-<version>.patch):
#   P2 — 事件帧过滤 + 流开闸(dsh-api-gateway 的 /api/remote.mux mux)→ lib/index.js
#   P5 — 域名入口管理放行(client 浏览器端 isLoopback 放宽)
#        → dsh-client-connection/lib/client.js
# 附带预检:profile overlay 若存在未打补丁的 client-connection 副本(重复核心包,
#   还会导致 agent-presets unscoped-context 报错)则拒绝继续并给出清理指引。
#
# dsh 0.1.2 起事件流从 client-connection 的 WS downlink pump 迁到
# dsh-api-gateway 的 /api/remote.mux mux,P2 的补丁目标随之迁移——两个包都要打。
# dsh ≤0.1.1 请改用本仓库历史版本的脚本与 patches/(仅 client-connection 单包)。
#
# 为什么是原地补丁而不是 pnpm patch:
#   dsh 采用两锚解析(dsh 安装优先、profile 兜底),且 $DSH_HOME/profiles/node_modules
#   里每个包只是指向安装目录的符号链接——client-connection / api-gateway 全机只有
#   一份物理副本,profile 的依赖树里也没有它们,pnpm patch 看不见。原地改这一份即
#   同时覆盖两个锚。代价:dsh 升级后需重跑本脚本(若上游版本变化导致 .rej,
#   需人工 rebase)。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
LINK_BASE="$DSH_HOME/profiles/node_modules/@deepseek-ai"
PATCH_DIR="$(cd "$(dirname "$0")/.." && pwd)/patches"

# 包名 | 幂等标记(grep 该包打补丁后的特征串)
TARGETS=(
  "dsh-client-connection|dsh-tenancy P5"
  "dsh-api-gateway|__dshTenancy"
)

# ── 预检:profile overlay 里的重复核心包 ──────────────────────────
# 若某个 profile(如 web)的 node_modules/@deepseek-ai 里装着与 dsh 内置同名的
# 核心包副本(常见于重装后用 `pnpm add @deepseek-ai/*@<version>` 手工补依赖),
# ① 这份副本不会被打到(本脚本只打内置那唯一一份物理副本),
#    而运行中的进程可能优先加载副本 → P2/P5 静默失效;
# ② 更糟:重复的 dsh-scope/agent-presets 会让 agent 上下文的 scope 标记跨副本
#    不可见,选模型/新建会话直接报
#    `agent-presets: refusing to compose an unscoped context`。
check_overlay() {
  local pkg="$1" pristine="$2"
  for OVERLAY in "$DSH_HOME"/profiles/*/node_modules/@deepseek-ai/"$pkg"; do
    [[ -e "$OVERLAY" ]] || continue
    PROFILE_DIR="$(cd "$(dirname "$OVERLAY")/../../.." && pwd)"
    [[ "$(readlink -f "$OVERLAY")" != "$pristine" ]] || continue
    local overlay_index="$OVERLAY/lib/index.js"
    if [[ -f "$overlay_index" ]] && ! grep -q "__dshTenancy" "$overlay_index"; then
      echo "⚠ 发现 profile '$PROFILE_DIR' 的 overlay 有未打补丁的 $pkg 副本:$OVERLAY" >&2
      echo "  P2/P5 对运行中的该 profile 不生效;且若 overlay 同时装有重复的 dsh-scope/" >&2
      echo "  dsh-agent-presets 等核心包,会触发 agent-presets 的 unscoped context 报错。" >&2
      echo "  解法:删除 overlay 里与内置树重复的 @deepseek-ai/*(保留仅 overlay 独有的包):" >&2
      echo "    cd \"$PROFILE_DIR\" && pnpm remove @deepseek-ai/<与内置重复的包…> && pm2 restart dsh-web" >&2
      echo "  或至少删除本副本后再重跑本脚本。" >&2
      exit 1
    fi
  done
}

ANY_APPLIED=false

for entry in "${TARGETS[@]}"; do
  pkg="${entry%%|*}"
  marker="${entry##*|}"
  LINK="$LINK_BASE/$pkg"
  if [[ -L "$LINK" ]]; then TARGET="$(readlink -f "$LINK")"
  elif [[ -d "$LINK" ]]; then TARGET="$LINK"
  else echo "✗ 未找到 $pkg:$LINK 不存在" >&2; exit 1; fi

  VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('$TARGET/package.json','utf8')).version")"
  PATCH="$PATCH_DIR/$pkg-$VERSION.patch"
  [[ -f "$PATCH" ]] || { echo "✗ 没有对应版本的补丁:$PATCH(升级 dsh 后请 rebase patches/)" >&2; exit 1; }

  # ── 幂等检查 ─────────────────────────────────────────────────
  ALREADY=true
  for f in "$TARGET"/lib/*.js; do
    [[ -f "$f" ]] || continue
    grep -q "$marker" "$f" || ALREADY=false
  done
  if $ALREADY; then
    echo "✓ $pkg@$VERSION 补丁已应用,跳过"
    continue
  fi

  check_overlay "$pkg" "$TARGET"
  ANY_APPLIED=true

  # ── 备份 + 应用 + 语法校验 ────────────────────────────────────
  echo "  → 应用 $pkg@$VERSION 补丁…"
  for f in "$TARGET"/lib/*.js; do
    [[ -f "$f" ]] || continue
    [[ -f "$f.pristine" ]] || cp "$f" "$f.pristine"
  done
  # 失败回滚:全部还原为 pristine
  restore() {
    for f in "$TARGET"/lib/*.js; do
      [[ -f "$f.pristine" ]] && cp "$f.pristine" "$f"
    done
  }
  trap 'restore' ERR
  if ! patch -s -d "$TARGET" -p1 < "$PATCH"; then
    echo "✗ $pkg@$VERSION 补丁应用失败(.rej 已留在原地,需人工 rebase patches/)" >&2
    exit 1
  fi
  for f in "$TARGET"/lib/*.js; do
    [[ -f "$f" ]] || continue
    node --check "$f"
  done
  trap - ERR
  echo "  ✓ $pkg@$VERSION 补丁已应用"
done

if $ANY_APPLIED; then
  echo "✓ 全部补丁应用完成 —— 重启 dsh 后生效;卸载 = cp *.pristine 回原文件"
else
  echo "✓ 无需操作"
fi
