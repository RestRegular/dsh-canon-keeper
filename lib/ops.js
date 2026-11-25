/**
 * 共用操作层：工具、CLI、面板都只调这里，保证「一个操作、多个调用方」。
 *
 * 这一层负责把 store / scan / rules 拼成业务动作，并保证每个动作都：
 *   - 先增量重扫，再报告（绝不基于过期索引回答）；
 *   - 返回足够 Agent 当场决策的信息（影响清单、相似条目、可粘贴的标记文本）。
 *
 * @module dsh-canon-keeper/ops
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { STORE_ERRORS, StoreError, CanonStore, normalizeList } from './store.js';
import { SCAN_DEFAULTS, buildIndex, normalizeScanConfig, parseDocument, scanFromIndex, scanWorkspace } from './scan.js';
import { computeStats, evaluate, ignoredMentions, renderIssues, baselineHasHash } from './rules.js';
import { extractMarkers, renderMarker, stripMarkers, styleFor } from './marker.js';
import { matchesAny, similarity, snippet } from './util.js';

/** 相似度阈值（超过才在 canon_add 里提示可能重复）。 */
const SIMILARITY_THRESHOLD = 0.35;

/**
 * 操作层错误：带 `code`，让路由与面板能区分失败原因。
 */
export class OpsError extends Error {
  /**
   * @param {string} code 错误码。
   * @param {string} message 人话说明。
   */
  constructor(code, message) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}

/**
 * 口径操作集合。
 */
export class CanonOps {
  /**
   * @param {object} options 选项。
   * @param {string} options.cwd 工作区根目录。
   * @param {string} options.storeDir 存储目录绝对路径。
   * @param {object} [options.scanConfig] 扫描配置。
   * @param {object} [options.logger] 日志。
   * @param {number} [options.lockTimeoutMs] 锁超时。
   */
  constructor(options) {
    this.cwd = options.cwd;
    this.scanConfig = normalizeScanConfig(options.scanConfig);
    this.logger = options.logger;
    this.store = new CanonStore({
      dir: options.storeDir,
      logger: options.logger,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    /** @type {object|null} 最近一次扫描结果。 */
    this.lastScan = null;
    this.ready = false;
  }

  /**
   * 初始化（建目录 + 加载条目 + 读索引）。
   * @returns {Promise<void>} 完成。
   */
  async init() {
    await this.store.init();
    const index = await this.store.readIndex();
    this.lastScan = scanFromIndex(index);
    this.index = index;
    this.ready = true;
  }

  /**
   * 确保已初始化。
   * @returns {Promise<void>} 完成。
   */
  async ensure() {
    if (!this.ready) await this.init();
  }

  /**
   * 增量重扫并写回索引。
   *
   * 所有对外操作都先走这一步，避免读到过期数据。
   *
   * @param {object} [options] 选项。
   * @param {boolean} [options.force] 忽略缓存全量扫。
   * @param {string[]} [options.onlyFiles] 只扫这些文件。
   * @returns {Promise<object>} 扫描结果。
   */
  async rescan(options = {}) {
    await this.ensure();
    await this.store.reload();
    const previous = options.force === true ? null : scanFromIndex(this.index);
    const scan = await scanWorkspace({
      cwd: this.cwd,
      entries: this.store.list(),
      config: this.scanConfig,
      previous,
      onlyFiles: options.onlyFiles ?? null,
    });
    this.lastScan = scan;

    const baselines = { ...(this.index?.baselines ?? {}) };
    // 丢弃指向已不存在文件的基线。
    const alive = new Set((scan.refs ?? []).map((ref) => `${ref.entryId}|${ref.file}`));
    for (const key of Object.keys(baselines)) {
      if (!alive.has(key)) delete baselines[key];
    }
    // 给「还没有基线」的引用建基线：pin 已对齐当前 rev 时，用当前段落哈希。
    //
    // 一个「条目 + 文件」可能对应多处引用（同一文档里提了两次），
    // 所以基线存的是哈希集合，不是单个哈希 —— 否则后一处会覆盖前一处。
    //
    // 注意：**只建不改**。已存在的基线绝不能在这里追加新哈希，
    // 否则每次扫描都会把「段落变了」悄悄认成「没变」，漂移检测就废了；
    // 基线的更新只发生在 canon_resolve 核验通过时。
    const entriesById = new Map(this.store.list().map((entry) => [entry.id, entry]));
    const fresh = new Map();
    for (const ref of scan.refs ?? []) {
      const entry = entriesById.get(ref.entryId);
      if (entry === undefined) continue;
      if (ref.pinRev !== entry.rev) continue;
      const key = `${ref.entryId}|${ref.file}`;
      if (baselines[key] !== undefined) continue;
      const hashes = fresh.get(key) ?? [];
      if (!hashes.includes(ref.paragraphHash)) hashes.push(ref.paragraphHash);
      fresh.set(key, hashes);
    }
    for (const [key, hashes] of fresh) {
      baselines[key] = { rev: entriesById.get(key.slice(0, key.indexOf('|')))?.rev ?? 0, paragraphHashes: hashes };
    }

    const auditEvents = await this.store.readAudit();
    const ignored = ignoredMentions(auditEvents);
    const broken = this.store.writable().broken;
    const result = evaluate({
      entries: this.store.list(),
      scan,
      auditEvents,
      broken,
      baselines,
      ignored,
    });
    const stats = computeStats({
      entries: this.store.list(),
      scan,
      byCode: result.byCode,
      auditEvents,
    });
    this.index = buildIndex(scan, baselines, stats);
    await this.store.writeIndex(this.index);
    return { scan, issues: result.issues, counts: result.counts, byCode: result.byCode, stats, baselines };
  }

  /**
   * 列出条目。
   * @param {object} [query] 查询。
   * @returns {Promise<{entries: Array<object>, stats: object}>} 结果。
   */
  async list(query = {}) {
    const { issues, stats } = await this.rescan();
    const byEntry = new Map();
    for (const item of issues) {
      if (item.entryId === undefined) continue;
      const list = byEntry.get(item.entryId) ?? [];
      list.push(item);
      byEntry.set(item.entryId, list);
    }
    let entries = this.store.list();
    const kind = typeof query.kind === 'string' ? query.kind.toLowerCase() : '';
    if (kind !== '') entries = entries.filter((entry) => entry.kind === kind);
    if (typeof query.tag === 'string' && query.tag !== '') {
      entries = entries.filter((entry) => (entry.tags ?? []).includes(query.tag));
    }
    if (query.includeArchived !== true) {
      entries = entries.filter((entry) => !entry.supersededBy);
    }
    const status = typeof query.status === 'string' ? query.status.toLowerCase() : 'all';
    if (status === 'stale') {
      entries = entries.filter((entry) => (byEntry.get(entry.id) ?? []).some((item) => item.code === 'STALE' || item.code === 'UNPINNED'));
    } else if (status === 'orphan') {
      entries = entries.filter((entry) => (byEntry.get(entry.id) ?? []).some((item) => item.code === 'ORPHAN'));
    } else if (status === 'problem') {
      entries = entries.filter((entry) => (byEntry.get(entry.id) ?? []).some((item) => item.level !== 'info'));
    }
    const text = typeof query.query === 'string' ? query.query.trim() : '';
    if (text !== '') {
      entries = entries
        .map((entry) => ({ entry, score: scoreEntry(entry, text) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.entry);
    }
    return {
      entries: entries.map((entry) => ({
        ...entry,
        issues: (byEntry.get(entry.id) ?? []).filter((item) => item.level !== 'info'),
        counts: countIssues(byEntry.get(entry.id) ?? []),
      })),
      stats,
    };
  }

  /**
   * 取一条（含受影响位置）。
   * @param {string} id 条目 id。
   * @returns {Promise<object|null>} 详情。
   */
  async get(id) {
    const { issues, scan } = await this.rescan();
    const entry = this.store.get(id);
    if (entry === null) return null;
    const refs = (scan.refs ?? []).filter((ref) => ref.entryId === entry.id);
    const related = issues.filter((item) => item.entryId === entry.id);
    return {
      entry,
      refs: refs.map((ref) => ({
        ...ref,
        issues: related.filter((item) => item.file === ref.file && item.line === ref.line),
      })),
      issues: related,
      marker: renderMarker(entry.id, entry.rev, styleFor('README.md', undefined)),
    };
  }

  /**
   * 新增条目，并返回相似条目与即时命中位置。
   * @param {object} input 输入。
   * @returns {Promise<object>} 结果。
   */
  async add(input) {
    await this.ensure();
    const existing = this.store.list().filter((entry) => !entry.supersededBy);
    const probe = `${input?.title ?? ''} ${input?.statement ?? ''} ${(input?.aliases ?? []).join(' ')}`;
    const similar = existing
      .map((entry) => ({
        entry,
        score: similarity(probe, `${entry.title} ${entry.statement} ${(entry.aliases ?? []).join(' ')}`),
      }))
      .filter((item) => item.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => ({ id: item.entry.id, title: item.entry.title, score: Number(item.score.toFixed(2)) }));

    const entry = await this.store.add(input);
    const { scan } = await this.rescan();
    const hits = (scan.mentions ?? [])
      .filter((item) => item.entryId === entry.id)
      .map((item) => ({ file: item.file, line: item.line, alias: item.alias, snippet: item.snippet }));
    return { entry, similar, hits };
  }

  /**
   * 更新条目，并返回影响清单（含新旧对照）。
   * @param {string} id 条目 id。
   * @param {object} patch 改动。
   * @param {object} meta 元信息。
   * @returns {Promise<object>} 结果。
   */
  async update(id, patch, meta = {}) {
    await this.ensure();
    const before = this.store.get(id);
    if (before === null) throw new StoreError(STORE_ERRORS.NOT_FOUND, `没有找到口径 ${id}。`);
    const result = await this.store.update(id, patch, meta);
    const { scan } = await this.rescan();
    const refs = (scan.refs ?? []).filter((ref) => ref.entryId === result.entry.id);
    const impact = refs.map((ref) => ({
      file: ref.file,
      line: ref.line,
      pinRev: ref.pinRev,
      snippet: ref.snippet,
      before: snippet(before.statement),
      after: snippet(result.entry.statement),
      stale: ref.pinRev === null || ref.pinRev === undefined || ref.pinRev < result.entry.rev,
    }));
    return {
      entry: result.entry,
      previousRev: before.rev,
      revChanged: result.revChanged,
      deprecatedAdded: result.deprecatedAdded,
      impact,
      marker: renderMarker(result.entry.id, result.entry.rev, styleFor('README.md', undefined)),
    };
  }

  /**
   * 归档条目。
   * @param {string} id 条目 id。
   * @param {object} meta 元信息。
   * @returns {Promise<object>} 结果。
   */
  async archive(id, meta = {}) {
    await this.ensure();
    const entry = await this.store.archive(id, meta);
    const { scan } = await this.rescan();
    const refs = (scan.refs ?? []).filter((ref) => ref.entryId === entry.id);
    return {
      entry,
      refs: refs.map((ref) => ({ file: ref.file, line: ref.line, pinRev: ref.pinRev })),
    };
  }

  /**
   * 批量核验。
   *
   * 这是「验证」而不是「盖章」：必须能从文档现状证明处理过。
   *
   * @param {Array<object>} items 待核验项。
   * @param {object} [meta] 元信息。
   * @returns {Promise<object>} 结果。
   */
  async resolve(items, meta = {}) {
    await this.ensure();
    if (!Array.isArray(items) || items.length === 0) {
      throw new StoreError('INVALID_INPUT', 'items 不能为空。');
    }
    for (const item of items) {
      if (typeof item?.note !== 'string' || item.note.trim() === '') {
        throw new StoreError(
          'MISSING_NOTE',
          '每一项都必须带 note（说明你做了什么改动或为什么确认无影响）；批量盖章没有意义。',
        );
      }
    }
    await this.store.reload();
    const results = [];
    const touchedFiles = [...new Set(items.map((item) => String(item.file ?? '').replace(/\\/g, '/')).filter((item) => item !== ''))];
    const scan = await this.rescan({ onlyFiles: touchedFiles.length > 0 ? touchedFiles : null });
    const baselines = { ...(scan.baselines ?? {}) };

    for (const item of items) {
      const entryId = String(item.entryId ?? '');
      const file = String(item.file ?? '').replace(/\\/g, '/');
      const entry = this.store.get(entryId);
      if (entry === null) {
        results.push({ ok: false, entryId, file, error: 'NOT_FOUND', message: `没有找到口径 ${entryId}。` });
        continue;
      }
      const refs = (scan.scan.refs ?? []).filter((ref) => ref.entryId === entryId && ref.file === file);
      if (refs.length === 0) {
        results.push({
          ok: false,
          entryId,
          file,
          error: 'MARKER_MISSING',
          message: `${file} 里已经没有 ${entryId} 的标记了；如果是有意删除，请忽略这一项。`,
        });
        continue;
      }
      // 同一文件里可能有多处引用同一口径，逐处核验；只有全部处理完才算这项通过。
      const targets = item.line === undefined
        ? refs
        : refs.filter((ref) => ref.line === Number(item.line));
      if (targets.length === 0) {
        results.push({
          ok: false,
          entryId,
          file,
          error: 'MARKER_MISSING',
          message: `${file}${item.line === undefined ? '' : `:${item.line}`} 里没有 ${entryId} 的标记；若是有意删除，请忽略这一项。`,
        });
        continue;
      }

      const itemFailures = [];
      const itemDone = [];
      for (const ref of targets) {
        if (ref.pinRev === null || ref.pinRev === undefined) {
          itemFailures.push({
            error: 'MARKER_NOT_REPINNED',
            message: `${file}:${ref.line} 的标记仍没有版本号。请先对照当前 statement 把它改成 ${renderMarker(entryId, entry.rev, styleFor(file, undefined))}，再核验。`,
          });
          continue;
        }
        if (ref.pinRev < entry.rev) {
          itemFailures.push({
            error: 'MARKER_NOT_REPINNED',
            message: `${file}:${ref.line} 仍钉在 r${ref.pinRev}，口径已是 r${entry.rev}。请先改文并把标记改成 ${renderMarker(entryId, entry.rev, styleFor(file, undefined))}。`,
          });
          continue;
        }
        const key = `${entryId}|${file}`;
        const baseline = baselines[key];
        let outcome;
        let verified;
        if (baseline === undefined) {
          outcome = item.outcome === 'confirmed' ? 'confirmed' : 'updated';
          verified = false;
        } else if (!baselineHasHash(baseline, ref.paragraphHash)) {
          outcome = 'updated';
          verified = true;
        } else {
          if (item.outcome === 'updated') {
            itemFailures.push({
              error: 'TEXT_UNCHANGED',
              message: `${file}:${ref.line} 的段落和上次核验时一模一样，不能记成「已改文」。若确认无需改动，请用 outcome:"confirmed" 并说明理由。`,
            });
            continue;
          }
          outcome = 'confirmed';
          verified = true;
        }
        await this.store.appendAudit({
          op: 'resolve',
          entryId,
          file,
          line: ref.line,
          fromRev: ref.pinRev,
          toRev: entry.rev,
          outcome,
          verified,
          actor: meta.actor ?? { kind: 'unknown' },
          note: String(item.note),
        });
        // 处理后刷新基线，避免同一处被反复要求核验。
        const record = baselines[key];
        const hashes = record?.paragraphHashes ?? (record?.paragraphHash === undefined ? [] : [record.paragraphHash]);
        baselines[key] = {
          rev: entry.rev,
          paragraphHashes: hashes.includes(ref.paragraphHash) ? hashes : [...hashes, ref.paragraphHash],
        };
        itemDone.push({ line: ref.line, outcome, verified });
      }

      if (itemFailures.length > 0) {
        results.push({
          ok: false,
          entryId,
          file,
          error: itemFailures[0].error,
          message: itemFailures.map((failure) => failure.message).join('\n'),
          done: itemDone,
        });
        continue;
      }
      results.push({
        ok: true,
        entryId,
        file,
        outcome: itemDone[0]?.outcome ?? item.outcome,
        verified: itemDone.every((done) => done.verified),
        lines: itemDone.map((done) => done.line),
        message: `${file} 共 ${itemDone.length} 处记为 ${itemDone[0]?.outcome ?? item.outcome}${itemDone.every((done) => done.verified) ? '' : '（无基线，仅声明）'}。`,
      });
    }

    this.index = { ...(this.index ?? {}), version: 1, baselines };
    await this.store.writeIndex(this.index);
    const failed = results.filter((item) => !item.ok);
    return { ok: failed.length === 0, results, failed };
  }

  /**
   * 读取某处引用所属段落的原文（面板进入编辑态时用）。
   *
   * 返回的 `paragraphText` 是**磁盘上的原始行**（未去标记、未掩码），
   * 因为面板要把它放回文件，不能把掩码后的文本写回去。
   *
   * @param {object} input 输入。
   * @param {string} input.entryId 条目 id。
   * @param {string} input.file 相对路径。
   * @param {number} [input.line] 标记所在行（1 基）。
   * @returns {Promise<object>} 段落信息。
   */
  async readParagraph(input) {
    await this.ensure();
    const entryId = String(input.entryId ?? '');
    const file = String(input.file ?? '').replace(/\\/g, '/');
    const abs = this.resolveInside(file);

    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      throw new OpsError('FILE_UNREADABLE', `读不到 ${file}。`);
    }

    const located = this.locateParagraph(text, entryId, input.line);
    if (located === null) {
      throw new OpsError('MARKER_MISSING', `${file} 里找不到 ${entryId} 的标记（或它所属的段落）。`);
    }
    return {
      file,
      entryId,
      startLine: located.bodyStart + 1,
      endLine: located.bodyEnd + 1,
      text: located.text,
      hash: located.hash,
    };
  }

  /**
   * 把段落原文写回文件，并按「已改文」记一条核验。
   *
   * 三层保护（顺序执行，任何一层不过就不写）：
   *   1. 路径必须落在工作区内（`resolveInside`）；
   *   2. 冲突检测 —— 调用方带 `expectedHash`，与磁盘当前段落哈希不一致就拒绝；
   *   3. 备注必填 —— 没有备注的保存不构成证据，直接拒绝。
   *
   * 写完立刻重扫该文件并核验，所以「保存」本身就是一次可审计的核验动作。
   *
   * @param {object} input 输入。
   * @param {string} input.entryId 条目 id。
   * @param {string} input.file 相对路径。
   * @param {number} [input.line] 标记所在行。
   * @param {string} input.text 新段落文本。
   * @param {string} [input.expectedHash] 调用方读到的段落哈希（冲突检测）。
   * @param {string} input.note 备注（必填）。
   * @param {object} [meta] 元信息（actor）。
   * @returns {Promise<object>} 结果。
   */
  async editText(input, meta = {}) {
    await this.ensure();
    await this.store.reload();

    const entryId = String(input.entryId ?? '');
    const file = String(input.file ?? '').replace(/\\/g, '/');
    const note = String(input.note ?? '').trim();
    const nextText = String(input.text ?? '');

    // 备注必填：没有备注的保存不构成证据。
    if (note === '') {
      throw new OpsError('NOTE_REQUIRED', '保存前必须写一句备注，说明为什么这样改。');
    }
    if (nextText.trim() === '') {
      throw new OpsError('TEXT_EMPTY', '段落不能改成空的；要删除内容请直接在编辑器里改文件。');
    }

    const entry = this.store.get(entryId);
    if (entry === null) throw new OpsError('NOT_FOUND', `没有找到口径 ${entryId}。`);

    const abs = this.resolveInside(file);
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      throw new OpsError('FILE_UNREADABLE', `读不到 ${file}。`);
    }

    const located = this.locateParagraph(text, entryId, input.line);
    if (located === null) {
      throw new OpsError('MARKER_MISSING', `${file} 里找不到 ${entryId} 的标记（或它所属的段落）。`);
    }

    // 冲突检测：面板带着它读到的哈希提交，磁盘变了就拒绝，绝不覆盖别人的改动。
    const expected = input.expectedHash === undefined ? undefined : String(input.expectedHash);
    if (expected !== undefined && expected !== '' && expected !== located.hash) {
      throw new OpsError(
        'FILE_CHANGED',
        `${file} 在面板打开后被改过了（段落哈希不一致）。请刷新后重新编辑，避免覆盖别人的改动。`,
      );
    }

    // 只替换正文区：标记行原样留在原处，否则保存一次就把标记删了。
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const allLines = text.split(/\r?\n/);
    const replacement = nextText.split(/\r?\n/);
    const before = allLines.slice(0, located.bodyStart);
    const after = allLines.slice(located.bodyEnd + 1);
    const written = [...before, ...replacement, ...after].join(eol);

    await fs.writeFile(abs, written, 'utf8');

    // 写盘后立刻重扫该文件并核验，把「保存」变成一次可审计动作。
    const scan = await this.rescan({ onlyFiles: [file] });
    const refs = (scan.scan.refs ?? []).filter((ref) => ref.entryId === entryId && ref.file === file);
    const target = input.line === undefined
      ? refs[0]
      : refs.find((ref) => ref.line === Number(input.line)) ?? refs[0];

    await this.store.appendAudit({
      op: 'edit-text',
      entryId,
      file,
      line: target?.line ?? located.markerLine + 1,
      startLine: located.bodyStart + 1,
      endLine: located.bodyStart + replacement.length,
      fromHash: located.hash,
      toHash: target?.paragraphHash ?? '',
      actor: meta.actor ?? { kind: 'unknown' },
      note,
    });

    // 核验：段落哈希变了就是「已改文」，这是 editText 的固有语义。
    const resolved = await this.resolve([{
      entryId,
      file,
      line: target?.line,
      outcome: 'updated',
      note,
    }], meta);

    return {
      ok: resolved.ok === true,
      file,
      entryId,
      startLine: located.bodyStart + 1,
      endLine: located.bodyStart + replacement.length,
      hash: target?.paragraphHash ?? '',
      resolved,
    };
  }

  /**
   * 把相对路径解析成工作区内的绝对路径，越界直接拒绝。
   *
   * `path.join(cwd, file)` 本身不拦 `../`，所以写文件之前必须显式校验，
   * 否则面板就能改写工作区外的任意文件。
   *
   * @param {string} file 相对路径。
   * @returns {string} 绝对路径。
   */
  resolveInside(file) {
    const raw = String(file ?? '');
    if (raw.trim() === '') throw new OpsError('PATH_INVALID', '文件路径为空。');
    if (path.isAbsolute(raw)) throw new OpsError('PATH_INVALID', `只接受工作区内的相对路径：${raw}`);
    const abs = path.resolve(this.cwd, raw);
    const rel = path.relative(this.cwd, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OpsError('PATH_OUTSIDE', `路径越出工作区，拒绝操作：${raw}`);
    }
    return abs;
  }

  /**
   * 定位某个标记所属的段落，并区分「标记行」与「正文行」。
   *
   * 关键点：**面板编辑的是正文，不是标记**。标记独占一行时那一行必须留在
   * 原处，否则保存一次就把标记删了、引用直接消失。所以这里把段落再切成
   * `bodyStart..bodyEnd`，写回时只替换这一段。
   *
   * 段落切分与扫描器一致（连续非空行成块）；标记独占一行时归属其后第一个
   * 非空块，没有后块时归属它所在的那一块 —— 不这么对齐，面板改的段落就会
   * 和扫描器算哈希的段落不是同一块，核验永远对不上。
   *
   * @param {string} text 全文。
   * @param {string} entryId 条目 id。
   * @param {number} [line] 指定行（1 基）；省略则取第一个匹配标记。
   * @returns {object|null} 段落信息；找不到返回 null。
   */
  locateParagraph(text, entryId, line) {
    const { lines, paragraphs } = parseDocument(text);
    const rawLines = String(text).split(/\r?\n/);

    /**
     * 这一行剥掉标记与注释外壳后还剩什么。
     *
     * 只做 `stripMarkers` 是不够的：`<!-- canon:D-001@r1 -->` 剥完还剩
     * `<!-- -->`，看着非空，于是标记行会被当成正文行一起替换掉，
     * 保存一次就把标记删了。
     *
     * @param {string} line 原始行。
     * @returns {string} 剩余可见文本。
     */
    const visibleOf = (line) => stripMarkers(line)
      .replace(/<!--/gu, ' ')
      .replace(/-->/gu, ' ')
      .replace(/\{\/\*/gu, ' ')
      .replace(/\*\/\}/gu, ' ')
      .replace(/\/\*/gu, ' ')
      .replace(/\*\//gu, ' ')
      .replace(/\[\[/gu, ' ')
      .replace(/\]\]/gu, ' ')
      .replace(/^\s*\.\.\s+/u, ' ')
      .replace(/^\s*\/\/\s*/u, ' ')
      .trim();

    /** 是否是「只有标记、没有正文」的行。 */
    const isMarkerOnly = (index) => {
      const raw = rawLines[index] ?? '';
      return extractMarkers(lines[index] ?? '').length > 0 && visibleOf(raw) === '';
    };

    /** 找到目标标记所在行（0 基）。 */
    let markerLine = -1;
    if (line !== undefined && line !== null && Number.isFinite(Number(line))) {
      const index = Number(line) - 1;
      if (extractMarkers(lines[index] ?? '').some((marker) => marker.id === entryId)) markerLine = index;
    }
    if (markerLine === -1) {
      for (let i = 0; i < lines.length; i += 1) {
        if (extractMarkers(lines[i]).some((marker) => marker.id === entryId)) {
          markerLine = i;
          break;
        }
      }
    }
    if (markerLine === -1) return null;

    // 与 scanText 相同的归属规则。
    const ownText = stripMarkers(lines[markerLine]).trim();
    const paragraph = ownText === ''
      ? paragraphs.find((item) => item.start > markerLine)
        ?? paragraphs.find((item) => item.start <= markerLine && markerLine <= item.end)
      : paragraphs.find((item) => item.start <= markerLine && markerLine <= item.end);
    if (paragraph === undefined) return null;

    // 正文区 = 段落里第一条与最后一条「非标记独占」行。
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = paragraph.start; i <= paragraph.end; i += 1) {
      if (isMarkerOnly(i)) continue;
      if (bodyStart === -1) bodyStart = i;
      bodyEnd = i;
    }
    if (bodyStart === -1) return null;

    const inline = markerLine >= bodyStart && markerLine <= bodyEnd;
    return {
      start: paragraph.start,
      end: paragraph.end,
      bodyStart,
      bodyEnd,
      markerLine,
      inline,
      lines: rawLines.slice(paragraph.start, paragraph.end + 1),
      text: rawLines.slice(bodyStart, bodyEnd + 1).join('\n'),
      hash: paragraph.hash,
    };
  }

  /**
   * 全库检查（先增量重扫）。
   * @param {object} [options] 选项。
   * @returns {Promise<object>} 报告。
   */
  async check(options = {}) {
    const pinned = options.pinNew === true ? await this.fixPins() : null;
    const result = await this.rescan({ force: options.force === true });
    return { ...result, pinned };
  }

  /**
   * 补钉：只补 rev == 1 的 UNPINNED（唯一版本，无歧义）。
   * @returns {Promise<{files: string[], markers: number, skipped: number}>} 结果。
   */
  async fixPins() {
    await this.ensure();
    const { scan } = await this.rescan();
    const entriesById = new Map(this.store.list().map((entry) => [entry.id, entry]));
    /** @type {Map<string, Array<object>>} */
    const byFile = new Map();
    let skipped = 0;
    for (const ref of scan.refs ?? []) {
      if (ref.pinRev !== null && ref.pinRev !== undefined) continue;
      const entry = entriesById.get(ref.entryId);
      if (entry === undefined) continue;
      if (entry.rev !== 1) {
        skipped += 1;
        continue;
      }
      const list = byFile.get(ref.file) ?? [];
      list.push({ line: ref.line, id: entry.id, rev: entry.rev });
      byFile.set(ref.file, list);
    }
    let markers = 0;
    const touched = [];
    for (const [file, list] of byFile) {
      const abs = path.join(this.cwd, file);
      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      let changed = false;
      for (const item of list) {
        const index = item.line - 1;
        if (index < 0 || index >= lines.length) continue;
        const before = lines[index];
        const after = before.replace(
          new RegExp(`canon:(${escapeRegExp(item.id)})(?!@r)`, 'g'),
          `canon:${item.id}@r${item.rev}`,
        );
        if (after !== before) {
          lines[index] = after;
          markers += 1;
          changed = true;
        }
      }
      if (changed) {
        await fs.writeFile(abs, lines.join('\n'), 'utf8');
        touched.push(file);
        await this.store.appendAudit({
          op: 'pin',
          file,
          markers: list.length,
          actor: { kind: 'cli', pid: process.pid },
          note: 'canon check --fix-pins（仅 rev==1）',
        });
      }
    }
    if (touched.length > 0) await this.rescan({ force: true });
    return { files: touched, markers, skipped };
  }

  /**
   * 批量把某些文件里的标记从 from 改到 to。
   *
   * 默认 dry-run；且**不钉版本**（目标条目 rev 与来源无关，钉数字就是猜）。
   *
   * @param {string} from 来源 id。
   * @param {string} to 目标 id。
   * @param {object} [options] 选项。
   * @returns {Promise<object>} 结果。
   */
  async repoint(from, to, options = {}) {
    await this.ensure();
    await this.store.reload();
    const target = this.store.get(to);
    if (target === null) throw new StoreError(STORE_ERRORS.NOT_FOUND, `目标口径 ${to} 不存在。`);
    const paths = normalizeList(options.paths);
    if (paths.length === 0) throw new StoreError('INVALID_INPUT', '必须用 paths 指定要改的文件（不猜范围）。');
    const apply = options.apply === true;

    const changes = [];
    for (const rel of paths) {
      const normalized = String(rel).replace(/\\/g, '/');
      if (matchesAny(normalized, this.scanConfig.ignoreGlobs)) {
        changes.push({ file: normalized, skipped: true, reason: '在 ignoreGlobs 里' });
        continue;
      }
      const abs = path.join(this.cwd, normalized);
      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        changes.push({ file: normalized, skipped: true, reason: '读不到文件' });
        continue;
      }
      const lines = text.split(/\r?\n/);
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) {
        const before = lines[i];
        const after = before.replace(
          new RegExp(`canon:${escapeRegExp(from)}(?:@r\\d+)?`, 'g'),
          `canon:${to}`,
        );
        if (after !== before) {
          hits.push({ line: i + 1, before: before.trim(), after: after.trim() });
          if (apply) lines[i] = after;
        }
      }
      if (hits.length > 0) {
        changes.push({ file: normalized, hits, applied: apply });
        if (apply) await fs.writeFile(abs, lines.join('\n'), 'utf8');
      }
    }

    const total = changes.reduce((sum, item) => sum + (item.hits?.length ?? 0), 0);
    if (apply && total > 0) {
      await this.store.appendAudit({
        op: 'repoint',
        from,
        to,
        files: changes.filter((item) => item.hits !== undefined).map((item) => item.file),
        markers: total,
        actor: options.actor ?? { kind: 'cli', pid: process.pid },
      });
      await this.rescan({ force: true });
    }
    return { from, to, apply, changes, markers: total };
  }

  /**
   * 统计（试跑指标）。
   * @returns {Promise<object>} 指标。
   */
  async stats() {
    const result = await this.rescan();
    return result.stats;
  }

  /**
   * 把问题渲染成文本（给工具与 CLI 共用）。
   * @param {object} report 报告。
   * @param {object} [options] 选项。
   * @returns {string} 文本。
   */
  renderReport(report, options = {}) {
    const lines = [];
    const stats = report.stats ?? {};
    lines.push(`口径 ${stats.entries ?? 0} 条 / 引用 ${stats.refs ?? 0} 处；已对齐 ${stats.aligned ?? 0}、过期 ${stats.stale ?? 0}、未验证 ${stats.unpinned ?? 0}、悬空 ${stats.dangling ?? 0}`);
    lines.push(`覆盖率 ${(Number(stats.coverage ?? 0) * 100).toFixed(1)}%，盖章率 ${(Number(stats.confirmedRatio ?? 0) * 100).toFixed(1)}%（confirmed ${stats.confirmed ?? 0} / updated ${stats.updated ?? 0}）`);
    if (report.scan?.truncated === true) {
      lines.push('注意：文件数超过上限，扫描不完整。');
    }
    lines.push('');
    lines.push(renderIssues(report.issues ?? [], options));
    if (report.pinned !== null && report.pinned !== undefined) {
      const pinned = report.pinned;
      lines.push('');
      lines.push(`补钉：改了 ${pinned.markers} 个标记（${pinned.files.length} 个文件）；跳过 ${pinned.skipped} 个 rev>1 的未验证标记（需逐处核验）。`);
    }
    return lines.join('\n');
  }
}

/**
 * 转义正则特殊字符。
 * @param {string} text 文本。
 * @returns {string} 转义后文本。
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 统计一组问题的级别分布。
 * @param {Array<object>} issues 问题。
 * @returns {{error: number, warn: number, info: number}} 计数。
 */
function countIssues(issues) {
  const out = { error: 0, warn: 0, info: 0 };
  for (const item of issues) out[item.level] += 1;
  return out;
}

/**
 * 给条目打一个搜索分（用于 canon_list 的 query）。
 * @param {object} entry 条目。
 * @param {string} text 查询词。
 * @returns {number} 分数，0 表示不匹配。
 */
function scoreEntry(entry, text) {
  const needle = text.toLowerCase();
  const fields = [entry.id, entry.title, entry.statement, ...(entry.aliases ?? []), ...(entry.tags ?? [])];
  let score = 0;
  for (const field of fields) {
    const value = String(field ?? '').toLowerCase();
    if (value === '') continue;
    if (value === needle) score += 10;
    else if (value.includes(needle)) score += 4;
  }
  score += similarity(text, `${entry.title} ${entry.statement}`) * 3;
  return score;
}

/**
 * 从工具执行上下文取工作区根目录。
 * @param {object} exec 宿主 execute 的第二参数。
 * @param {string} fallback 兜底目录。
 * @returns {string} 目录。
 */
export function cwdOf(exec, fallback) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* 忽略 */
  }
  return fallback;
}

/**
 * 从工具执行上下文取 actor。
 * @param {object} exec 宿主 execute 的第二参数。
 * @returns {object} actor。
 */
export function actorOf(exec) {
  try {
    const session = exec?.agent?.session;
    const sessionId = session?.header?.id ?? session?.id;
    const name = exec?.agent?.name ?? exec?.agent?.id;
    return {
      kind: 'agent',
      ...(typeof name === 'string' && name !== '' ? { name } : {}),
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    };
  } catch {
    return { kind: 'agent' };
  }
}

/**
 * 从文档文本里取某条目的标记（给 resolve 的错误提示用）。
 * @param {string} text 全文。
 * @param {string} id 条目 id。
 * @returns {Array<{line: number, rev: number|null}>} 标记位置。
 */
export function findMarkers(text, id) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const marker of extractMarkers(lines[i])) {
      if (marker.id === id) out.push({ line: i + 1, rev: marker.rev });
    }
  }
  return out;
}

export { SCAN_DEFAULTS };
