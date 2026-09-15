# Git 与版本规范

## 工作流

GitHub 为唯一开发主平台，GitLab 为比赛镜像。组件先在各自仓库提交、推送并通过检查，
再在集成仓库暂存对应 submodule 指针并运行组合回归。禁止同时启用反向镜像。

长期分支规划：`release` 为生产分支与直接快速迭代分支，通过 CI 后自动触发部署；`dev` 保留为集成验证分支，不予删除。
只保留这两个长期分支，日常直接在 `release` 开发进行快速迭代，不强制版本标签；提交信息格式与版本号规范保持不变。
生产环境仅允许 `release` 部署，检查通过后自动运行；本地脚本不能代替服务端规则。

多人或多 Agent 协作先明确文件归属；独立工作优先使用分支与 worktree。
不要修改他人的未完成文件，不使用全量 `git add .` 或 `git add -A`。
逐路径暂存，检查暂存差异，再提交。禁止擅自改写共享历史、强推、跳过 hooks。
建议合并请求使用 squash，最终提交标题同样遵守下述格式。

## 提交格式

```text
EMOJI [vMAJOR.MINOR.PATCH] type(scope): summary
```

scope 可省略；建议使用 `wiki`、`frontend`、`backend`、`ops`、`repo`。
不兼容变更在 type 或 scope 后加 `!`，正文说明迁移与影响。
第一行不超过 100 个 Unicode 码点；中文或英文描述均可。

| 类型 | 必须使用的 emoji | 用途 |
| --- | --- | --- |
| feat | ✨ | 新功能 |
| fix | 🐛 | 修复 |
| docs | 📝 | 文档 |
| refactor | ♻️ | 重构 |
| perf | ⚡ | 性能 |
| test | ✅ | 测试 |
| chore | 🔧 | 仓库维护 |
| ci | 👷 | 持续集成 |
| build | 🚀 | 构建与发布 |
| revert | ⏪ | 回退 |

```text
🔧 [v0.0.25] chore(repo): establish repository conventions
✨ [v0.0.25] feat(frontend): add task history
🐛 [v0.0.25] fix(backend): reject invalid workspace identifiers
```

普通提交、回退和手动 merge 提交均不豁免。自动生成的 merge/revert 标题应重写；
不使用未整理的 fixup!/squash! 标题提交。不得在标题或正文泄露私人情报与凭据。

## 版本号

每个独立仓库以自己的根 `package.json` 的 `version` 为唯一版本来源，拆分基线为 `0.0.25`。
这是仓库基线，不代表已经发布或承诺产品功能完成，不建立重复的 VERSION 文件。
集成仓库锁定组件 SHA，各组件可以独立演进。Tauri 读取客户端仓库 package.json；
Rust crate 的 0.0.0 仅为内部元数据，不作为客户端安装包版本。

采用 SemVer 的主 / 次 / 修订版本结构：

- `0.x` 为开发阶段；本项目约定新增能力或不兼容变更提升 MINOR，修复和维护发布提升 PATCH。
- `1.0.0` 在产品验收与对外兼容边界明确后由维护者决定。
- `1.x` 以后，不兼容变更提升 MAJOR，兼容功能提升 MINOR，兼容修复提升 PATCH。
- 预发布只使用 `-alpha.N`、`-beta.N`、`-rc.N`，N 为非负整数，不允许前导零。
- 不使用 build metadata；构建标识单独记录 Git SHA，不混入仓库版本。

提交中的版本必须等于**暂存区** package.json 的版本，而不是未暂存的工作区版本。
同一待发布版本允许多次提交，不要求每次改文档都涨版本。
版本提升需明确修改并暂存 package.json；不能只改提交标题。

## 发布流程

1. 维护者确定发布版本并更新 package.json，同一个提交记录变更说明和验证结果。
2. 执行检查、审阅实际交付物，确认没有未授权的情报、凭据或本地状态。
3. 合并发布提交后，在该提交上创建带注释的 `v<version>` 标签，标签版本与 package.json 一致。
4. 已发布版本不可复用或移动标签。发布后第一次继续开发时将版本提升至下一目标版本。

创建提交不等于发布；创建标签和推送都必须有明确授权。
当前 hooks 验证标题、暂存版本和受限路径，不验证远端标签、版本递增或发布状态；
发布流程仍需维护者核实。

## 本地检查

```bash
rtk pnpm git:setup
rtk pnpm test:git
rtk pnpm git:check
rtk git diff --cached --stat
rtk git diff --cached
```

git:setup 只设置当前仓库的 hooksPath，不改全局配置，遇到已有其他 hooksPath 会拒绝覆盖。
新克隆或新机器要重新安装。hooks 不自动暂存、不改文件内容、不自动提交。
本项目 Git 检查不需要额外 npm 依赖，仅使用 Node 标准库与 Git。
提交前还应按改动运行 lint、类型检查、测试和构建；不把昂贵构建绑到每次提交。

## 保密

`research/`、`private/`、本地情报文档、`*.private.*`、本地环境文件和密钥不进入 Git。
历史架构、演示计划、情报章节和 UI 参考已归档到本地 `private/wiki-archive/`。
原始素材包、采集脚本、本地模拟器、语料、采集运行时状态、实际容器规划及本地数据库也不进入 Git。
文档站迁入 `docs/` 后仍遵循同样边界；Android 签名密钥、Windows 签名证书、
本机 SDK 路径与生成的 Gradle 项目也不得进入 Git。
如需发布其中内容，先逐项审查与脱敏，再调整规则。
环境示例 `.env.example` 或 `.env.<name>.example` 可以提交，但只能包含无效示例值。
hooks 检查整个 Git 索引中的受限路径，防止通过强制添加绕开常规 ignore。

路径检查不是内容秘密扫描，不能发现任意源码或普通 Markdown 中的密钥；
hooks 可以被绕过，也不会移除历史泄露。发现已泄露凭据先轮换，再处理仓库历史。
Git 排除不能阻止文件被本地 Wiki、静态服务器、构建产物或容器镜像公开。

集成、服务端、CLI 与 GitLab 比赛镜像保持 Private；客户端已获授权公开。
禁止未经授权扩大其他仓库的可见性、启用 Pages、
邀请成员或发布带有内部材料的制品。推送只同步经过审查的提交，不同步本地私有归档。

参考：[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)、
[Git hooks](https://git-scm.com/docs/githooks)。
