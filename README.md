# 随阅（Reading Randomizer）

一款 macOS 优先的本地桌面阅读器：从自选网站中轮换文章，提取干净正文，支持划词翻译，并把真正读完的文章沉淀到可搜索的知识库。

## 主要能力

- 从 Chrome 书签或手动添加的网站建立阅读来源库。
- 通过 RSS、站点地图、网页发现和受控浏览器回退寻找文章。
- 在带内容清洗的阅读模式中阅读，字号和版心设置会本地保存。
- 完成有效阅读后，将文章原文、阅读进度和元数据保存到本地 SQLite 知识库。
- 可选使用 Groq 生成中文主旨、要点、分类和标签。
- 可选启用远程划词翻译；默认关闭，启用前会显示数据去向说明。
- 提供站点健康、缓存使用、运行错误和提取质量诊断。

## 本地运行

需要 macOS 和 Node.js 22.12 或更新版本。

```bash
npm install
npm run dev
```

验证改动：

```bash
npm run verify
npm audit
```

查看本机运行健康报告：

```bash
npm run health:runtime
```

## 打包

生成未签名的 macOS `.app` 目录：

```bash
npm run pack:mac
```

生成 DMG 和 ZIP：

```bash
npm run dist:mac
```

公开分发前仍需配置 Apple Developer ID 签名与 notarization。仓库中的 `build-macos.yml` 可手动生成未签名测试包；`ci.yml` 会在每次提交和拉取请求中执行 smoke check、回归测试和依赖审计。

## 数据与隐私

阅读记录、文章缓存、来源配置、翻译缓存、运行诊断和知识库都保存在 Electron 的 `userData` 目录，不会提交到 Git。Groq 密钥使用 macOS 安全存储加密后再落盘；也可以只通过 `GROQ_API_KEY` 环境变量提供。

只有在用户主动配置或启用相应功能时，文章内容或选中文本才会发送给第三方服务。完整说明见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 架构边界

```text
Renderer（本地 CSP 页面）
  -> sandboxed preload / readerApi
  -> 带来源校验和参数校验的 IPC
  -> ArticlePrefetcher / ArticlePipeline
  -> RequestGovernor / BrowserExtractionController
  -> HTML sanitizer
  -> JSON stores / SQLite knowledge database
```

网络请求、隐藏浏览器生命周期、文章内容渲染和本地持久化都有单独边界。维护与发布细节见 [docs/RELEASE_HARDENING_HANDOFF.md](docs/RELEASE_HARDENING_HANDOFF.md)。

## Chrome 书签

应用只会在用户点击导入时读取 Chrome 的 `Bookmarks` JSON；不会修改或持续监控书签。导入后，来源列表作为应用自己的本地数据维护。
