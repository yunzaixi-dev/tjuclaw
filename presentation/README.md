# TJUClaw 演示文稿

十页中文 Slidev 开发阶段演示稿，包含演讲者备注。源码在 `slides.md`，
浅色样式在 `style.css`。当前内容区分公开接口实测、实现中的命令和计划中的
产品执行链路；正式汇报前根据真实验收结果更新状态页。

本目录使用独立的 `pnpm-workspace.yaml` 和锁文件，不加入根工作区。
以下命令均在 `presentation/` 目录执行，使用 pnpm 11.3.0：

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm run dev
```

预览地址为 `http://127.0.0.1:3030/`，演讲者视图为
`http://127.0.0.1:3030/presenter/`。服务绑定本机回环地址。

## 构建与导出

```bash
rtk pnpm run build
```

静态页面生成到本目录的 `dist/`。产物已被根 Git 忽略规则排除。

PDF 导出依赖项目内的 `playwright-chromium`。安装依赖时不会自动下载浏览器；
首次导出前按需安装匹配版本的 Chromium：

```bash
rtk pnpm exec playwright install chromium
rtk pnpm run export
```

默认 PDF 输出到 `../test-results/presentation/tjuclaw-draft.pdf`，同样不进入 Git。
也可以指定本机已有兼容 Chromium 的路径：

```bash
rtk pnpm run export --executable-path /absolute/path/to/chrome
```

## 汇报前检查

- 验证实际 CLI 命令，保留真实结果，替换仍处于接口契约阶段的示例页。
- 核对第九页状态；配置通过不等于远端流水线成功。
- 区分公开平台接口检查、CLI 调用和完整 Pi 自动任务三种证据。
- 检查 PDF 中的中文、图表、代码换行和页面边界。
- 不把私有研究、身份凭据或内部基础设施地址加入演示资源。
