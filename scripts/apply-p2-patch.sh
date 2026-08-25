#!/usr/bin/env bash
# AI 生成声明:本脚本由 AI 生成,使用前请 review。
#
# 幂等应用 P2 事件帧过滤补丁(client-connection WebSocket downlink pump 钩子)。
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

if [[ -L "$LINK" ]]; then TARGET="$(readlink -f "$LINK")"
elif [[ -d "$LINK" ]]; then TARGET="$LINK"
else echo "✗ 未找到 client-connection:$LINK 不存在" >&2; exit 1; fi
FILE="$TARGET/lib/index.js"
[[ -f "$FILE" ]] || { echo "✗ $FILE 不存在" >&2; exit 1; }

VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('$TARGET/package.json','utf8')).version")"
PATCH="$PATCH_DIR/dsh-client-connection-$VERSION.patch"
[[ -f "$PATCH" ]] || { echo "✗ 没有对应版本的补丁:$PATCH(升级 dsh 后请 rebase patches/)" >&2; exit 1; }

if grep -q "__dshTenancy" "$FILE"; then
  echo "✓ 已打过补丁($VERSION @ $FILE),无需重复应用"; exit 0
fi

cp "$FILE" "$FILE.pristine"
if patch -s "$FILE" < "$PATCH"; then
  node --check "$FILE"
  echo "✓ 补丁已应用($VERSION):$FILE"
  echo "  原件备份:$FILE.pristine —— 重启 dsh 后生效;卸载 = cp 回去"
else
  cp "$FILE.pristine" "$FILE"
  echo "✗ 补丁不匹配(上游代码已漂移),已还原;请按 $PATCH 人工 rebase" >&2
  exit 1
fi
