---
name: publish-web-app
description: 在成员个人工作区编写/构建 Web 应用,用项目内虚拟环境隔离依赖,把构建产物放进 dist 目录,经公开站点以 https://dsh.example.com/<user>/<projectName>/ 发布;含免构建单 index.html 页面的写法
whenToUse: 用户要求开发、构建或发布一个可公开访问的网站/Web 应用/前端项目,或询问公开站点 URL、构建产物目录、如何让页面可访问、如何在项目里创建虚拟环境/安装依赖时
---

# 发布 Web 应用到公开站点

本部署的 tenancy 插件(P11「公开站点」)把成员个人工作区里**构建好的产物**匿名静态发布:

```
https://<公开域名>/<user>/<projectName>/
    →  ~/dsh/<user>/<projectName>/<publicBuildDir>/   (publicBuildDir 默认 dist)
```

公开域名与产物目录名由部署配置决定(插件配置 `publicSitesHosts` / `publicBuildDir`;
示例域名 `dsh.example.com`、目录 `dist`)。动手前先确认本部署的实际值;若公开站点
功能未启用(`publicSitesEnabled: false` 或未配置 nginx 转发),先告知用户该功能不可用,
不要承诺任何 URL。

## 硬性规则(违反 = 用户访问 404)

1. **产物必须落在 `<个人工作区>/<项目名>/<publicBuildDir>/` 目录里**
   - 个人工作区根 = `memberWorkspaceRoot/<user>`(默认 `~/dsh/<user>`)
   - 项目目录 = `~/dsh/<user>/<projectName>/`(项目名是 URL 路径段,用简短 kebab-case)
   - 发布目录 = `~/dsh/<user>/<projectName>/dist/`(publicBuildDir 默认 dist)
   - URL 映射:`/<user>/<projectName>/` → `dist/index.html`;
     `/<user>/<projectName>/assets/app.js` → `dist/assets/app.js`
2. **必须存在 `dist/index.html`**(或构建产出的入口页)。**只有 `dist` 目录会被公开
   服务**:项目根目录下的 `index.html`(没有 dist)不会被发布,访问是 404。
3. **资源引用必须相对**:站点挂在子路径 `/<user>/<projectName>/` 下,页面内资源
   必须用相对路径(`./assets/app.js`、`<base href="./">`),**禁止**写死
   `/assets/...`、`/favicon.ico` 这类绝对路径——它们会解析到域名根(`/assets/...`),
   而不是项目子路径,结果 404。

## 项目工作区内使用虚拟环境(依赖隔离)

**所有依赖操作都必须在项目目录 `~/dsh/<user>/<projectName>/` 内进行,绝不安装到
系统全局**——这是多租户共享主机,全局安装会污染他人环境,也常因权限被拒。

- **Python 项目 / 用到 Python 工具**:在项目目录创建虚拟环境,并**始终用它的
  解释器**干活:
  ```bash
  cd ~/dsh/<user>/<projectName>
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt   # 装进 venv,不动系统 Python
  .venv/bin/python build.py                    # 跑项目脚本 / 构建
  ```
  ⚠ DSH 的每条 bash 命令都是**全新 shell**,`source .venv/bin/activate` 不会跨
  命令生效——一律直接写 `.venv/bin/...` 全路径;确需激活时在同一条命令内
  `source .venv/bin/activate && ...`。
- **Node 项目**:依赖本来就装进项目内 `node_modules`(已是项目级隔离,无需 venv);
  但**禁止 `npm install -g`** 全局安装工具;用项目内 `node_modules/.bin/` 或
  `npx` 调用工具;保留 `package-lock.json` 保证可复现构建。
- **venv 放哪**:`.venv` 建在项目根(`~/dsh/<user>/<projectName>/.venv`),随项目
  隔离、随项目删除,不占全局空间。`.venv`、`node_modules` 是隐藏/依赖目录,
  **不会被公开站点服务**(公开站点只读 dist,隐藏文件一律 404),留在项目里即可,
  不必移出;若项目做版本管理,把它们加进 `.gitignore`。
- **构建产物与依赖目录分开**:依赖目录(`.venv`、`node_modules`)与发布目录
  (`dist`)是两个东西——只把**构建输出**复制/产出到 `dist`,不要把 `.venv` 或
  `node_modules` 弄进 `dist`。

## 有构建步骤的项目(框架 / Vite / webpack 等)

- 把构建输出目录配置为 `dist`(Vite 默认就是 `dist`,无需改;webpack 等设
  `output.path`、其它工具设 `outDir` 为 `dist`)。
- **Vite 额外设置 `base: './'`**(或 `base: ''`),否则产物里是绝对资源路径,子路径
  部署下全部 404。
- 构建完成后**必须验证** `dist/index.html` 真实存在,再告知用户 URL。

## 最简单的免构建单页(只有 index.html,无需任何构建工具)

```bash
mkdir -p ~/dsh/<user>/<projectName>/dist
# 把 index.html 写进 dist/ 即可(CSS/JS 可内联,或放 dist/ 下相对引用)
#   ~/dsh/<user>/<projectName>/dist/index.html
```

纯静态页面,写完即发布,不需要 package.json / npm / build 步骤。

## 完成后检查清单

- [ ] `~/dsh/<user>/<projectName>/dist/index.html` 存在
- [ ] 页面内资源均为相对路径(无 `/assets/...` 绝对引用)
- [ ] 告知用户最终 URL:`https://<公开域名>/<user>/<projectName>/`
      (不带尾斜杠会自动 301 到尾斜杠;SPA 客户端路由默认回落 index.html)

## 安全注意

- 公开站点**无鉴权、只读**:任何能访问该域名的人都能读到 `dist` 里的所有文件。
- **不要把密钥、token、.env、隐私数据放进 `dist`**;`dist` 之外的文件(源码、
  隐藏文件、`node_modules`、符号链接)不会被服务,也不会被读取。
- 改完产物记得重新构建/覆盖 `dist` 后让用户硬刷新。
