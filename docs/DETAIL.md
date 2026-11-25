# dsh-canon-keeper 实现细节

面向要改这个插件的人。设计意图与取舍见 [design.md](design.md)，这里讲代码怎么落地、为什么这么写、改哪里会踩雷。

## 目录

```
index.js              宿主入口：Config 描述符 + 7 个工具注册
client.js             （M2）侧边栏面板，本版未实现
lib/util.js           纯函数：哈希、归一化、glob、相似度
lib/marker.js         标记的识别与生成
lib/scan.js           工作区扫描、段落哈希、增量缓存
lib/rules.js          13 条规则 + 指标
lib/store.js          分文件条目 + 锁 + 审计 + 派生索引
lib/ops.js            共用操作层（工具 / CLI / 面板的唯一入口）
lib/tools.js          7 个 Agent 工具定义
bin/canon-keeper.mjs  CLI 薄壳
test/smoke.mjs        纯逻辑测试（35 项）
test/host.mjs         宿主装配测试（10 项）
```

分层是一条硬线：**`lib/ops.js` 之上的任何东西都只做参数校验与文本渲染**。工具、CLI、将来的面板都必须走同一套 `ops`，否则「面板能改、工具改不了」这类分叉会立刻出现。

## 数据流

```
rescan()  ← 每个对外操作的第一步，绝不基于过期索引回答
  ├─ store.reload()          重读 entries/*.json（含坏档检测）
  ├─ scanWorkspace()         增量扫描：mtime+size 命中缓存，否则重扫该文件
  │    ├─ parseDocument()    跳过围栏/行内代码，切段落，算段落哈希
  │    └─ scanText()         抽标记 → refs；alias 命中无标记 → mentions
  ├─ 建基线（只建不改，见下）
  ├─ evaluate()              13 条规则 → issues
  └─ buildIndex() + writeIndex()
```

`rescan()` 是唯一写索引的地方。`check` / `list` / `get` / `stats` 全都先调它。

### 基线（baselines）

键是 `entryId|file`，值形如：

```json
{ "rev": 3, "paragraphHashes": ["a1b2c3d4", "e5f6a7b8"] }
```

用来判断「标记已对齐当前版本时，这段文字有没有被人改过」。

两个必须记住的点：

1. **存哈希集合，不是单个哈希。** 同一文档可能多处引用同一口径，单值会让后一处覆盖前一处，导致前一处改文被误判成「没变」。
2. **只建不改。** `rescan()` 只给「还没有基线」的引用建基线；已存在的基线**绝不能**在这里追加新哈希。否则每次扫描都会把「段落变了」悄悄认成「没变」，`TEXT_CHANGED` 与 `resolve` 的 `TEXT_UNCHANGED` 校验同时失效 —— 这正是「把未核验状态洗成已核验」的那类 bug。基线只在 `canon_resolve` 通过时更新。

## 标记

`lib/marker.js` 里**生成**按扩展名选样式，**识别**对所有已知样式都生效。刻意宽松：在 `.md` 里写了 rst 注释也能认出来，漏检比误检更糟。

```js
renderMarker('D-001', 3, 'html')  // '<!-- canon:D-001@r3 -->'
renderMarker('D-001', null, 'html')  // '<!-- canon:D-001 -->'  UNPINNED
```

扫描时必须跳过两类内容，否则文档里讲标记语法的示例会被当成真引用：

- `advanceFence()` 逐行推进围栏状态，闭合围栏要求同字符、长度不短于开启、且后面没有其它内容。
- `maskInlineCode()` 把行内代码替换成**等长空白**（保持列位置），不删除。

## 段落哈希

```js
hash = sha1Short(normalizeForHash(stripMarkers(paragraphText)))
```

- 先 `stripMarkers` 去掉所有标记 → 改标记版本不会让哈希变，否则每次补钉都像「改了文」。
- 再折叠空白 + 拉丁小写 → 排版调整不算改动。

用段落哈希而不是固定 ±60 字窗口：窗口会把邻近段落的编辑误算成本段漂移。

标记独占一行时，归属其后的第一个非空段落（`parseDocument` 里 `paragraphs.find(item => item.start > i)`）。

## rev 与 change

| `change` | `rev` | `history.seq` | 用途 |
|---|---|---|---|
| `semantic` | +1 | +1 | 事实变了 |
| `wording` | 不变 | +1 | 只调措辞 |

两者解耦，是为了避免「改个错别字让全库 40 处变 STALE」——那会让人干脆不登记口径。

`semantic` 改动时，如果 `aliases` 里有词被换掉，且 `learnDeprecated` 开着，被换掉的词自动进 `deprecatedPhrases`，之后文档里再出现就报 `RESURRECTED`。

## 存储与并发

`lib/store.js`：

- **一条口径一个文件**。多分支各自登记会在 git 层显式冲突，而不是静默撞号。
- **坏档拒绝写入**：`reload()` 收集所有解析失败的文件，`assertWritable()` 在每个写操作开头调用。绝不「改名后从空库起」。
- **BOM 容错**：`stripBom()` 在解析前剥掉 UTF-8 BOM。Windows 上 PowerShell `Set-Content -Encoding UTF8` 写的 JSON 带 BOM，`JSON.parse` 会直接抛错 —— 内容其实完好，不该被当成坏档。
- **原子写**：同目录临时文件 → `rename`。
- **两层锁**：`serialize()` 做进程内串行；`withLock()` 用 `open(lockPath, 'wx')` 抢跨进程锁，`isStaleLock()` 按 mtime 判残留并接管。只有进程内互斥挡不住「多会话 + CLI 各开进程」的丢更新。
- **审计**：`appendAudit()` 追加 JSONL。写失败会抛 `AUDIT_FAILED` —— 审计是证据，不该假装写成功。
- **`readAudit()` 跳过坏行**：`merge=union` 之后可能出现半行。

## 规则引擎

`lib/rules.js` 的 `evaluate()` 接收条目、扫描结果、审计事件、基线、忽略记录，返回排序后的问题列表。

排序：`error → warn → info`，同级按规则表顺序，再按文件。

几个容易忽略的细节：

- `DUPLICATE_ID` 与 `ID_COLLISION` 是**两个**问题。前者是同 id 多个文件（git 能看见），后者是同 id 两条不同指纹的 `add`（`take ours` 解冲突后只剩一个文件，git 已经看不见了）。后者靠 `audit.jsonl` 里的 `fingerprint` 兜住。
- `UNPINNED` 命中后 `continue`，不再往下判 `STALE`。未验证就是未验证，不该同时被算成「过期」。
- 历史类文档统一走 `demote()`：级别降为 `info`，打 `demoted: true`，但**仍然报出来**。交接文档里写着旧口径是重要信息，不能因为降级就消失。
- `renderIssues()` 会剥掉消息开头的「文件:行」前缀（消息里带前缀是为了在工具输出里单独看时清楚），避免 CLI 里重复显示。

## 核验（resolve）

`ops.resolve()` 是最容易做错的一处。规则：

1. 每一项必须带非空 `note`（空 note 直接 `MISSING_NOTE`）。
2. 按 `entryId + file` 找出**全部**引用位置（不是只看第一处）；给了 `line` 就精确匹配。
3. 每处标记必须已钉到当前 `rev`，否则 `MARKER_NOT_REPINNED`。
4. 有基线且段落哈希变了 → `updated`；没变 → 只接受 `confirmed`，记 `updated` 会被 `TEXT_UNCHANGED` 拒绝。
5. 无基线 → 按声明记账，但 `verified: false`。
6. 部分成功时返回 `ok: false` + 已记账的 `done` 列表，让调用方知道哪几处过了。

`line` 参数是给「同一文件多处引用、只想处理其中一处」的场景准备的。

## 补钉（fixPins）

只补 `rev === 1` 的 `UNPINNED`。理由：`rev == 1` 意味着这个条目从来没有语义改动，所以「文档里这句话对应 r1」是唯一可能的解释，补上没有歧义。

`rev > 1` 时，文档里那句话可能对应任何一个历史版本，补数字就是猜 —— 猜错会把未核验的表述洗成已核验。这类一律计入 `skipped`，交给人对照正文后手动改。

扫描本身永远只读，补钉是显式命令。

## repoint

`ops.repoint(from, to, { paths, apply })`：

- 默认 dry-run，返回每处改前/改后的行。
- **不钉版本**：把 `canon:X@rN` 改写成 `canon:Y`，留 UNPINNED。目标条目的 `rev` 和来源无关，钉数字就是猜。
- 只改标记本身，正文一个字不动。
- 必须显式给 `paths`，不猜范围。
- 落在 `ignoreGlobs` 里的文件会被跳过并说明原因。

## CLI

`bin/canon-keeper.mjs` 是薄壳：解析参数 → 调 `ops` → 打印 → 设退出码。没有任何业务逻辑。

退出码 `0 / 1 / 2` 对应「干净 / 有 error / 只有 warn」。`UNPINNED` 是 warn，所以有未验证标记时退出码为 2 —— 这样 CI 里能区分「完全干净」和「还有没核验的地方」。

## 测试

- `test/smoke.mjs`：纯逻辑，不加载宿主。覆盖 rev 语义、标记解析（含代码块）、段落哈希、UNPINNED 不算覆盖率、`--fix-pins` 只补 r1、resolve 三条拒绝路径、repoint 不钉版本、坏档拒写、`DUPLICATE_ID` / `ID_COLLISION`、历史降级、增量缓存、局部重扫不裁索引。
- `test/host.mjs`：需要 `--import ./test/register-stub.mjs`，把 `@deepseek-ai/dsh-tools` 换成 `test/stub-tools.mjs`。覆盖 Config 描述符（每个节点必须有 `meta.volatile`，否则桌面欢迎页的 settings 请求会抛错）、7 个工具注册、参数 schema 形状、真实工作区里的完整链路、错误翻成可读文本、工作区之间互不干扰。

## 改代码时的雷区

| 想改的地方 | 先读 |
|---|---|
| 想让扫描顺手更新基线 | 本节「基线」第 2 点，会让漂移检测失效 |
| 想给 `rev > 1` 也自动补钉 | `fixPins` 一节，那是在猜 |
| 想给 `resolve` 加个「全部确认」快捷方式 | 机制会退化成盖章 |
| 想把 `entries/` 合并成单文件 | 多分支会静默撞号 |
| 想在坏档时「先重建再说」 | id 会被复用，全部标记变 DANGLING |
| 想给工具加标记语法说明 | 只写在 `canon_add` / `canon_update`，其余一行带过 |
