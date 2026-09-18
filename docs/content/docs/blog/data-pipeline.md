---
title: 《数据的复杂采集、脱敏、归一与向量化》
description: crawler 仓库里真正在跑的四件事：一次一条源的调度、complete=false 的完整性语义、按 SHA-256 寻址的原件归档，以及一条手工的 WeKnora 注入命令。OCR 工人、Pi 清洗与检索链路仍是设计。
---

# 《数据的复杂采集、脱敏、归一与向量化》

![TJUClaw 数据链路目标架构（第 06、07 段尚未实现）](./images/data-pipeline-architecture.webp)

上面这张图是目标形态，不是现状。图里第 06 段（检索）和第 07 段的一部分没有对应代码，第 04 段里的 PaddleOCR-VL 与 DeepSeek 也没有。下面每一节都会说清哪些能在仓库里指到具体文件，哪些只是 `CONTEXT.md` 里已定但未实现的设计。

能在 `crawler/`（Bun + 独立 PostgreSQL）里跑起来的，只有四件事：

1. 一次只爬一个已配置的源，把发现结果写进 PostgreSQL；
2. 对条目正文与附件做规则脱敏，命中的东西在落库前就被替换或隔离；
3. 把附件按 SHA-256 归档进对象存储，并给每个条目生成一份派生 Markdown；
4. `bun run weknora:inject` 把派生 Markdown 手工推进一个 WeKnora 知识库。

分块、向量化、重排、引用回链都不在这里。这条链路上已实现的部分是：

```text
config/sources.example.json（44 个源）
   ↓  一次一个源；租约 300s，丢租约即 abort
items + events（PostgreSQL，游标单调递增）
   ↓  规则脱敏：凭据/身份证整条隔离，学号名册脱敏
附件 → SHA-256 CAS（对象存储）      正文 → processed_documents（派生 Markdown）
                                          ↓  bun run weknora:inject（手工执行）
                                     WeKnora（单一知识库，v0.8.0+）
                                          ↓
                                     ？检索入口尚未实现
```

| 环节 | 现状 | 位置 |
| --- | --- | --- |
| 采集与调度 | 在跑 | `src/index.ts`、`src/ingest/runner.ts` |
| 完整性对账与墓碑 | 在跑 | `src/store.ts` `completeCrawl` |
| 事件游标与 Replay | 在跑 | `/sources/:source/changes` |
| 规则脱敏与隔离 | 在跑 | `src/archive/pii.ts`、`runner.ts` `processDiscovered` |
| 附件归档 CAS | 代码在，需要 S3 凭据；未配置时启动日志打 `archive: not_configured` | `src/archive/mirror.ts` |
| 派生 Markdown | 在跑 | `src/processed.ts` |
| WeKnora 注入 | 手工命令，不在调度循环里 | `src/cli.ts` |
| OCR 工人（PaddleOCR-VL） | 设计 | 仓库无 OCR 代码 |
| Pi 清洗派生正文 | 设计 | 同上 |
| 检索（hybrid + rerank） | 未实现 | `cli/` 只有 `course` 子命令 |

---

## 1. 一次一条源

调度循环在 `src/index.ts`：

```ts
const scheduler = (async () => {
  while (!abort.signal.aborted && sources.length) {
    let nextWake = Date.now()+30000;
    for (const config of sources) {
      if (abort.signal.aborted) break;
      const [status] = await store.getCrawlStatus(config.id);
      const lastSuccess = status?.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
      const lastFailure = status?.lastFailureAt ? Date.parse(status.lastFailureAt) : 0;
      const retryMs = Math.min(config.intervalSeconds*1000, 60000*2**Math.min(status?.failureCount ?? 0, 6));
      const due = Math.max(lastSuccess ? lastSuccess+config.intervalSeconds*1000 : 0,
        (status?.failureCount ?? 0)>0 ? lastFailure+retryMs : 0);
      if (due <= Date.now()) {
        const result = await runtime.runner.runSingle(config,abort.signal);
        console.log(JSON.stringify({event:"crawl",source:config.id,status:result.status,items:result.itemsCount,error:result.errorCode}));
      } else nextWake = Math.min(nextWake,due);
    }
    await delay(Math.max(1000,nextWake-Date.now()),undefined,{signal:abort.signal}).catch(()=>{});
  }
})().catch(() => { /* scheduler_failed */ });
```

三点值得注意。到期判断是「上次成功 + 周期」和「上次失败 + 退避」取较大值，退避上限是周期本身，指数最多翻到 $2^6$。重启不清空历史：`lastSuccessAt` / `lastFailureAt` / `failureCount` 都在数据库里。循环里没有任何并发，`await runtime.runner.runSingle` 一句把整轮占住。

示例配置 `config/sources.example.json` 里有 44 个源，37 个是 `website`，其余是 2 个 `lostfound` 和 course/wiki/wepeiyang/yellowpage/studyroom 各 1 个。全部 `intervalSeconds` 只有三档：3600（青年湖底、失物招领）、21600（北洋维基）、86400（课程目录与各学院站）。

单次请求的边界在 `src/ingest/http.ts`：

- 逐 host 串行队列，同 host 两次请求之间至少 750 ms（`CRAWLER_MIN_DELAY_MS` 可调，上限 60000）；
- 响应体上限 4 MiB，超时 15 s，失败重试 2 次；
- 正式抓取前查 `robots.txt`（缓存 1 小时，上限 512 KiB），命中 Disallowed 直接抛 `ROBOTS_DISALLOWED`；
- 重定向手动处理，最多 5 跳，每跳重新解析并校验地址；私网、回环、metadata 地址被拒绝。

一次运行还持有一份租约：`beginCrawl` 默认 300 秒，每 30 秒续租一次，续租失败就把请求全部 abort。过期 worker 无法提交结果，`completeCrawl` 里还会用 `current_run_id` 再核一次（`crawl_lease_lost`）。

**进程内一次只爬一个源，所以“提高并发”不是在同一个 Compose 里再开一个源。** `CONTEXT.md`（2026-09-18）记录的做法是把公开课目录 `public-course-sharing` 挪到 managed-region 集群：独立 PostgreSQL、直连 OneDrive、写同一只 对象存储 桶，配 `CRAWLER_ARCHIVE_CONCURRENCY=16`、`CRAWLER_MIN_DELAY_MS=0`；校园源留在北京主机，保持默认串行。当前状态是 SG 的 Pod 在跑，附件归档与列举并行，CN 校园源未动，采集租约仍挂在 `public-course-sharing` 上，没有宣称采集已经完成。

---

## 2. `complete = false` 才是默认值

动态栏目最难处理的不是漏抓，而是把「这次只抓到一部分」当成「远端只剩这些」。

代码里只有一处能产生墓碑，条件是这一轮确实是完整快照：

```ts
await this.store.completeCrawl(
  source, runId, processedEntries,
  snapshot.complete && !snapshot.notModified
);
```

`completeSnapshot` 为真时，`completeCrawl` 会把本轮没出现、但在库里仍然活动的条目批量写成 delete 事件；为假时一个都不删。`notModified` 单独排除，因为一个 304 永远不能当作「远端为空」的证据。

提供方那里的默认值反过来：

| 来源类型 | `complete` |
| --- | --- |
| `wiki` | 只有完整遍历成功才为真 |
| `rss` | 恒为假（注释原文：rolling windows） |
| `website` / `sitemap` | 恒为假 |
| `wepeiyang` 论坛 | 恒为假，不因帖子缺失产生删除事件 |
| `course` | 目录树复用缓存时为假，完整列举时为真 |
| 黄页 / 失物招领 / 自习室 | 命中 304 或分页中断时为假 |

下游增量消费不看上游分页，而看我们自己的事件流。`events` 的主键是 `(source, cursor)`，`sources.last_cursor` 单调递增，只有真正写入事件时才步进；内容哈希没变就不追加事件。读取接口是：

```text
GET /sources/:source/changes?after=0&limit=50
→ { events: [...], next_cursor, has_more }
```

`limit` 上限 100，`after` 必须是非负安全整数，未知来源 404。事件目前不做裁剪，保留给下游幂等重放。

上游的分页 token 不是我们的游标。`README.md` 里对这一条写得很直接：当前已验证的接口契约没有游标参数，不虚构 cursor。

---

## 3. 原件按内容寻址，派生物另存

PostgreSQL 放结构化事实（`sources`、`items`、`events`、`processed_documents`、`archive_*` 元数据），几十兆的附件进对象存储。对象键由 SHA-256 决定：

```text
<prefix>/<source>/raw/<sha[0:2]>/<sha[2:4]>/<sha256>.<ext>
<prefix>/<source>/derived/<sha256>/<name>
```

默认前缀 `archive/sources`。键里带了 `<source>`，所以去重只发生在同一个源内部：同一份字节在同一个源下永远是同一个键，重复抓取不会多存一份。跨源不会合并，同一份培养方案被三个学院站转载，会以三个不同的键各存一份字节；能看出「这是同一份内容」的地方是元数据账本，因为 `archive_assets` 的主键是 `sha256`。三份的对象也各自占配额。

上传完不会直接记账为已归档，而是回读一次 HEAD，核对 `ContentLength`、metadata 里的 `sha256` 和 `archive-version=v1`，对不上抛 `archive_object_verification_failed`。单次 `PutObject` 与分片上传的分界线是 8 MiB（分片大小同样 8 MiB）。容量有三档数字：单文件默认上限 16 MiB（同一个值也用作下载上限），整个前缀 35 GiB 是软阈值，只让 `getQuotaStatus` 打出 `isSoftWarning`；45 GiB 才是硬阈值，超了直接拒绝写入（`archive_quota_exceeded`），而且这条判断和配额预留在同一个事务里，并发归档不会各自以为还有空间。

有一处刻意的设计：旧对象不因为新版本出现就物理删除。`mirror.ts` 的 `tombstoneItem` 注释写着，删除只标记在数据库与元数据里，对象留在桶里，为的是历史 run 的引用不会断。

隔离资料根本走不到上传：`processAsset` 返回 `quarantined_pii` 时，`mirror.ts` 只在本地记下 sha256、字节数、MIME 和原因，然后 `continue`，注释是「DO NOT upload sensitive or quarantined bytes to COS or feed」。也就是说，隔离对象的原文既不进桶、也不进 Feed，库里只留一条「曾经见过这个哈希」的记录。

---

## 4. 不要相信 `.pdf`

课程资源里两种 URL 都很常见：`/download?file_id=1028` 这种没有扩展名的，和 `lecture.pdf` 这种返回 HTML 错误页的。所以类型判定三层一起看：

```text
文件扩展名 → HTTP Content-Type → Magic Number
```

魔数表在 `src/archive/magic.ts`，签名都是硬编码的字节序列：

```ts
{ description: "PDF Document",   matches: (b) => matchAscii(b, 0, "%PDF-") },
{ description: "PNG Image",      matches: (b) => matchBytes(b, 0, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) },
{ description: "JPEG Image",     matches: (b) => matchBytes(b, 0, [0xff,0xd8,0xff]) },
{ description: "WebP Image",     matches: (b) => matchAscii(b, 0, "RIFF") && matchAscii(b, 8, "WEBP") },
{ description: "ZIP Archive / Office XML", matches: (b) => matchBytes(b, 0, [0x50,0x4b,0x03,0x04]) }
```

音视频是另一条规则：扩展名、MIME、魔数任一命中就整条拒掉，状态记 `rejected_media`，不下载、不归档。PDF 还必须通过魔数这一关，否则哪怕服务器说是 `application/pdf`，也直接抛 `invalid_pdf_signature`。

这套检查不聪明，但比扩展名和 Content-Type 都可靠，而这两样恰好是常年出错的地方。

---

## 5. 脱敏：规则部分在跑，模型部分没有

`src/archive/pii.ts` 是一个纯正则加校验和的模块，`scanForPii` 返回命中的类别，不做替换；替换与隔离由调用方按类别决定。

| 规则 | 阈值 | 命中后的动作 |
| --- | --- | --- |
| 私钥 / Bearer / GitHub、Stripe、AWS 令牌 / `password=`、`密码:` | 单次命中 | 条目标题替换为「隔离资料」，正文不保留 |
| 中国大陆身份证 | 1 个且校验位通过（GB 11643-1999，mod 11-2） | 同上 |
| 学号名册 | 10 位学号出现 ≥5 个 | 学号与紧邻姓名被替换，附件清空，公告正文保留 |
| 手机号 | 出现 ≥3 个 | 只记录，不触发隔离 |

最后一行的原因是黄页：公开办公电话是刻意要检索的数据，`README.md` 写明「公开办公电话不再因数量触发隔离」。失物招领走的是另一条路——`campus-providers.ts` 在发现阶段就把 `phone`、`qq`、`wechat`、`name`、`card_name`、`card_number` 这些字段的值从描述里逐个替换成 `[已脱敏]`，图片 URL 里含这些值的直接排除，不让它进归档。

隔离不是「打码」。条目正文被整条替换成：

```json
{ "title": "隔离资料", "content": "内容需要人工审核，未公开正文或附件。" }
```

附件级的判断在 `process.ts`：PDF 抽出的文本层、以及纯文本附件，只有命中「非 phone 类别」才判 `quarantined_pii`。原文不进对象存储、不进 Feed，也不会成为派生 Markdown，因为它连 `items` 正文都没留下。

两处代价要说清楚。

一是误报。`password:` 出现在讲义示例里，整份讲义就会被隔离。这是个选择：对公开知识库来说，隔离一份课件比放进一组真实凭据便宜。

二是这一层只覆盖规则能表达的东西。「张三」和下一行的 `zhangsan@example.edu.cn` 属于同一个人，正则不会知道。`CONTEXT.md`（2026-09-17）把「姓名与联系方式共现时遮盖」划给采集 PII 门之后的模型环节，并规定 OCR 产出进模型前要再扫一遍。没有代码，所以就到这里为止。

---

## 6. Markdown 是派生物

`processed_documents` 里的每份 Markdown 由 `renderProcessedMarkdown` 生成，结构固定：

```markdown
# 标题

> 路径：<source> > <标题>

- 来源：`<source>`
- 原文：[<link>](<link>)
- 发布时间：<pubDate>

（正文，或按 kind 套用的 JSON 模板）

## 附件
- [文件名](<publicBase>/<object key>)

## 图片
![附件图片 1](<publicBase>/<object key>)
```

黄页、失物招领、自习室这三类接口数据不是文章，`renderJson` 用各自的模板把字段摊成列表，而不是把原始 JSON 丢给检索。附件摘录每个上限 20 万字符、合计上限 1048576 字符。图片与附件链接只在配置了 `CRAWLER_ARCHIVE_PUBLIC_BASE`（必须是 https、且不带用户名密码）时才写，没配就只有文字。条目里嵌的 manifest 只含对象键、sha256、大小与 MIME，不含任何临时下载 URL。

隔离条目在这里被直接删掉，`syncProcessedTx` 走的是 `DELETE FROM processed_documents`。

这一段没做的事比做了的事更值得说：

- 没有 Office 转换。`process.ts` 的注释写明 pptx/docx/zip 目前没有文本管线，只保留原始字节，「不编造抽取文本」。所以图中的「PPT / DOC / DOCX → PDF → 同一条路」是设计。
- 没有 OCR。扫描版 PDF 走的是同一条 PDF 分支：`pdftotext` 抽不出文本时 `extractedText` 为空，附件最后只有原件和最多 3 页 WebP 预览（`pdftoppm -scale-to 1200`，质量 75）。图里的 PaddleOCR-VL 1.6 没有对应代码。
- 没有模型修复。「按对象哈希投递到 `/workspace/inputs/`、回收 `/workspace/outputs/`」这套隔离执行是 `CONTEXT.md` 的设计，仓库里没有。

附件处理里最费事的一段是图片：Python + Pillow 缩到 2048 以内、质量 80，`Image.MAX_IMAGE_PIXELS = 16000000`，并把 `DecompressionBombWarning` 升级成异常，避免一张超大图把进程拖死；小于 32 KiB 的图如果 WebP 反而更大，就保留原图不生成派生物。

---

## 7. 注入 WeKnora 是一条手工命令

派生 Markdown 不会自动进知识库。要跑：

```bash
bun run weknora:inject --source college-cs --limit 50
```

`WEKNORA_API_KEY` 与 `WEKNORA_KNOWLEDGE_BASE_ID` 缺任何一个都抛 `weknora_not_configured`，不会假装注入过。请求是 `POST /api/v1/knowledge-bases/<id>/knowledge/manual`（新建，`status=published`，`channel=tjuclaw_crawler`）或 `PUT /api/v1/knowledge/manual/<knowledgeId>`（更新），Key 走 `X-API-Key`，`redirect: "error"`，30 秒超时。每批 10 条、每条之间 200 ms，按 `(source, item_id)` 记下的 `content_hash` 去重；某一条失败就 `break`，不去重试到底。

发过去的只有 Markdown 文本。图片字节留在对象存储，Markdown 里写的是对象地址，不把图片再上传给 WeKnora，也不写 data URI。

进的是同一个知识库 ID，不按学院拆库。来源差异靠 Markdown 头部的 `source`、原文链接和发布时间，将来是 metadata 过滤。`CONTEXT.md` 里的判断是：用户的问题不按组织架构出现，「转专业以后培养方案里的高数怎么认定」会同时涉及学院通知、教务规定和培养方案，提前把知识拆散只会在召回时再拼回来。

WeKnora 的边界写在 `ops/weknora/README.md`，几条都是硬规则：它不是产品身份、不是浏览器应用、不是资料库 ACL；私有资料库授权留在 Go API；公开采集用 crawler 自己的 PostgreSQL；本地只绑回环（UI 18180、app 18181），生产走 SSH 隧道而不是公网源站；镜像钉 `v0.8.0+`，不启用 Docker 沙箱。它整套约 1.4 GiB 内存上限，明确不能和身份、NewAPI、采集、API 挤在同一台 2 GiB 主机上。

---

## 8. 检索链路还没有接通

图里那条用户可见的命令是：

```bash
tjucli knowledge search "软件工程培养方案"
```

它现在不存在。`cli/cmd/tjucli/main.go` 注册的子命令只有 `course ls`、`course search`、`course download`，`cli/TJUCLI.md` 里也没有 knowledge 相关的动词。后端同样没有 WeKnora 路由，`backend/README.md` 列出的库相关路径是 `/libraries`、`/entries`、`/sessions`、`/account/model`。

所以「用户问题 → π → tjucli → API → WeKnora hybrid → rerank → JSON 信封」整条是设计。要接通至少缺三件事：

1. CLI 与 API 上的检索入口，以及它返回稳定信封的定义；
2. Key 的保管与限额（`CONTEXT.md` 写明由 Go 配置并保管，浏览器不直连）；
3. 结果里带回 `content_hash` / `asset_sha256` 的字段，否则引用无处可落。

`CONTEXT.md` 对此的要求也很直白：首个管理员、知识库和 Key 要在 WeKnora UI 里创建之后才算接通，未创建 Key 不得宣称 Agent 已能检索。健康检查通过不等于检索可用。

混合检索的理由和实现状态无关：`微积分 A(1)` 和 `微积分 B(1)` 这类课程名，纯向量召回并不可靠，BM25 与向量两路并用再由重排器收敛是更稳的做法。这是 WeKnora 侧的能力，不是 crawler 的。

---

## 9. 引用最终指向哈希

今天能确定的只有存储侧：

```text
items.content_hash = SHA-256(JSON.stringify([title, link, content, pubDate]))
archive_assets.sha256 = SHA-256(附件原始字节)
```

前者随正文或附件 manifest 变化而变化，后者是字节的恒等式；CAS 里的旧对象不因新版本出现而被删。这两条加在一起，已经足够支撑「搜索看最新、引用看当时」这种双版本语义。

但引用本身还没有地方落。没有检索链路，就没有保存 `content_hash` 的消费方，也没有「打开当时那一版」的界面。这是设计里最靠后的一段，也只是设计。

---

## 10. 还没做的，以及一次撤回

按依赖顺序，目前缺口是：

1. OCR 工人。设计上它独立于采集进程，只消费对象存储地址，不和 2 GiB 核心主机、WeKnora 挤在一起；产出 Markdown 草稿后仍要过 PII 门。
2. Pi 清洗。只负责格式统一，不覆盖原始条目，也不做语义重写。
3. `github` 适配器。正文几乎为空、只剩 GitHub 链接的条目单独处理，只拉 README 一类文本，不 clone 整仓、不下二进制，也没有代码。
4. 资料中的潜在链接补全。
5. Office 文本、扫描件文本。
6. WeKnora 注入进调度、检索入口与引用回链。

有一次明确的撤回：微信来源被删掉了。`config.ts` 现在遇到 `wechat` 字段会直接抛 `Unknown wechat configuration field`，而不是静默忽略；`wepeiyang-news` 这个旧新闻适配器保留在代码里，但已从默认示例源移除，`README.md` 为它专门标注了一句「它不是青年湖底论坛来源」。

最后是验收口径。`crawler/README.md` 要求分别记录：真实来源首轮采集、无变化重采集、RSS XML、Replay 全分页、应用与数据库重启后的事件一致性、备份恢复、资源占用、真实对象存储上传与读回。文档同时写明「配置存在或镜像构建成功都不能替代生产验证」，而这份清单现在仍是清单。

现在这套东西能稳定做到的，是把一个公开校园来源变成两样东西：一份按内容寻址、可复核的原件，和一份带来源与时间的 Markdown；并且隔离规则在写库之前就已经生效。从原件往下走的每一步（OCR、清洗、分块、检索、引用）都还是手工的，或者还没有。
