# dsh-canon-keeper 实现方案 v0.3（已批准，M1 已实现）

> 立项口径（记忆 0df06e5f）：把项目里反复出现的关键事实（决策、规则、数值、术语）登记成有编号的「口径」，
> 让文档中每一处相关表述都通过标记挂到口径上，口径变更时能**机械地**列出所有受影响位置并要求逐处处理。
>
> v0.1 已批准形态：Agent 工具 + 右侧边栏面板。
> v0.2 按首轮评审重做数据模型与状态机。v0.3 按第二轮评审修掉补钉、撞号与合并三处漏洞。

## 0. 变更历史

### v0.1 → v0.2

| # | v0.1 | v0.2 | 原因 |
|---|---|---|---|
| 1 | 引用状态存 canon.json（`ordinal` + `ackRev`） | **版本钉进标记**，状态随文档走 | 插入/删除标记导致 ordinal 错位；大 JSON 合并冲突 |
| 2 | 只校验已标记位置 | 增 `UNMARKED_MENTION` / `RESURRECTED` | 藏起来的表述恰恰没有标记 |
| 3 | 依赖手动 scan | check/get 内置增量重扫；update 直接回影响清单 | 忘了扫 = 在口径工具里制造过期数据 |
| 4 | `rev` 每次 +1 | 语义改动升 rev；措辞修订只记历史 | 改错别字让全库变待处理 = 噪音 |
| 5 | `updated` 无验证、resolve 单条 | 重钉 + 段落哈希双验证；resolve 批量 | 防止批量盖章 |
| 6 | 单文件 + `nextSeq` | **每条一个文件** + 追加式审计 + 派生索引 | 多分支撞 id 要显式暴露 |
| 7 | 进程内互斥 | 乐观并发 + 跨进程文件锁 | 多会话/多进程丢更新 |
| 8 | 坏档改名后从空库起 | **拒绝写入并报错**，等人恢复 | 空库 → 全 DANGLING → id 复用 |
| 9 | `{{canon:ID}}` | 按扩展名的注释形式，带 `@rN` | MDX/Jinja/Helm 会把 `{{}}` 当表达式求值 |
| 10 | 9 个工具 | 7 个 | 省上下文，impact/get、scan/check 重叠 |
| 11 | 回环 HTTP 无鉴权 | token 头 + Origin/Host 校验 | CSRF / DNS rebinding |
| 12 | M1 → M2 面板 | M1 → **试跑一周看三个数** → M2 | 先验证机制成立 |
| 13 | 扫描自动补钉 | 扫描只读，补钉显式触发 | 扫描不再是纯函数 |

### v0.2 → v0.3

| # | v0.2 | v0.3 | 原因 |
|---|---|---|---|
| 14 | `--fix-pins` 补所有 UNPINNED | **只补 `rev == 1`**；`rev > 1` 必须走 `canon_resolve` 核验 | 缺版本号 = 不知道作者对照的是哪一版，自动补钉会把过期表述洗成「已跟上」 |
| 15 | UNPINNED 只是普通 warn | UNPINNED 按**未验证**计入统计与退出码，不算覆盖率 | 否则漏写版本号就成了绕过检查的办法 |
| 16 | `autoPin` 配置项 | **删除** | 留着只会被人打开 |
| 17 | 撞号只报 `DUPLICATE_ID` | 增 `ID_COLLISION`（审计指纹）+ `canon repoint` 原语 | `take ours` 解冲突后只剩一个文件，`DUPLICATE_ID` 不触发 |
| 18 | 无去重提示 | `canon_list` 加 `query`；`canon_add` 返回相似条目 | 多会话下同一事实重复登记比撞 id 更常见 |

### v0.3 → 实现期修正

方案批准后写 M1 的过程中，自测发现三处会让机制静默失效的实现级问题。均不改变 v0.3 的任何对外语义，只修正实现。

| # | 原设想 | 实际做法 | 原因 |
|---|---|---|---|
| 19 | 基线按「条目 + 文件」存单个 `paragraphHash` | 存 **哈希集合** `paragraphHashes[]` | 同一文档可能多处引用同一口径，单值会被后一处覆盖，前一处改文被误判成「没变」 |
| 20 | `rescan()` 顺手把新段落哈希写进基线 | **只给没有基线的引用建基线**，已存在的基线绝不在此更新 | 否则每次扫描都把「段落变了」悄悄认成「没变」，`TEXT_CHANGED` 与 `TEXT_UNCHANGED` 同时失效 —— 正是「把未核验洗成已核验」那类 bug。基线只在 `canon_resolve` 通过时更新 |
| 21 | 增量缓存键 = `mtime + size` | 键追加 **口径集合指纹** | `refs` 只依赖文件内容，但 `mentions` / `resurrected` 依赖 aliases 与 deprecatedPhrases。新登记一条口径后，老文件里本就有、当时没人在意的提法应当立刻变成 `UNMARKED_MENTION`；只看 mtime 会把这些命中整片漏掉，而漏掉的恰是最该被发现的表述 |

附带两处实现细节：

- `resolve` 原来只处理每个「条目 + 文件」的**第一处**引用，同文档多处引用会漏记。改为逐处核验，并支持用 `line` 精确指定其中一处；部分成功时返回 `ok: false` 与已记账的 `done` 列表。
- 局部重扫（`resolve` 用 `onlyFiles`）原来会把索引裁成只剩被触及的文件，导致缓存整片丢失。改为把未触及的文件原样并入结果。
- `CanonStore.reload()` 解析前剥掉 UTF-8 BOM。Windows 上 PowerShell `Set-Content -Encoding UTF8`、记事本另存写出的 JSON 带 BOM，`JSON.parse` 直接抛错，内容其实完好 —— 不该被当成坏档拒绝写入。

## 1. 一句话

口径 = 有编号、有语义版本、被文档标记钉住的事实条目。标记自带版本，所以「某处是否已跟上口径」
只看文档本身；口径一改，所有钉在旧版本的标记自动变成 STALE，直到有人逐处重新钉住。

## 2. 设计原则

1. **状态在文档里**，不在 sidecar 里 —— 可 diff、可 review、可回滚。
2. **权威数据分文件**，派生数据可重建 —— 索引随时删掉，不影响正确性。
3. **不靠模型判断** —— 所有规则是确定性文本比对。
4. **写操作必须可验证** —— 声称改过就要能证明段落确实变了。
5. **不替人猜** —— 版本号、id 归属、冲突取舍一律不自动决定。
6. **失败要显式** —— 坏档、冲突、撞号一律报错，绝不静默降级。

## 3. 存储布局

默认 `storeDir` = `<工作区>/canon`（**git 跟踪**，多工作树/克隆之间靠 git 同步）：

```
canon/
  entries/
    D-001.json          # 一条口径一个文件，权威数据
    R-002.json
  audit.jsonl           # 追加式审计（跟踪），只 append
  index.json            # 派生缓存（gitignore），可随时重建
```

`.gitignore` 片段（写进 README，安装时提示）：

```
canon/index.json
canon/.lock
```

`.gitattributes` 片段（**必须**，写进 README）：

```
canon/audit.jsonl merge=union
```

`audit.jsonl` 是纯 append 的 JSONL，两个分支各自在末尾追加是常态；不设 `merge=union` 则每次合并必冲突。

### 3.1 条目文件 `entries/D-001.json`

```jsonc
{
  "id": "D-001",                    // 类型前缀 + 3 位序号
  "kind": "decision",               // decision | rule | value | term | fact
  "title": "主线时间以 UTC 存储",
  "statement": "所有时间戳一律以 UTC 落库，展示层才做时区转换。",
  "aliases": ["时间戳一律", "UTC 落库"],        // 用于 UNMARKED_MENTION 的定位词
  "deprecatedPhrases": [                        // 语义改动时自动累积
    { "text": "本地时间落库", "retiredAtRev": 3 }
  ],
  "tags": ["time", "storage"],
  "rev": 3,                         // 仅语义改动 +1；标记钉的就是它
  "supersededBy": null,             // 被哪条取代；非空即视为归档
  "createdAt": 1795560000000,
  "updatedAt": 1795560000000,
  "history": [                      // 追加式，seq 单调，与 rev 解耦
    { "seq": 1, "rev": 1, "change": "semantic", "at": 0,
      "actor": { "kind": "agent", "name": "lead", "sessionId": "session-e216be51-…" },
      "note": "初始登记", "statement": "…", "aliases": ["…"] },
    { "seq": 2, "rev": 1, "change": "wording", "at": 0,
      "actor": { "kind": "user" }, "note": "改错别字", "statement": "…" },
    { "seq": 3, "rev": 2, "change": "semantic", "at": 0,
      "actor": { "kind": "agent", "name": "lead", "sessionId": "…" },
      "note": "改成本地时间", "statement": "…", "aliases": ["…"] }
  ]
}
```

- `rev`：**语义版本**，只有语义改动才 +1。标记钉它。
- `history[].seq`：**日志序号**，任何改动（含措辞）都 +1。两者解耦，避免措辞修订污染引用状态。
- `actor`：记具体身份。`kind: agent` 带 `name` + `sessionId`；`kind: user`；`kind: cli` 带 `pid`/`host`。

### 3.2 审计 `audit.jsonl`（跟踪，只追加）

```jsonc
{"at":1795560000000,"op":"add","entryId":"D-001","fingerprint":"a3f9c2e1",
 "actor":{"kind":"agent","name":"lead","sessionId":"…"},"note":"初始登记"}
{"at":1795560000000,"op":"resolve","entryId":"D-001","file":"docs/arch.md",
 "fromRev":2,"toRev":3,"outcome":"updated","verified":true,
 "actor":{"kind":"agent","name":"lead","sessionId":"…"},"note":"改成 UTC 表述"}
```

- `op`：`add | update | resolve | archive | repoint | ignore-mention`
- `verified`：`true` = 哈希比对通过；`false` = 仅声明（无基线时）
- **`add` 事件必须带 `fingerprint`**：`id` + `statement` 归一化后的 sha1 前 8 位。
  这是 `ID_COLLISION` 的唯一依据，见 §3.5。
- 只 append，冲突面最小；也是试跑指标的取数来源。

### 3.3 索引 `index.json`（派生，可删）

```jsonc
{
  "version": 1,
  "scan": { "at": 0, "files": 123, "markers": 45, "durationMs": 800, "complete": true },
  "refs": [
    { "entryId": "D-001", "file": "docs/arch.md", "line": 42, "pinRev": 2,
      "paragraphHash": "9f2c1a3b", "style": "html", "historical": false }
  ],
  "baselines": { "D-001|docs/arch.md": { "rev": 2, "paragraphHash": "9f2c1a3b" } },
  "stats": { "coverage": 0.0, "verifiedRatio": 0.0, "unmarkedHits": 0, "unpinned": 0 }
}
```

- `refs` 每次扫描全量重建；`baselines` 在 rev 抬升那一刻记录当时的段落哈希，用于 resolve 验证。
- 索引不存在 / 损坏 → 直接重建，不报错（派生数据）。

### 3.4 id 分配

- 扫描 `entries/` 里同前缀文件名，取 `max(seq) + 1`，写文件用 `open(..., 'wx')`（已存在则重试下一个序号）。
- **不维护 `nextSeq` 计数文件** —— 否则又多一个合并冲突点。
- 两个分支各自登记同一序号 → 合并后可能出问题，两种情况分开处理，见 §3.5。

### 3.5 撞号与重复登记

先分清两种情况，它们**不是**同一件事：

| | 现象 | 本质 | 处理 |
|---|---|---|---|
| **A. 真撞号** | 同 id、**不同事实** | 一侧必须改号 | 人决定哪边改号 → 改文件名 → `canon repoint` 该侧文档 |
| **B. 重复登记** | 不同 id、**同一事实** | 一条该被取代 | `canon_archive({ supersededBy })` + `canon repoint` 旧 id → 新 id |

两者共用同一个原语：

```
canon repoint <from> <to> --paths <文件…> [--apply]    # 默认 dry-run
```

- 默认只打印将要改动的 `文件:行` 与前后对照，`--apply` 才真写。
- **repoint 不猜版本**：`canon:D-001@r3` → `canon:R-002`（去掉 `@rN`，留下 `UNPINNED`）。
  目标条目的 rev 与来源无关，钉一个数字就是猜；留下 UNPINNED 由 `canon_resolve` 核验，与 §4.4 同一原则。
- A 的完整流程：`git diff --name-only <merge-base>..<side>` 得到该侧改过的文件 →
  `canon repoint D-001 D-004 --paths <那些文件> --apply`。范围由人给，工具不自动判断归属。

#### `DUPLICATE_ID` 兜不住的情况，以及 `ID_COLLISION`

「分文件让冲突显式暴露」只在两边新增**同名文件**、git 报 add/add 冲突时成立。
若有人解冲突时直接 take ours / take theirs，就只剩一个条目文件 —— 另一边的标记悄悄指向了错的事实，
`DUPLICATE_ID` 不会触发（只有一个文件）。

补救：

- `audit.jsonl` 的 `add` 事件记 `fingerprint`（id + statement 指纹），见 §3.2。
- `canon_check` 扫审计：同一 id 出现**两条指纹不同**的 `add` 事件 → `ID_COLLISION`（**error**）。
- 报错时列出两条 `add` 的时间、actor、statement 摘要，由人决定保留哪条、另一条改号后 `repoint`。
- `merge=union` 保证两个分支的 `add` 事件都留在审计里 —— 这正是能发现它的前提。

## 4. 标记语法

### 4.1 按扩展名的注释形式（默认）

| 扩展名 | 写法 | 说明 |
|---|---|---|
| `.md` `.markdown` `.html` | `<!-- canon:D-001@r3 -->` | 渲染不可见，源文本可读 |
| `.mdx` | `{/* canon:D-001@r3 */}` | 避开 MDX 的 `{}` 表达式 |
| `.rst` | `.. canon:D-001@r3` | rst 注释 |
| `.adoc` | `// canon:D-001@r3` | asciidoc 行注释 |
| `.txt` | `[[canon:D-001@r3]]` | 无注释语法的兜底 |

`markerStyles` 可配：`{ ".md": "html", ".mdx": "mdx", ".rst": "rst", ".adoc": "adoc", ".txt": "plain" }`。
样式只影响**生成**标记文本；**识别**对所有已知样式都生效（避免混用漏检）。

### 4.2 版本钉

- `@r3` = 该位置最后一次确认/改写时，口径的 `rev`。
- `@r3` 与当前 `rev` 相等 → 已跟上；小于 → `STALE`。
- 无 `@rN` 的标记 → `UNPINNED`，**按「未验证」处理**，不算「已跟上」（见 §5.1）。
- 版本号只认正整数；`@r3x`、`@r0` 之类 → `BAD_MARKER`。

### 4.3 扫描边界（哪些文字不算）

1. 跳过围栏代码块（```` ``` ```` / `~~~`，按开闭围栏长度配对）与行内代码（反引号配对）。
2. 跳过行内代码与代码块之外，其余全文参与扫描，**包括 YAML front matter**；front matter 里的
   `canon_historical: true` 只影响该文件的告警级别，不改变标记识别。
3. 讲标记语法本身的示例（如本文件的表格）由规则 1 覆盖；仍可能被误识的示例文本，
   用 `ignoreGlobs` 排除整个文件（默认已排除 `docs/design.md`）。

### 4.4 补钉：写标记的人负责，工具不替人猜版本

补钉等于声明「这处已和当前 rev 对齐」。而缺 `@rN` 的标记，我们**不知道作者当初对照的是哪一版**：
口径已到 r3，某个 Agent 从旧文档抄了一段连标记一起贴过来、丢了版本号，
工具若直接钉成 r3，就把一处过期表述洗成了「已跟上」—— 正是整套机制要防的事。

因此：

- **正常路径**：`canon_add` 与 `canon_get` 返回的都是**已钉好版本**的标记文本，粘贴即合法，不产生 UNPINNED。
- **`UNPINNED` 按未验证处理**：不算覆盖率、不算「已跟上」，计入 `canon stats` 的 `unpinned` 计数，
  并让 `canon check` 的退出码体现（warn 级）。漏写版本号不能成为绕过检查的办法。
- **`--fix-pins` 只处理无歧义的情况**：条目 `rev == 1` 时只有一个版本可钉，自动补。
  `rev > 1` 的 UNPINNED **不自动补**，走 `canon_resolve` 逐处核验：Agent 对照当前 `statement`
  看过之后，自己把标记改成 `@rN`，再调 resolve 记账。
- **扫描永远只读**，不写任何文档。
- **不提供 `autoPin` 配置项** —— 留着只会被人打开。

## 5. 状态机与可验证的 resolve

### 5.1 状态由标记自己表达

| 文档里 | 含义 | 是否算「已跟上」 |
|---|---|---|
| 无标记，但命中 alias | `UNMARKED_MENTION` | 否 |
| 无 `@rN` | `UNPINNED`（未验证） | **否** |
| `@rN` == 当前 rev，段落哈希未变 | 已跟上 | 是 |
| `@rN` == 当前 rev，段落哈希变了 | `TEXT_CHANGED`：是口径该改，还是这处该回退？ | 是（但需人判断） |
| `@rN` < 当前 rev | `STALE` | 否 |
| 命中 `deprecatedPhrases` | `RESURRECTED` | 否 |

**没有 `todo` 状态**：一处不想现在处理，就让它继续 STALE（规则表会一直盯着它），
备注写进 `audit.jsonl`，不会出现无人跟踪的第四态。

### 5.2 resolve 是「验证」而不是「盖章」

流程：Agent 先改文档（改文 + 把 `@r2` 改成 `@r3`），再调 `canon_resolve` 批量核验。

```
canon_resolve({ items: [
  { entryId: "D-001", file: "docs/arch.md", note: "改成 UTC 表述" },
  { entryId: "R-002", file: "docs/errors.md", note: "核对无冲突" }
]})
```

逐项重扫该文件，找该条目的标记，判定：

| 文档现状 | 结果 |
|---|---|
| 标记 pin == 当前 rev，段落哈希 ≠ baseline | `updated`（verified） |
| 标记 pin == 当前 rev，段落哈希 == baseline | `confirmed`（verified）—— **必须带 note**，否则拒绝 |
| 标记仍无 `@rN` | 拒绝：`MARKER_NOT_REPINNED`，附当前写法与应改成什么 |
| 标记 pin < 当前 rev | 拒绝：`MARKER_NOT_REPINNED` |
| 标记已不存在 | `MARKER_MISSING`（该条目别处仍有引用则仅提示） |
| 无 baseline（索引被删过） | 按传入的 `outcome` 记录，`verified:false` |

批量返回逐项结果；任一项被拒 → 整体 `ok:false`，其余项仍写入审计，并列出未通过项。
`confirmed` 无 note → 整批拒绝（防批量盖章）。

### 5.3 段落哈希

- 段落 = 连续非空行块；标记独占一行时，归属其后的第一个非空块。
- 归一化：去标记本身 → 折叠空白 → 拉丁小写 → 保留 CJK → 取 sha1 前 8 位。
- 比 ±60 字窗口稳：邻近段落编辑不再触发。

## 6. 规则表

| 代码 | 级别 | 含义 | 历史文件 |
|---|---|---|---|
| `DANGLING` | error | 标记指向不存在的 id | error |
| `DUPLICATE_ID` | error | 同 id 出现在多个条目文件 | error |
| `ID_COLLISION` | error | 审计里同 id 有两条指纹不同的 `add` | error |
| `STORE_UNREADABLE` | error | 条目文件无法解析 → 拒绝一切写入 | error |
| `STALE` | warn | 标记 pin < 当前 rev | info |
| `UNPINNED` | warn | 标记缺 `@rN`（未验证） | info |
| `RESURRECTED` | warn | 出现已废弃说法 | info |
| `SUPERSEDED_REF` | warn | 标记指向 `supersededBy` 非空的条目 | info |
| `DRIFT` | warn | 标记所在段落哈希变了但 pin 未变，且无法判定归属 | info |
| `TEXT_CHANGED` | info | pin == rev 但段落变了 | info |
| `BAD_MARKER` | warn | 标记语法存在但版本号不可解析 | info |
| `UNMARKED_MENTION` | info | alias 命中但该段落无对应标记 | info |
| `ORPHAN` | info | 条目没有任何引用 | info |

**历史文件**（`historicalGlobs`，默认 `docs/handover/**`、`**/CHANGELOG.md`、`**/ADR-*/superseded/**`）
或 front matter 带 `canon_historical: true` 的文件：所有告警降为 info，只列出、不催办。

### 6.1 UNMARKED_MENTION 的降噪

- alias 最短长度：CJK ≥ 2 字，拉丁 ≥ 4 字符（`mentionMinLength` 可调）。
- 只报「该段落里没有该条目的标记」的命中，同一文件同一 alias 最多报 3 处。
- `canon_add` / `canon_update` 返回直接附命中位置（文件:行 + 上下文），Agent 当场选补标或忽略。
- 忽略 = 往 `audit.jsonl` 记 `op:"ignore-mention"`，同一 alias+file 不再重复报（可撤销）。

### 6.2 RESURRECTED 的产生

`canon_update({ change: "semantic" })` 时做 diff：

- 旧 `aliases` 中被移除的 → 进 `deprecatedPhrases`，记 `retiredAtRev`。
- 旧 `statement` 中消失、且长度达标的专有短语 → 一并登记（`learnDeprecated: true` 时启用）。
- 也可手动 `canon_update({ addDeprecated: ["…"] })`。

## 7. Agent 工具（7 个）

**标记约定只写在 `canon_add` 和 `canon_update` 的 description 里**，其余工具各用一行说明，省上下文。

| 工具 | 参数要点 | 返回 |
|---|---|---|
| `canon_list` | `kind? tag? status? query?` | 条目摘要 + 各状态计数；`query` 做标题/statement/alias 子串与相似度匹配，用于查重 |
| `canon_get` | `id` 或 `ids[]` | 正文、`rev`、历史、**受影响位置（snippet + pin + 规则）**、已钉好的标记文本 |
| `canon_add` | `kind title statement aliases? tags?` | 分配 id、`rev:1`、**已钉标记文本**、**相似已有条目（可能是重复登记）**、即时 alias 命中位置 |
| `canon_update` | `id change:"semantic"\|"wording" statement? title? aliases? tags? note` | `rev` 变化、**影响清单（每处 snippet + 新旧 statement 对照）**、新增 `deprecatedPhrases` |
| `canon_archive` | `id supersededBy? note` | 归档（不删文件，`supersededBy` 生效），并提示用 `repoint` 把旧标记改指向 |
| `canon_resolve` | `items[]`（entryId/file/note/outcome?） | 逐项 verified / 拒绝原因 |
| `canon_check` | `pinNew? globs?` | **先增量重扫**，再出全库健康报告（按规则分组） |

- `canon_get` 吸收 impact；`canon_check` 吸收 scan。**没有独立 scan / impact 工具**。
- 所有工具 `output.schema = {type:'string'}`，文本渲染；结构化数据只走面板 API / CLI `--json`。
- `canon_add` 的「相似条目」用 statement + title + aliases 的 trigram 相似度，阈值以上才列（最多 3 条），
  只提示不阻止 —— 重复登记的正确收尾是 `canon_archive({supersededBy})` + `repoint`（§3.5 B）。

`canon_add` 与 `canon_update` 的 description：

```
写文档时若某句在陈述已登记的口径，必须在句末（或该段前）加标记 <!-- canon:<ID>@r<rev> -->；
rev 用本工具返回的文本，不要自己写数字。口径改了要用 canon_update(change:"semantic")，它会列出所有需处理的位置。
```

### 7.1 给 AGENTS.md 的片段（随包发布，README 里可直接粘）

```md
## 口径（canon）

本仓库的关键事实登记在 `canon/entries/`，每条有 id 与语义版本 `rev`。
陈述这些事实的句子后面必须加标记：`<!-- canon:D-001@r3 -->`（MDX 用 `{/* canon:D-001@r3 */}`）。

- 新增事实：先 `canon_list({query})` 查重，再 `canon_add` → 把返回的标记贴进文档。
- 修改事实：`canon_update({change:"semantic"})` → 按返回的影响清单逐处改文并重新钉版本。
- 只改错别字：`canon_update({change:"wording"})`，不影响引用。
- 提交前：`npx dsh-canon-keeper check`，退出码非 0 不要提交。
```

## 8. 薄 CLI（`bin/canon-keeper.mjs`）

ops 本来就是共用实现，CLI 只是第三个调用方：

```
canon check [--json] [--fix-pins]     # 增量重扫 + 全库报告；--fix-pins 只补 rev==1 的 UNPINNED
canon list [--kind K] [--stale] [--query Q]
canon get <id> [--json]
canon repoint <from> <to> --paths <文件…> [--apply]   # 默认 dry-run
canon stats                           # 试跑三个指标 + unpinned 计数
```

退出码：

| 码 | 含义 |
|---|---|
| `0` | 干净 |
| `1` | 有 error：`DANGLING` / `DUPLICATE_ID` / `ID_COLLISION` / `STORE_UNREADABLE` |
| `2` | 仅 warn：`STALE` / `UNPINNED` / `RESURRECTED` / `SUPERSEDED_REF` / `DRIFT` / `BAD_MARKER` |

可直接接 pre-commit、CI、`lefthook`；不经过 Agent 也能用。

## 9. 面板（M2，右侧边栏标签页）

- `sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })` → 「开始」页自动出入口卡。
- 槽位 `sidebar.right.pane.tab` + `.title`（同 key）。整文件 IIFE，`__ModuleLoader__.load`。
- 只做「列表 ↔ 详情」两态（栏宽 ~360px）：

```
┌ 口径  [检查] [重扫] ┐
│ 待处理 3  未验证 2  │
│ ▸ D-001 时间 UTC ⚠  │  ← 行内显示 rev 与状态
│ …                   │
└─────────────────────┘
详情：正文(可编辑) / 标记文本(可复制) / 受影响位置(snippet + 三态按钮) / 修订历史(seq + actor)
```

- 三态按钮 = 「已改文」`updated`、「核对无影响」`confirmed`（强制填备注）、「暂不处理」（留 STALE + 审计备注）。
- UNPINNED 位置单独一组「未验证」，`rev > 1` 时不给「一键补钉」，只能逐处核验。
- 只用 `--dsw-alias-*` token。

### 9.1 本地 HTTP 鉴权

- 前缀 `/dsh-canon-keeper/api`。
- **写接口**（POST/PUT/DELETE）必须同时满足：
  1. `Origin` 与 `Host` 一致且等于 `webServer.getOrigin()`；
  2. 头 `x-canon-token` 等于本进程随机 token；
  3. 连接来自回环。
- token 通过 `webServer.tapIndex` 注入 `<meta name="canon-keeper-token" content="…">`，客户端读取后带上。
- 读接口只校验 Origin/Host + 回环，不要求 token（面板首屏快）。
- 任何一条不满足 → 403 + 明确原因（不泄漏 token）。

## 10. 配置（每个节点带 meta）

| 字段 | 默认 | 说明 |
|---|---|---|
| `storeDir` | `canon` | 工作区相对路径，默认纳入 git |
| `markerStyles` | 见 §4.1 | 扩展名 → 样式，影响生成 |
| `includeExtensions` | `md,markdown,mdx,txt,rst,adoc` | 参与扫描 |
| `ignoreGlobs` | `node_modules/**,.git/**,dist/**,docs/design.md` | 排除 |
| `historicalGlobs` | `docs/handover/**,**/CHANGELOG.md` | 历史类，告警降级 |
| `mentionMinLength` | `{cjk:2,latin:4}` | UNMARKED_MENTION 降噪 |
| `learnDeprecated` | `true` | 语义改动时自动累积废弃说法 |
| `maxFiles` / `maxFileBytes` | `2000` / `524288` | 扫描上限 |
| `lockTimeoutMs` | `30000` | 跨进程锁的过期时间 |

（`autoPin` 已删除，见 §4.4。）

## 11. 并发与容错

| 场景 | 做法 |
|---|---|
| 同进程并发 | 每个条目文件读时拿 `contentHash`，写前校验；不符 → `CONFLICT`，重读重试 1 次 |
| 跨进程（多会话 / CLI） | `canon/.lock` 用 `open(wx)` 抢锁，含 pid + 时间戳；超 `lockTimeoutMs` 视为残留锁并接管；写操作全程持锁 |
| 写文件 | 同目录临时文件 → `rename` 原子替换；只碰目标文件 |
| 条目文件损坏 | **拒绝一切写入**，报 `STORE_UNREADABLE` + 路径 + 建议（从 git 恢复 / 手工修）。不自动重置、不自动重编号 |
| 索引损坏 | 删掉重建，无副作用 |
| `audit.jsonl` 写失败 | 不阻断主操作，但返回里带 `auditWarning`（审计是证据，不该假装写成功） |

## 12. 里程碑与试跑指标

- **M1（本次实现）**：store（分文件 + 锁 + 乐观并发）/ scan（跳过代码块、段落哈希、增量）/ 规则引擎 /
  7 个工具 / CLI（含 `repoint`）/ `test/smoke.mjs`。纯 Node 可测，不依赖宿主。
- **M1.5（试跑一周，先不做面板）**：用真实文档库跑，看三个数：
  1. **标记覆盖率** = 已跟上段落 / (已跟上 + STALE + UNPINNED + UNMARKED_MENTION)；
  2. **盖章率** = `confirmed` / (`confirmed + updated`)（`audit.jsonl` 统计）；
  3. **遗漏命中数** = `UNMARKED_MENTION` 条数及其被补标比例。
  覆盖率过低 → Agent 不写标记（改工具描述/AGENTS.md）；盖章率过高 → 机制在走过场；遗漏居高 → alias 质量差。
- **M2**：面板（含鉴权）。
- **M3**：打包（package.json / cordis.patch.yml / docs/DETAIL.md / preview.svg）→
  `plugin_manager.install_bundle`（绝对路径）→ `cordis_inspect_query(Slots)` 确认 occupant →
  浏览器实操面板 → `npm publish`（devcred + 临时 npmrc）→ GitHub 推送。

## 13. 本轮不做

- 运行时自动注入口径**内容**、轮末强制检查、拦截 write/edit。
- 基于模型的语义冲突检测 —— 只做确定性文本规则。
- 跨仓库口径同步、图形化关系图、`merge-ids` 自动合并（`repoint` 是原语，取舍永远由人做）。

### 13.1 补充（M2 之后）：注入触发点，但不注入内容

M1.5 的覆盖率实测暴露了一个设计缺陷：**工具描述只有在被调用之后才进入模型视野**。Agent 不知道有这套机制，就不会去调 —— 没有触发点，描述写得再全也是死代码。这与「不注入内容」是两件事，之前混为一谈了。

现在补两段，都不违反上面的红线：

| 手段 | 注入什么 | 什么时候进 context |
|---|---|---|
| `ctx.systemPrompt.section()`（`injectPrompt`） | 约 450 字：有这个机制、什么时候用、细节去哪看 | 每轮，常驻 |
| 随包技能 `skills/canon-keeper/SKILL.md`（`bundledSkill`） | 完整标记语法、七工具分工、核验口径、常见误用 | 按需加载 |

- **仍然不注入口径正文**。把条目内容灌进上下文，等于把未核验的状态洗成已核验 —— 这是原设计要防的核心问题，不因为加了触发点而放宽。
- 常驻段落用**函数形式** `text: () => …`，每轮 pre-step 重新求值，配置开关改了下一次生效；关掉时返回空串而不是不挂段落，避免换开关留下孤儿段落。
- 随包技能注册成 **provider + `resourceBase`**（不是 runtime skill）：技能以后要带 `references/` 资源，只有 provider 形式能让模型解析相对路径。rank 用 600，与宿主 `BUNDLED_SKILL_RANK` 对齐，项目 / 用户技能可以同名覆盖。
- 两段都只记日志、不抛错：宿主缺服务时工具与面板照常可用。

## 14. 风险表

| 风险 | 影响 | 对策 |
|---|---|---|
| Agent 不写标记 | 机制整体失效 | 常驻系统提示 + 随包技能给触发点；工具描述 + AGENTS.md + `canon_add` 直接给可粘标记；M1.5 覆盖率度量 |
| 工具注册失败但无人察觉 | 七个工具全消失，界面无异常 | 失败走 `logger.error` 带栈；`test/stub-tools.mjs` 复刻宿主参数 DSL 校验，离线测试即可复现宿主的拒绝 |
| 漏写版本号被当已跟上 | 过期表述洗白 | UNPINNED 计为未验证，不算覆盖率，退出码体现；`--fix-pins` 只补 rev==1 |
| take ours 解冲突 | 标记静默指向错事实 | 审计 `add` 指纹 + `ID_COLLISION` + `merge=union` |
| 重复登记 | 同一事实多条 | `canon_list({query})` + `canon_add` 返回相似条目 + archive/repoint |
| alias 选得差 | 遗漏检测噪声大 | 最短长度 + 每文件每 alias 上限 + 忽略记忆 |
| 段落哈希误判 | 分类错 | 无 baseline 时降级为「声明」并标 `verified:false` |
| 大仓扫描慢 | 面板卡 | 扩展名白名单 + 文件数/体积上限 + mtime 增量 |
| 锁残留 | 写操作被阻塞 | pid + 时间戳 + 超时接管 |
| MDX 里标记写法错 | 文档构建失败 | 按扩展名预设样式；`BAD_MARKER` 早报 |
| 回环写接口被网页滥用 | 数据被改 | token + Origin/Host + 回环三重校验 |

## 15. 拍板记录

| 点 | 结论 |
|---|---|
| §7 工具数量 | **7 个**，`canon_archive` 独立（参数与 `canon_update` 互斥，合并后 schema 变多态易填错） |
| §3.4 id 撞车 | 不自动改号；提供 `canon repoint` 原语（dry-run 默认），取舍由人 |
| §4.4 补钉 | **写标记的人负责**；UNPINNED 按未验证处理；`--fix-pins` 只补 `rev == 1`；扫描只读；删掉 `autoPin` |
| 工具描述 | 标记约定只写在 `canon_add` / `canon_update`，其余一行说明 |
| 去重 | `canon_list` 加 `query`；`canon_add` 返回相似已有条目 |
