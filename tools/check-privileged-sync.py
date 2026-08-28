#!/usr/bin/env python3
"""核对特权方法清单三处同步:核心 PRIVILEGED_METHODS ↔ Caddyfile @adminapi ↔ Authelia resources。

为什么需要它:影子路由不接管特权方法,它们靠「Caddy 把 Host 重写为 localhost」+「Authelia
只放 admins 组进这些路径」两道配置保护。三份清单各自独立维护,核心升级新增特权方法而另
两处没跟上 = 该方法在团队入口被当作普通方法放行(非 loopback 围栏下被调用)。

退出码:0 三处一致;1 存在漂移(打印缺在哪一侧)。
用法: python3 tools/check-privileged-sync.py [--core-file PATH] [--caddyfile PATH] [--authelia PATH]
"""
import argparse
import re
import sys
from pathlib import Path

DEFAULT_CORE = [
    "node_modules/.pnpm/@deepseek-ai+dsh-client-connection@0.1.1-rc.2_9b40f28fccfb9ee3f86188afc9586c29"
    "/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js",
]
DEFAULT_CADDY = ["examples/Caddyfile", "/etc/caddy/Caddyfile"]
DEFAULT_AUTHELIA = ["examples/authelia/configuration.yml", "/etc/authelia/configuration.yml"]


def literal_alternatives(pattern: str):
    """把 `(a|b|c)` 的可选分支展开成完整方法名集合。

    只处理本项目正则的实际形状:`^/api/(x\\.|y\\.(p|q|r))`,即字面量 + `\.` + 分组
    (最多两层嵌套),不做通用正则求解。返回 `namespace.method` 集合;命名空间整体
    授权的分支(x\\. 后面没东西)记作 `namespace.*`。
    """
    names = set()
    top = re.search(r"\^/api/\((.*)\)", pattern)
    if not top:
        return names

    def split_top(text):
        out, depth, cur = [], 0, ""
        for ch in text:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "|" and depth == 0:
                out.append(cur)
                cur = ""
            else:
                cur += ch
        out.append(cur)
        return out

    def branches(token):
        """'(a|b)' → ['a','b'];非分组 token → [token]。"""
        m = re.fullmatch(r"\((.*)\)", token)
        return split_top(m.group(1)) if m else [token]

    for token in split_top(top.group(1)):
        # token 形如 'settings\.' 或 'agentPreset\.(read|copy)' 或 'llm\.discoverModels'
        m = re.match(r"(.*?)\\\.(.*)$", token)
        head, tail = (m.group(1), m.group(2)) if m else (token, "")
        for h in branches(head):
            h = h[:-2] if h.endswith("\\.") else h
            for t in (branches(tail) if tail else [""]):
                names.add(f"{h}.{t}" if t else f"{h}.*")
    return names


def core_methods(path: Path):
    text = path.read_text(encoding="utf8")
    m = re.search(r"PRIVILEGED_METHODS = new Set\(\[(.*?)\]\)", text, re.S)
    if not m:
        sys.exit(f"core: 在 {path} 里找不到 PRIVILEGED_METHODS,请核对上游是否改了实现")
    return {s for s in re.findall(r'"([^"]+)"', m.group(1))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core-file")
    ap.add_argument("--caddyfile")
    ap.add_argument("--authelia")
    args = ap.parse_args()

    def pick(explicit, candidates, label):
        if explicit:
            p = Path(explicit)
            if not p.is_file():
                sys.exit(f"{label}: 指定的文件不存在 {p}")
            return p
        for c in candidates:
            p = Path(c)
            if p.is_file():
                return p
        sys.exit(f"{label}: 未找到候选文件之一 {candidates}")

    core = core_methods(pick(args.core_file, DEFAULT_CORE, "core"))
    caddy_file = pick(args.caddyfile, DEFAULT_CADDY, "caddy")
    authelia_file = pick(args.authelia, DEFAULT_AUTHELIA, "authelia")

    caddy_text = caddy_file.read_text(encoding="utf8")
    caddy_pat = re.search(r"@adminapi path_regexp adminapi (.+)", caddy_text)
    if not caddy_pat:
        sys.exit(f"caddy: {caddy_file} 里没有 '@adminapi path_regexp' 一行(还是旧的精确路径写法?)")
    caddy = literal_alternatives(caddy_pat.group(1).strip())

    atxt = authelia_file.read_text(encoding="utf8")
    authelia_pats = re.findall(r"^\s+- '(\^/api/[^']*)'", atxt, re.M)
    if len(authelia_pats) < 2:
        sys.exit(f"authelia: {authelia_file} 应至少两条 ^/api/ resources(admins 放行 + 其余 deny)")
    authelia = literal_alternatives(authelia_pats[0])
    deny = literal_alternatives(authelia_pats[1])

    print(f"核心 PRIVILEGED_METHODS : {len(core)} 个   ({caddy_file.name} / {authelia_file.name})")
    ok = True
    for label, covered in (("Caddyfile @adminapi", caddy), ("Authelia allow", authelia), ("Authelia deny", deny)):
        missing = sorted(m for m in core if m not in covered and (m.split(".")[0] + ".*") not in covered)
        extra = sorted(c for c in covered if not c.endswith(".*") and c not in core)
        flag = "✓" if not missing and not extra else "✗"
        ok = ok and not missing and not extra
        print(f"  {flag} {label:20s} 缺失={missing or '无'} 多余={extra or '无'}")
    if len(authelia_pats) >= 2 and authelia_pats[0] != authelia_pats[1]:
        ok = False
        print("  ✗ Authelia 两条 resources 正则文本不一致(放行集与拒绝集必须同集)")
    print("→ " + ("三处一致" if ok else "存在漂移,见上面 ✗ 行"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
