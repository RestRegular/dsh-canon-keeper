# dsh-canon-keeper

口径守护：把项目里那些会被反复引用的关键事实登记成**带语义版本的编号条目**，用**带版本的标记**钉进文档；口径一改，就能机械列出所有引用位置，逐处核验。

> 解决的问题：一份文档库里，「超时默认 8 秒」这类事实散落在十几处。某天决定改成 5 秒，你改了正文，但没人知道还有哪 12 处写着 8 秒 —— 直到用户踩到。

## 它怎么工作

```
.dsh/canon-keeper/entries/D-001.json   权威数据：一条口径一个文件
        ↓
文档里：所有对外网关调用的超时默认 8 秒。<!-- canon:D-001@r3 -->
        ↓
canon_check  →  哪些标记钉的是旧版本（STALE）
                哪些标记没钉版本（UNPINNED，算未验证）
                哪些地方提到却漏了标记（UNMARKED_MENTION）
                哪些旧说法又冒出来了（RESURRECTED）
```

关键设计是**标记自带版本号**。所以「某处是否已跟上口径」这件事，只看文档本身就能判断，不需要维护一份「谁确认过」的旁挂状态 —— 那份状态一旦丢失或不同步，就会把未核验的地方伪装成已核验。<!-- canon:D-001@r1 -->

## 安装

```bash
dsh plugin install @restregular/dsh-canon-keeper
```

装好后 Agent 会多出 7 个工具，也可以在项目里直接用 CLI：

```bash
npx dsh-canon-keeper check      # 全库体检，退出码 0 干净 / 1 有 error / 2 只有 warn
npx dsh-canon-keeper list
npx dsh-canon-keeper get D-001
npx dsh-canon-keeper stats
```

## 上手三步

**1. 登记一条口径**

对 Agent 说「把这条口径登记下来」，或直接调 `canon_add`：

```json
{
  "kind": "decision",
  "statement": "所有对外网关调用的超时默认 8 秒。",
  "aliases": ["网关超时", "超时默认"]
}
```

返回新 id、可直接粘贴的标记文本，以及**文档里已经提到它却没有标记的位置**。

**2. 把标记写进文档**

按文件类型选样式：

| 文件类型 | 标记 |
|---|---|
| Markdown / HTML | `<!-- canon:D-001@r1 -->` |
| MDX | `{/* canon:D-001@r1 */}` |
| reStructuredText | `.. canon:D-001@r1` |
| AsciiDoc | `// canon:D-001@r1` |
| 纯文本 | `[[canon:D-001@r1]]` |

标记放在它所约束的那一段里（独占一行时归属其后第一个非空段落）。围栏代码块和行内代码里的标记不算引用，所以文档里讲语法示例是安全的。

**3. 口径变了**

`canon_update` 改事实（`change: "semantic"`）会让 `rev` +1，并返回所有受影响位置。逐处处理：要么改文并把标记改成新版本，要么确认无影响后用 `canon_resolve` 记一笔 —— 每处都要写 `note`。

只改措辞用 `change: "wording"`，`rev` 不变，不会让全库变待处理。

## 两个容易做错的地方

**「没钉版本」不等于「已跟上」。** 省略 `@rN` 的标记会被算作**未验证**：不计入覆盖率，`canon_check` 一直报 `UNPINNED`，退出码为 2。`--fix-pins` 只补 `rev == 1` 的（唯一版本，无歧义）；`rev > 1` 的必须由人对照当前正文确认后手动改，工具不猜。<!-- canon:R-001@r1 -->

**核验是验证，不是盖章。** `canon_resolve` 会核对文档现状：标记必须已钉到当前版本；记 `updated` 要求该段落文字确实变过；记 `confirmed` 必须说明理由。对不上就拒绝 —— 批量盖章让机制失去意义。<!-- canon:R-002@r1 -->

## 撞号与合并冲突

同一条口径被两个分支各自登记，会产生两种问题，都要人来定，工具只提供原语：

```bash
# 同 id 不同事实 → 把其中一侧的标记改指向改号后的条目
npx dsh-canon-keeper repoint D-001 D-007 --paths docs/a.md,docs/b.md          # 预览
npx dsh-canon-keeper repoint D-001 D-007 --paths docs/a.md,docs/b.md --apply  # 写入
```

`repoint` 默认只预览，且**不钉版本** —— 目标条目的 `rev` 和来源无关，钉个数字就是猜；`--paths` 必须显式给，工具不猜范围。<!-- canon:R-004@r2 -->

`.dsh/canon-keeper/audit.jsonl` 必须配 `.gitattributes` 的 `merge=union`，否则两分支各追加必冲突。解冲突时 `take ours` 会丢掉一边的条目文件，让「同 id 两个文件」这条检测失效 —— 所以每条 `add` 事件都带 `fingerprint`（id + 归一化正文的指纹），`canon_check` 发现同一 id 有两条不同指纹的登记就报 `ID_COLLISION`。

## 命令与退出码

| 命令 | 作用 |
|---|---|
| `check [--force] [--fix-pins] [--json]` | 全库体检 |
| `list [--kind] [--status] [--query] [--json]` | 列条目 |
| `get <ID> [--json]` | 单条详情 + 引用位置 |
| `stats [--json]` | 覆盖率 / 盖章率等指标 |
| `repoint <from> <to> --paths … [--apply]` | 改标记指向 |
| `resolve <ID> --file … --outcome … --note …` | 核验一处 |
| `ignore <ID> --file … --alias …` | 压制某处「提到却没标记」 |

退出码：`0` 干净 / `1` 有 error / `2` 只有 warn（含未验证的 `UNPINNED`）。

## 13 条规则

**error（阻断）**：`DANGLING` 标记指向不存在的口径 · `DUPLICATE_ID` 同 id 多个文件 · `ID_COLLISION` 同 id 不同事实 · `STORE_UNREADABLE` 条目文件损坏

**warn（要处理）**：`STALE` 钉的版本落后 · `UNPINNED` 没钉版本 · `RESURRECTED` 废弃说法复活 · `SUPERSEDED_REF` 指向已归档 · `DRIFT` 段落变了归属不明 · `BAD_MARKER` 版本号不可解析

**info（提示）**：`TEXT_CHANGED` 已对齐但段落变了 · `UNMARKED_MENTION` 提到却没标记 · `ORPHAN` 没有任何引用

历史类文档（`docs/handover/**`、`CHANGELOG.md`，或 front matter 里 `canon_historical: true`）的 warn 一律降级为 info。

## 存储与容错

```
.dsh/canon-keeper/
  entries/<ID>.json   权威数据，纳入 git
  audit.jsonl         追加式审计，纳入 git（配 merge=union）
  index.json          派生索引，可删，已 gitignore
  .lock               跨进程写锁
```

- **旧库自动迁移**：从旧版升级后，若工作区根还留着 `canon/` 而新目录 `.dsh/canon-keeper/` 为空，插件会在首次使用时把旧 `entries/*.json` 与 `audit.jsonl` **复制**到新目录，旧目录原样保留作备份。只在使用默认 `storeDir`、目标空库、旧库非空三重条件下触发；重复初始化幂等，不覆盖用户已写进新库的数据。自定义 `storeDir` 一律不动。
- **坏档拒绝写入**：任何条目文件解析失败 → 所有写操作报 `STORE_UNREADABLE`。绝不「从空库起」——那会让全部标记变 `DANGLING`，且 id 会被复用。<!-- canon:R-003@r1 -->
- **索引坏了就重建**：派生数据，删掉即可。
- **跨进程锁**：`.dsh/canon-keeper/.lock` 用 `open(wx)` 抢占，超 `lockTimeoutMs` 视为残留锁接管。多会话 + CLI 同时写不会丢更新。
- **只读扫描**：扫描永远不改文档。补钉是显式命令。

## 它刻意不做什么

- **不塞口径正文**：不会把口径内容灌进每一轮对话。
- **不强制**：不会在轮末检查 Agent 有没有写标记。
- **不拦截**：不拦 `write` / `edit`。
- **不做语义检测**：只用确定性文本规则，不调用模型判断「这两句话是否矛盾」。

前三条会制造「看起来在守护、实际随时静默失效」的假象；第四条做不到可复现。真正起作用的是：标记写进文档之后，它就是一个可机械检查的锚点。

### 但它会告诉你这套机制存在

工具描述只有在**被调用之后**才进入模型视野。Agent 不知道有这套东西，就不会去调 —— 没有触发点，描述写得再全也是死代码。所以插件做两件最小的事：

1. **常驻系统提示**（`injectPrompt`，默认开）：一段约 450 字的说明，讲「有这个机制、什么时候用、完整用法去哪看」。**只讲机制，不含任何口径正文** —— 把口径内容每轮灌进上下文，等于把未核验的状态洗成已核验。
2. **随包技能** `canon-keeper`（`bundledSkill`，默认开）：完整标记语法、七个工具的取舍、核验口径、常见误用。按需加载，不占常驻 context；随包发，所以和代码同版本。

两段都是增强：宿主没有对应服务、或注册失败时只记一行日志，工具与面板照常可用。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `storeDir` | `.dsh/canon-keeper` | 口径库目录 |
| `markerStyles` | 见上表 | 扩展名 → 样式（JSON） |
| `includeExtensions` | `md,markdown,mdx,txt,rst,adoc` | 参与扫描 |
| `ignoreGlobs` | `node_modules,.git,dist,build,out,…` | 排除 |
| `historicalGlobs` | `docs/handover/**,**/CHANGELOG.md` | 历史类，告警降级 |
| `mentionMinLength` | `2,4` | 「提到却没标记」的最短长度（中文 / 拉丁） |
| `learnDeprecated` | `true` | 语义改动时自动累积废弃说法 |
| `maxFiles` / `maxFileBytes` | `2000` / `524288` | 扫描上限 |
| `lockTimeoutMs` | `30000` | 锁过期时间 |
| `injectPrompt` | `true` | 系统提示里常驻一段用法说明 |
| `bundledSkill` | `true` | 注册随包技能 `canon-keeper` |

## 开发

```bash
npm run test:lib    # 纯逻辑，不依赖宿主（23 项）
npm run test:host   # 宿主装配 + 工具链路（17 项）
npm test            # 全部（含 client 的 6 项）
```

`test/stub-tools.mjs` **复刻宿主的参数 DSL 校验**，不是万能放行。0.2.0 曾因此在宿主里静默失效：`canon_resolve` 在数组 `items` 里写了 `required: [...]`，真实 `defineTool` 抛 `JsonSchemaError`，被 `try/catch` 吞成一行 warn —— 七个工具一个都没注册，界面上看不出任何异常。离线测试必须能复现宿主的拒绝，否则它只是在给自己发绿灯。

`test/client.mjs` 用**迷你 React 运行时**（真跑 hooks、真触发重渲染、真执行 effect）把 `client.js` 装进假 `window.__ModuleLoader__` 里渲染。0.3.0 的「打不开预览：右侧栏服务还没就绪」漏在这里：组件从 `props.ctx` 取上下文，而**宿主的槽位组件 props 里根本没有 `ctx`** —— 宿主组合的是 `OwnerOf & KeyPropsOf & SlotInjectFace & ScopeStandardProps`（只有 `sessionId` 之类）再加 locale / store。所以那不是时序问题，是永远失败，而且错误文案把排查引向了「服务没就绪」这个错误方向。

两个教训：

1. **槽位组件拿不到 `ctx`。** 需要在 `apply(ctx)` 时把上下文存到模块作用域，组件按模块变量取用；或者用 `inject:` 声明服务、靠 slot 的 `inject` 面把能力传进 props。不要指望 `props.ctx`。
2. **只摊平元素树的测试测不到行为。** 假 React 若把 hooks 退化成「每次渲染都重置」，异步加载的列表永远渲染成骨架屏，点了也没反应 —— 测试会以「没有可点元素」的形式误报，看起来像断言写错了。必须让 hooks 有持久状态、`setState` 触发重渲染、effect 跑完后再放几轮宏任务等 promise 落地。

设计文档见 [docs/design.md](docs/design.md)，实现细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## License

MIT
