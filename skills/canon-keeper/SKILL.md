---
name: canon-keeper
description: Use when a project keeps a canon library (a `.dsh/canon-keeper/` directory of numbered entries such as D-001 / R-002) and you need to register, pin, re-verify, or audit the key facts that documents keep citing — decisions, rules, fixed values, terminology. Covers the versioned marker syntax for every file format, when to use each of the seven `canon_*` tools, and what the verifier actually checks.
---

# 口径守护（canon-keeper）

项目里那些「会被反复引用的关键事实」——决策、规则、取值、术语、事实——登记成带语义版本的编号条目，写进文档时用带版本的标记钉住。口径一改，就能机械列出所有引用位置并逐处核验。

## 什么时候该用

- **开工前**：`canon_list` 看一遍已有口径。避免重复登记，也避免你的实现和既有决策冲突。
- **要定一条新约定 / 改一条旧约定**：`canon_add` / `canon_update`。
- **改了口径之后**：`canon_get` 看清影响面 → 逐处改文档 → `canon_resolve` 记账。
- **一批文档改完**：`canon_check` 做全库体检。

## 什么不该进口径库

只登记**真正稳定、多处会引用**的东西。反例：一次性的排错过程、某个文件的临时路径、本轮任务的进度。这些写进去只会让库变噪音，最后没人看。

判断标准：这句话会不会在三个以上地方被引用？半年后改它，是不是有别的文档要跟着改？两个都是「否」，就别登记。

## 标记语法

标记随文档走、自带版本号，**格式跟着文件类型变**：

| 文件类型 | 标记 |
|---|---|
| Markdown / HTML | `<!-- canon:D-001@r3 -->` |
| MDX | `{/* canon:D-001@r3 */}` |
| reStructuredText | `.. canon:D-001@r3` |
| AsciiDoc | `// canon:D-001@r3` |
| 纯文本 | `[[canon:D-001@r3]]` |

规则：

- 标记放在**它所约束的那一段里**。独占一行时，归属其后第一个非空段落。
- 省略 `@rN` 表示「未验证」：不计入覆盖率，`canon_check` 会一直报 `UNPINNED`。
- 围栏代码块与行内代码里的标记**不算引用**——可以放心在文档里写语法示例。

`canon_add` / `canon_update` 的返回值里直接给出可粘贴的标记文本，别自己拼。

## 七个工具怎么分工

| 工具 | 什么时候用 |
|---|---|
| `canon_list` | 开工前扫一眼；按 kind / tag / status 过滤 |
| `canon_get` | 看某条口径的全文、历史、所有引用位置（含每处已对齐还是过期） |
| `canon_add` | 登记新口径；返回新 id、可粘贴标记、相似条目、已提到但未标记的位置 |
| `canon_update` | 改口径正文 / 定位词；**会升版本**，旧标记全部变过期 |
| `canon_archive` | 归档被取代的条目 |
| `canon_resolve` | 核验某处已处理（改文或确认无影响） |
| `canon_check` | 全库体检：过期、悬空、未钉版本、提到却没标记 |

## canon_resolve 是记账，不是盖章

它会**核对文档现状**，对不上就拒绝：

- 标记必须已经钉到当前版本；
- 记 `updated` 要求该段落文字确实变了；
- 记 `confirmed` 要求写清为什么这处不受影响。

批量处理过期位置时，每项都要带具体 `note`——空 note 一律拒绝。这是刻意设计的：这个工具的价值在于「事后能证明你真的看过」，而不是给你一个把红点消掉的按钮。

## 核验到底在核什么

`canon_check` 只做确定性文本比对，**不调用模型判断两句话是否矛盾**。它检查的是：

- 文档里的标记指向的条目是否还存在（否则 `DANGLING`）；
- 标记的版本是否落后于条目当前版本（否则过期）；
- 标记是否省略了版本号（`UNPINNED`）；
- 条目的定位词在文档里出现、但该处没有标记（「提到却没标记」）。

所以它不会发现「你写了句和口径矛盾但没提定位词的话」。那是语义判断，做不到可复现，这个插件刻意不做。

## 存储与安全

```
.dsh/canon-keeper/
  entries/<ID>.json   权威数据，纳入 git
  audit.jsonl         追加式审计，纳入 git
  index.json          派生索引，可删
  .lock               跨进程写锁
```

- 任何条目文件解析失败 → 所有写操作报 `STORE_UNREADABLE`，**绝不从空库起**（那会让全部标记变悬空，且 id 被复用）。
- 索引坏了直接删，会自动重建。
- 扫描永远只读，不改文档。补钉是显式操作。

## 常见误用

- 把一次性细节登记成口径 → 库变噪音。
- 改了文档忘了 `canon_resolve` → 覆盖率一直是红的，最后没人信这个指标。
- 手写标记但拼错 id → `DANGLING`，比不标记更糟。
- 在 `canon_update` 之后不处理旧标记 → 全部变过期，`canon_check` 会一次列出来。
