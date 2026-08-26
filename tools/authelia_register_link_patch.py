#!/usr/bin/env python3
"""
Authelia v4.39.20 内嵌 Web 资产补丁：登录表单「重置密码」行左侧加入「邀请码注册」链接。

背景:
  Authelia 将 portal 前端 (public_html/**) 以 go:embed 原样内嵌进二进制,
  每个 blob 的指针+长度在编译期写死 —— 因此只能做【等长原地替换】;
  `server.asset_path` 仅支持覆盖 favicon/logo/locales, 覆盖不了 JS bundle。

改动内容 (portal.FirstFactorForm.*.js):
  * 重置密码行 Grid: justifyContent flex-end → space-between,
    外边距 marginBottom/marginTop → my 简写;
  * 行内左侧新增 MUI Link(id=register-link, href=/register, 文案「邀请码注册」);
  * 记住我行同步用 my 简写并去掉默认 flexDirection:row;
  * 省出的字节以空格补在模块末尾, 模块总长保持不变。

用法:
  python3 authelia_register_link_patch.py <authelia二进制> <该二进制对应的
      portal.FirstFactorForm.*.js 参考文件> <输出二进制>

参考文件可从线上取:
  curl -s http://127.0.0.1:9091/auth/static/js/portal.FirstFactorForm.<hash>.js

升级 Authelia 后 hash 会变, 先重新下载参考文件; 若锚点串不再匹配(前端重构),
需对照新 bundle 更新下方锚点定义。
"""
import sys

OLD_RESET = (
    b'r.resetPassword?(0,M.jsx)(p,{size:{xs:12},sx:{display:`flex`,flexDirection:`row`,'
    b'justifyContent:`flex-end`,marginBottom:e=>e.spacing(-1),marginTop:e=>e.spacing(-1)},'
    b'children:(0,M.jsx)(t,{id:`reset-password-button`,component:`button`,onClick:ue,'
    b'sx:{cursor:`pointer`,paddingBottom:`13.5px`,paddingTop:`13.5px`},underline:`hover`,'
    b'children:m(`Reset password?`)})}):null'
)

REG = '邀请码注册'.encode()  # 与原 nginx sub_filter 悬浮按钮文案一致

NEW_RESET = (
    b'r.resetPassword?(0,M.jsx)(p,{size:{xs:12},sx:{display:`flex`,justifyContent:`space-between`,my:e=>e.spacing(-1)},children:['
    b'(0,M.jsx)(t,{id:`register-link`,href:`/register`,underline:`hover`,sx:{cursor:`pointer`,py:`13.5px`},children:`' + REG + b'`}),'
    b'(0,M.jsx)(t,{id:`reset-password-button`,component:`button`,onClick:ue,'
    b'sx:{cursor:`pointer`,py:`13.5px`},underline:`hover`,children:m(`Reset password?`)})]}):null'
)

OLD_REMEMBER = b'sx:{display:`flex`,flexDirection:`row`,marginBottom:e=>e.spacing(-1),marginTop:e=>e.spacing(-1)}'
NEW_REMEMBER = b'sx:{display:`flex`,my:e=>e.spacing(-1)}'


def main(bin_path: str, ref_path: str, dst: str) -> None:
    blob = open(ref_path, 'rb').read()
    data = bytearray(open(bin_path, 'rb').read())
    size_orig = len(data)

    if blob.count(OLD_RESET) != 1 or blob.count(OLD_REMEMBER) != 1:
        sys.exit('reference bundle does not match expected v4.39.20 layout; update anchors')

    grown = (len(NEW_RESET) - len(OLD_RESET)) + (len(NEW_REMEMBER) - len(OLD_REMEMBER))
    pad = -grown
    if pad < 0:
        sys.exit(f'replacement grows by {-pad} bytes; shorten replacement first')

    # 模块补丁 + 尾部空格回填 => 总长不变
    mod = blob.replace(OLD_RESET, NEW_RESET).replace(OLD_REMEMBER, NEW_REMEMBER)
    mod += b' ' * pad
    assert len(mod) == len(blob)

    # 在二进制中唯一定位该模块 blob 并整体等长回写
    n = data.count(blob)
    if n != 1:
        sys.exit(f'bundle blob occurrences in binary: {n}, expected 1')
    i = data.find(blob)
    data[i:i + len(blob)] = mod

    assert len(data) == size_orig, 'total size changed'
    open(dst, 'wb').write(bytes(data))
    print(f'patched OK -> {dst} ({len(data)} bytes, blob@{i}, pad={pad})')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
