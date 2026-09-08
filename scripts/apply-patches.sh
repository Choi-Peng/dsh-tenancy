#!/usr/bin/env bash
# AI 生成声明:本脚本由 AI 生成,使用前请 review。
#
# 幂等应用 dsh-tenancy 全部补丁(按安装版本匹配 patches/<pkg>-<version>.patch):
#   P2 — 事件帧过滤 + 流开闸(dsh-api-gateway 的 /api/remote.mux mux)→ lib/index.js
#   P5 — 域名入口管理放行(client 浏览器端 isLoopback 放宽)
#        → dsh-client-connection/lib/client.js
#   P5b — 服务端 BrowserAuth 旁路(dsh 0.1.2+ 新增的进程 launch-token/签名 cookie):
#        经 Caddy/Authelia 进来、带 X-Dsh-Tenancy-Key 头的请求直接视为已认证,
#        免 dsh 的 browser-session cookie(否则远程浏览器首屏 / 与 /api/remote.mux
#        全部 401);直连(无此头)仍走 BrowserAuth。→ dsh-client-connection/lib/index.js
#        (requestRejection / authorizeIndex 两处旁路)
# 附带预检:profile overlay 若存在未打补丁的 client-connection 副本(重复核心包,
#   还会导致 agent-presets unscoped-context 报错)则拒绝继续并给出清理指引。
#
# ── 旧→新补丁平滑切换(如 80b82d → 6e507d)──────────────────────
# 部署文件若已带“旧补丁”(仅 P5、无 P5b),而新补丁基准是“未打补丁的原始文件”,
# 直接 patch 会因上下文对不上报 Reversed/already applied 并留 .rej。
# 本脚本采用「先还原基准 → 再打新补丁」策略:凡 .pristine 存在,必先从 .pristine
# 还原出原始文件(同时清掉上次的 .rej 与一切旧/半成品改动),再 --forward 打新补丁。
# 这样无需手工 revert 旧补丁,重跑本脚本即可从任意旧代次升级到当前代次。
# 幂等性改为:扫描到“当前代次独有标记”才跳过(见下方 MARKERS),避免把旧 P5 误判成
# “已含 P5b”而漏打。dsh ≤0.1.1 请改用本仓库历史版本的脚本与 patches/(仅 client-connection 单包)。
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

# 包名 | 当前代次独有标记(必须只在新补丁里出现,用于判定“已是最新代次”)
#   client-connection:用 [dsh-tenancy P5b](80b82d 旧补丁只有 P5,无 P5b → 不会误判为已最新)
#   api-gateway:      用 __dshTenancy(两段补丁均写入此全局对象)
TARGETS=(
  "dsh-client-connection|dsh-tenancy P5b"
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

  # 注:为兼容“旧代次 → 当前代次”无缝升级(如 80b82d → 6e507d 的 P5→P5b,
  # 以及 api-gateway 可能随代次变化的补丁),本脚本采用「先还原基准 → 再打当前补丁」
  # 的强制重打策略,而非“标记命中即跳过”。代价是每次重跑都会重打(结果幂等),
  # 好处是任何代次切换都能自动生效,无需手工 revert 旧补丁。

  # ── 还原基准:若之前打过任意代次补丁,用 .pristine 还原出原始文件 ──
  # 这一步同时清掉“旧补丁残留”与“上次失败留下的 .rej/半成品改动”,
  # 保证接下来 patch --forward 的基准 = 干净的未打补丁文件。
  if ls "$TARGET"/lib/*.pristine >/dev/null 2>&1; then
    echo "  · 检测到旧代次补丁痕迹,用 .pristine 还原基准…"
    for f in "$TARGET"/lib/*.pristine; do
      cp "$f" "${f%.pristine}"
    done
  fi
  rm -f "$TARGET"/lib/*.rej

  check_overlay "$pkg" "$TARGET"
  ANY_APPLIED=true

  # ── 备份原始文件(仅首次创建 .pristine;还原后不再覆盖,保住干净基准) ──
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
  # --forward:只正向应用,遇到已应用/反向一律报错而非交互询问(避免卡在 Assume -R?)
  if ! patch -s -d "$TARGET" -p1 --forward < "$PATCH"; then
    echo "✗ $pkg@$VERSION 补丁应用失败(.rej 已留在原地,需人工 rebase patches/ 或重装 dsh 后重跑)" >&2
    exit 1
  fi
  for f in "$TARGET"/lib/*.js; do
    [[ -f "$f" ]] || continue
    node --check "$f"
  done
  # 校验代次标记确实写入,否则视为未真正生效
  GREPPED=false
  for f in "$TARGET"/lib/*.js; do
    [[ -f "$f" ]] || continue
    grep -q "$marker" "$f" && GREPPED=true
  done
  if ! $GREPPED; then
    echo "✗ $pkg@$VERSION 补丁已打但代次标记 $marker 缺失,疑似补丁与目标版本不匹配" >&2
    exit 1
  fi
  trap - ERR
  echo "  ✓ $pkg@$VERSION 补丁已应用"
done

if $ANY_APPLIED; then
  echo "✓ 全部补丁应用完成 —— 重启 dsh 后生效;卸载 = cp *.pristine 回原文件"
else
  echo "✓ 无需操作"
fi
