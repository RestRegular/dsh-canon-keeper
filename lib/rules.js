/**
 * 规则引擎：把「条目 + 扫描结果 + 审计」判成一组确定性的问题。
 *
 * 所有规则都是纯文本比对，不调用模型（见 docs/design.md §2.3、§6）。
 * 级别只有三级：error 阻断提交，warn 需要处理，info 只提示。
 *
 * @module dsh-canon-keeper/rules
 */

import { normalizeForHash, normalizeText } from './util.js';

/** 规则级别。 */
export const LEVELS = ['error', 'warn', 'info'];

/** 规则定义表（顺序即输出顺序）。 */
export const RULES = {
  DANGLING: { level: 'error', title: '标记指向不存在的口径' },
  DUPLICATE_ID: { level: 'error', title: '同一 id 出现在多个条目文件' },
  ID_COLLISION: { level: 'error', title: '同一 id 被登记成不同事实（解冲突时丢了一边）' },
  STORE_UNREADABLE: { level: 'error', title: '条目文件无法解析' },
  STALE: { level: 'warn', title: '标记钉的版本落后于口径当前版本' },
  UNPINNED: { level: 'warn', title: '标记没有版本号（未验证）' },
  RESURRECTED: { level: 'warn', title: '文档里出现了已废弃的旧说法' },
  SUPERSEDED_REF: { level: 'warn', title: '标记指向已被取代的口径' },
  DRIFT: { level: 'warn', title: '段落变了但标记版本没变，归属无法判定' },
  BAD_MARKER: { level: 'warn', title: '标记版本号不可解析' },
  TEXT_CHANGED: { level: 'info', title: '标记已对齐但段落内容变了' },
  UNMARKED_MENTION: { level: 'info', title: '命中了定位词但该段落没有标记' },
  ORPHAN: { level: 'info', title: '口径没有任何引用' },
};

/**
 * 判断基线里是否记过这个段落哈希。
 *
 * 基线按「条目 + 文件」存一个哈希集合（同一文档可能多处引用同一口径）；
 * 老格式只有单个 `paragraphHash`，这里一并兼容。
 *
 * @param {object} baseline 基线记录。
 * @param {string} hash 当前段落哈希。
 * @returns {boolean} 是否已记过。
 */
export function baselineHasHash(baseline, hash) {
  if (baseline === null || typeof baseline !== 'object') return false;
  if (Array.isArray(baseline.paragraphHashes)) return baseline.paragraphHashes.includes(hash);
  if (typeof baseline.paragraphHash === 'string') return baseline.paragraphHash === hash;
  return false;
}

/**
 * 构造一条问题。
 * @param {string} code 规则码。
 * @param {object} detail 细节。
 * @returns {object} 问题。
 */
function issue(code, detail) {
  const rule = RULES[code];
  return {
    code,
    level: rule.level,
    title: rule.title,
    historical: false,
    ...detail,
  };
}

/**
 * 历史文件里的问题降级为 info。
 * @param {object} item 问题。
 * @returns {object} 降级后的问题。
 */
function demote(item) {
  if (item.historical !== true) return item;
  return { ...item, level: 'info', demoted: true };
}

/**
 * 找出同一 id 在审计里出现过的不同指纹。
 * @param {Array<object>} auditEvents 审计事件。
 * @returns {Map<string, Array<object>>} id → 指纹分组。
 */
export function collisionsFromAudit(auditEvents) {
  const byId = new Map();
  for (const event of auditEvents) {
    if (event?.op !== 'add') continue;
    const id = String(event.entryId ?? '');
    const fingerprint = String(event.fingerprint ?? '');
    if (id === '' || fingerprint === '') continue;
    const list = byId.get(id) ?? [];
    if (!list.some((item) => item.fingerprint === fingerprint)) {
      list.push({ fingerprint, at: event.at, actor: event.actor, note: event.note });
    }
    byId.set(id, list);
  }
  const out = new Map();
  for (const [id, list] of byId) {
    if (list.length > 1) out.set(id, list);
  }
  return out;
}

/**
 * 跑全部规则。
 * @param {object} input 输入。
 * @param {Array<object>} input.entries 全部条目。
 * @param {object} input.scan 扫描结果。
 * @param {Array<object>} input.auditEvents 审计事件。
 * @param {Array<object>} [input.broken] 无法解析的文件。
 * @param {object} [input.baselines] 基线表。
 * @param {object} [input.ignored] 被忽略的 mention（`entryId|file` → alias 集合）。
 * @returns {{issues: Array<object>, counts: Record<string, number>}} 结果。
 */
export function evaluate(input) {
  const { entries, scan, auditEvents = [], broken = [], baselines = {}, ignored = {} } = input;
  const issues = [];
  const entriesById = new Map();
  const duplicateFiles = new Map();

  for (const entry of entries) {
    if (entry.duplicates !== undefined && entry.duplicates.length > 0) {
      const list = duplicateFiles.get(entry.id) ?? [];
      list.push(entry.file, ...entry.duplicates.map((item) => item.file));
      duplicateFiles.set(entry.id, list);
      continue;
    }
    entriesById.set(entry.id, entry);
  }

  // STORE_UNREADABLE：有坏档时一切写入都被拒绝，必须最先报。
  for (const item of broken) {
    issues.push(issue('STORE_UNREADABLE', {
      file: item.file,
      reason: item.reason,
      message: `条目文件无法解析：${item.file}（${item.reason}）`,
    }));
  }

  // DUPLICATE_ID
  for (const [id, files] of duplicateFiles) {
    issues.push(issue('DUPLICATE_ID', {
      entryId: id,
      files,
      message: `id ${id} 同时出现在 ${files.join(' 和 ')}，请删掉多余的那个文件（不要自动合并）。`,
    }));
  }

  // ID_COLLISION：同 id 两条不同指纹的 add
  for (const [id, list] of collisionsFromAudit(auditEvents)) {
    issues.push(issue('ID_COLLISION', {
      entryId: id,
      fingerprints: list,
      message: `id ${id} 在审计里有 ${list.length} 条指纹不同的登记记录，说明解冲突时丢掉了一边；请人工确认保留哪条，另一条改号后用 canon repoint 修标记。`,
    }));
  }

  // 引用类规则
  const referenced = new Set();
  for (const ref of scan.refs ?? []) {
    const entry = entriesById.get(ref.entryId);
    if (entry === undefined) {
      issues.push(demote(issue('DANGLING', {
        entryId: ref.entryId,
        file: ref.file,
        line: ref.line,
        snippet: ref.snippet,
        historical: ref.historical,
        message: `${ref.file}:${ref.line} 的标记指向不存在的口径 ${ref.entryId}。`,
      })));
      continue;
    }
    referenced.add(entry.id);

    if (ref.badMarker === true || (ref.pinRev !== null && ref.pinRev !== undefined && ref.pinRev <= 0)) {
      issues.push(demote(issue('BAD_MARKER', {
        entryId: entry.id,
        file: ref.file,
        line: ref.line,
        snippet: ref.snippet,
        historical: ref.historical,
        message: `${ref.file}:${ref.line} 的标记版本号不可解析，请改成 @r<正整数> 或去掉版本号走核验。`,
      })));
      continue;
    }

    if (entry.supersededBy) {
      issues.push(demote(issue('SUPERSEDED_REF', {
        entryId: entry.id,
        supersededBy: entry.supersededBy,
        file: ref.file,
        line: ref.line,
        snippet: ref.snippet,
        historical: ref.historical,
        message: `${ref.file}:${ref.line} 仍指向已被 ${entry.supersededBy} 取代的 ${entry.id}，用 canon repoint ${entry.id} ${entry.supersededBy} --paths ${ref.file} --apply 改指向。`,
      })));
    }

    if (ref.pinRev === null || ref.pinRev === undefined) {
      const autoPinnable = entry.rev === 1;
      issues.push(demote(issue('UNPINNED', {
        entryId: entry.id,
        file: ref.file,
        line: ref.line,
        snippet: ref.snippet,
        historical: ref.historical,
        autoPinnable,
        message: autoPinnable
          ? `${ref.file}:${ref.line} 的标记没有版本号；该口径只有 rev 1，可用 canon check --fix-pins 自动补成 @r1。`
          : `${ref.file}:${ref.line} 的标记没有版本号（未验证，不计入覆盖率）；该口径已到 rev ${entry.rev}，请对照当前 statement 后手动改成 @r${entry.rev}，再 canon_resolve 记账。`,
      })));
      continue;
    }

    if (ref.pinRev < entry.rev) {
      issues.push(demote(issue('STALE', {
        entryId: entry.id,
        file: ref.file,
        line: ref.line,
        pinRev: ref.pinRev,
        rev: entry.rev,
        snippet: ref.snippet,
        historical: ref.historical,
        message: `${ref.file}:${ref.line} 钉在 r${ref.pinRev}，口径已到 r${entry.rev}。`,
      })));
      continue;
    }

    // pin == rev（或异常地大于 rev）：比对段落哈希。
    const baseline = baselines[`${entry.id}|${ref.file}`];
    if (baseline !== undefined && !baselineHasHash(baseline, ref.paragraphHash)) {
      issues.push(demote(issue('TEXT_CHANGED', {
        entryId: entry.id,
        file: ref.file,
        line: ref.line,
        rev: entry.rev,
        snippet: ref.snippet,
        historical: ref.historical,
        message: `${ref.file}:${ref.line} 的标记已对齐 r${entry.rev}，但该段文字改过了：要么这处表述需要跟着口径更新，要么只是无关编辑（请回退或确认）。`,
      })));
    }
    if (ref.pinRev > entry.rev) {
      issues.push(demote(issue('DRIFT', {
        entryId: entry.id,
        file: ref.file,
        line: ref.line,
        pinRev: ref.pinRev,
        rev: entry.rev,
        snippet: ref.snippet,
        historical: ref.historical,
        message: `${ref.file}:${ref.line} 钉的是 r${ref.pinRev}，比口径当前 rev ${entry.rev} 还新 —— 可能是 rebase/回滚后的残留，请核对。`,
      })));
    }
  }

  // RESURRECTED
  for (const item of scan.resurrected ?? []) {
    const entry = entriesById.get(item.entryId);
    if (entry === undefined) continue;
    issues.push(demote(issue('RESURRECTED', {
      entryId: entry.id,
      phrase: item.phrase,
      file: item.file,
      line: item.line,
      snippet: item.snippet,
      historical: item.historical,
      message: `${item.file}:${item.line} 出现了 ${entry.id} 已废弃的说法「${item.phrase}」。`,
    })));
  }

  // UNMARKED_MENTION（可被 ignore 记录压制）
  for (const item of scan.mentions ?? []) {
    const entry = entriesById.get(item.entryId);
    if (entry === undefined) continue;
    const ignoreKey = `${item.entryId}|${item.file}`;
    if (ignored[ignoreKey]?.has?.(item.alias) || ignored[ignoreKey]?.includes?.(item.alias)) continue;
    issues.push(demote(issue('UNMARKED_MENTION', {
      entryId: entry.id,
      alias: item.alias,
      file: item.file,
      line: item.line,
      snippet: item.snippet,
      historical: item.historical,
      message: `${item.file}:${item.line} 提到「${item.alias}」但没有 ${entry.id} 的标记，考虑补标（或记录忽略）。`,
    })));
  }

  // ORPHAN
  for (const entry of entriesById.values()) {
    if (referenced.has(entry.id)) continue;
    if (entry.supersededBy) continue;
    issues.push(issue('ORPHAN', {
      entryId: entry.id,
      message: `口径 ${entry.id}「${entry.title}」还没有任何文档引用它。`,
    }));
  }

  const order = new Map(Object.keys(RULES).map((code, index) => [code, index]));
  issues.sort((a, b) => {
    const levelDiff = LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level);
    if (levelDiff !== 0) return levelDiff;
    const codeDiff = (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99);
    if (codeDiff !== 0) return codeDiff;
    return String(a.file ?? a.entryId ?? '').localeCompare(String(b.file ?? b.entryId ?? ''));
  });

  const counts = { error: 0, warn: 0, info: 0 };
  const byCode = {};
  for (const item of issues) {
    counts[item.level] += 1;
    byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  }
  return { issues, counts, byCode };
}

/**
 * 从审计事件里还原「被忽略的 mention」。
 * @param {Array<object>} auditEvents 审计事件。
 * @returns {Record<string, string[]>} `entryId|file` → alias 列表。
 */
export function ignoredMentions(auditEvents) {
  const out = {};
  for (const event of auditEvents) {
    if (event?.op !== 'ignore-mention') continue;
    const key = `${event.entryId}|${String(event.file ?? '').replace(/\\/g, '/')}`;
    const list = out[key] ?? [];
    if (!list.includes(event.alias)) list.push(event.alias);
    out[key] = list;
  }
  return out;
}

/**
 * 计算试跑指标。
 * @param {object} input 输入。
 * @param {Array<object>} input.entries 条目。
 * @param {object} input.scan 扫描结果。
 * @param {object} input.byCode 规则计数。
 * @param {Array<object>} input.auditEvents 审计事件。
 * @returns {object} 指标。
 */
export function computeStats(input) {
  const { entries, scan, byCode, auditEvents } = input;
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  let aligned = 0;
  let stale = 0;
  let unpinned = 0;
  let dangling = 0;
  for (const ref of scan.refs ?? []) {
    const entry = entriesById.get(ref.entryId);
    if (entry === undefined) {
      dangling += 1;
      continue;
    }
    if (ref.pinRev === null || ref.pinRev === undefined) {
      unpinned += 1;
      continue;
    }
    if (ref.pinRev < entry.rev) stale += 1;
    else aligned += 1;
  }
  const unmarked = byCode.UNMARKED_MENTION ?? 0;
  const denominator = aligned + stale + unpinned + unmarked;
  const resolved = auditEvents.filter((event) => event?.op === 'resolve');
  const confirmed = resolved.filter((event) => event.outcome === 'confirmed').length;
  const updated = resolved.filter((event) => event.outcome === 'updated').length;
  return {
    entries: entries.length,
    refs: (scan.refs ?? []).length,
    aligned,
    stale,
    unpinned,
    dangling,
    unmarkedHits: unmarked,
    resurrectedHits: byCode.RESURRECTED ?? 0,
    orphan: byCode.ORPHAN ?? 0,
    coverage: denominator === 0 ? 0 : Number((aligned / denominator).toFixed(4)),
    confirmedRatio: confirmed + updated === 0 ? 0 : Number((confirmed / (confirmed + updated)).toFixed(4)),
    resolved: resolved.length,
    confirmed,
    updated,
  };
}

/**
 * 把问题渲染成文本。
 * @param {Array<object>} issues 问题列表。
 * @param {object} [options] 选项。
 * @returns {string} 文本。
 */
export function renderIssues(issues, options = {}) {
  const limit = options.limit ?? 200;
  if (issues.length === 0) return '没有发现问题。';
  const lines = [];
  for (const item of issues.slice(0, limit)) {
    const where = item.file === undefined ? '' : `${item.file}${item.line === undefined ? '' : `:${item.line}`}`;
    const mark = item.demoted === true ? '（历史）' : '';
    // 消息本身常以「文件:行」开头（工具里单独展示时更清楚），这里已有前缀就不重复。
    let message = String(item.message ?? item.title);
    if (where !== '' && message.startsWith(where)) message = message.slice(where.length).trimStart();
    lines.push(`[${item.level}] ${item.code}${mark} ${where}${where === '' ? '' : ' '}${message}`);
  }
  if (issues.length > limit) lines.push(`… 另有 ${issues.length - limit} 条未显示。`);
  return lines.join('\n');
}

/**
 * 归一化用于展示的段落文本。
 * @param {string} text 文本。
 * @returns {string} 归一化文本。
 */
export function flatten(text) {
  return normalizeText(normalizeForHash(text));
}
