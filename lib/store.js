/**
 * 口径存储：每条口径一个文件 + 追加式审计 + 可删的派生索引。
 *
 * 三条硬约束（见 docs/design.md §3、§11）：
 *   1. 权威数据分文件 —— 多分支各自登记会在 git 层显式冲突，而不是静默撞号；
 *   2. 坏档一律拒绝写入 —— 绝不「改名后从空库起」，否则全部标记变 DANGLING 且 id 会被复用；
 *   3. 写操作持跨进程锁 + 乐观并发校验 —— 同进程互斥不够，多会话/CLI 各开进程会丢更新。
 *
 * @module dsh-canon-keeper/store
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprintOf, normalizeForHash, sha1Short } from './util.js';
import { makeId, prefixOf, seqOf } from './marker.js';

/** kind → id 前缀。 */
export const KIND_PREFIX = {
  decision: 'D',
  rule: 'R',
  value: 'V',
  term: 'T',
  fact: 'F',
};

/** 合法 kind 列表。 */
export const KINDS = Object.keys(KIND_PREFIX);

/** 存储层错误码。 */
export const STORE_ERRORS = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_KIND: 'INVALID_KIND',
  EMPTY_STATEMENT: 'EMPTY_STATEMENT',
  EMPTY_TITLE: 'EMPTY_TITLE',
  INVALID_CHANGE: 'INVALID_CHANGE',
  CONFLICT: 'CONFLICT',
  STORE_UNREADABLE: 'STORE_UNREADABLE',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  DUPLICATE_ID: 'DUPLICATE_ID',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
};

/**
 * 存储错误。
 */
export class StoreError extends Error {
  /**
   * @param {string} code 错误码。
   * @param {string} message 说明。
   * @param {object} [detail] 附加信息。
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 剥掉 UTF-8 BOM。
 *
 * Windows 上用 PowerShell 的 `Set-Content -Encoding UTF8`、记事本另存等路径写出来的
 * JSON 会带 BOM，而 `JSON.parse` 遇到 BOM 直接抛错。把这种文件当成「坏档」会误伤
 * —— 内容其实完好。这里只在解析前剥掉，写回时仍不带 BOM。
 *
 * @param {string} text 文本。
 * @returns {string} 去掉 BOM 的文本。
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 内容哈希。
 * @param {string} text 文本。
 * @returns {string} sha1 全量十六进制。
 */
function contentHashOf(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * 归一化 kind。
 * @param {unknown} kind 输入。
 * @returns {string} 合法 kind 或空串。
 */
function normalizeKind(kind) {
  const value = String(kind ?? '').trim().toLowerCase();
  return KINDS.includes(value) ? value : '';
}

/**
 * 归一化字符串数组。
 * @param {unknown} value 输入。
 * @returns {string[]} 去重后的非空字符串。
 */
export function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 默认存储目录（工作区相对 `canon`）。
 * @param {string} cwd 工作区根目录。
 * @returns {string} 绝对路径。
 */
export function defaultStoreDir(cwd) {
  return path.join(cwd, 'canon');
}

/**
 * 口径存储。
 */
export class CanonStore {
  /**
   * @param {{dir: string, logger?: object, lockTimeoutMs?: number}} options 选项。
   */
  constructor(options) {
    this.dir = options.dir;
    this.entriesDir = path.join(this.dir, 'entries');
    this.auditPath = path.join(this.dir, 'audit.jsonl');
    this.indexPath = path.join(this.dir, 'index.json');
    this.lockPath = path.join(this.dir, '.lock');
    this.logger = options.logger;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    /** @type {Map<string, {entry: object, hash: string, file: string}>} */
    this.cache = new Map();
    /** 无法解析的文件（存在即拒绝写入）。 */
    this.broken = [];
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  /**
   * 确保目录存在并首次加载。
   * @returns {Promise<void>} 完成。
   */
  async init() {
    await fs.mkdir(this.entriesDir, { recursive: true });
    await this.reload();
  }

  /**
   * 重新读取全部条目文件。
   * @returns {Promise<void>} 完成。
   */
  async reload() {
    const next = new Map();
    const broken = [];
    let names;
    try {
      names = await fs.readdir(this.entriesDir);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.cache = next;
        this.broken = broken;
        this.loaded = true;
        return;
      }
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.entriesDir, name);
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (error) {
        broken.push({ file, reason: `读取失败：${error?.message ?? error}` });
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(stripBom(text));
      } catch (error) {
        broken.push({ file, reason: `JSON 解析失败：${error?.message ?? error}` });
        continue;
      }
      const problem = validateEntryShape(entry);
      if (problem !== null) {
        broken.push({ file, reason: problem });
        continue;
      }
      const id = entry.id;
      if (next.has(id)) {
        // 同 id 出现在多个文件：保留两份，交给规则层报 DUPLICATE_ID。
        const existing = next.get(id);
        existing.duplicates = existing.duplicates ?? [];
        existing.duplicates.push({ file, entry, hash: contentHashOf(text) });
        continue;
      }
      next.set(id, { entry, hash: contentHashOf(text), file });
    }
    this.cache = next;
    this.broken = broken;
    this.loaded = true;
  }

  /**
   * 存储是否可写（有坏档即不可写）。
   * @returns {{ok: boolean, broken: Array<object>}} 可写性。
   */
  writable() {
    return { ok: this.broken.length === 0, broken: this.broken };
  }

  /**
   * 断言可写。
   * @returns {void}
   */
  assertWritable() {
    if (this.broken.length > 0) {
      throw new StoreError(
        STORE_ERRORS.STORE_UNREADABLE,
        `口径存储有 ${this.broken.length} 个文件无法解析，拒绝写入（避免 id 复用）：${this.broken
          .map((item) => item.file)
          .join(', ')}。请从 git 恢复或手工修复后重试。`,
        { broken: this.broken },
      );
    }
  }

  /**
   * 列出全部条目（含重复项信息）。
   * @returns {Array<object>} 条目列表（按 id 排序）。
   */
  list() {
    const out = [];
    for (const record of this.cache.values()) {
      out.push({ ...record.entry, file: record.file, duplicates: record.duplicates ?? [] });
    }
    out.sort((a, b) => compareId(a.id, b.id));
    return out;
  }

  /**
   * 取一条。
   * @param {string} id 条目 id。
   * @returns {object|null} 条目。
   */
  get(id) {
    const record = this.cache.get(String(id));
    if (record === undefined) return null;
    return { ...record.entry, file: record.file, duplicates: record.duplicates ?? [] };
  }

  /**
   * 分配下一个 id。
   * @param {string} prefix 前缀。
   * @returns {string} id。
   */
  nextId(prefix) {
    let max = 0;
    for (const record of this.cache.values()) {
      const id = record.entry.id;
      if (prefixOf(id) !== prefix) continue;
      max = Math.max(max, seqOf(id));
    }
    return makeId(prefix, max + 1);
  }

  /**
   * 串行执行一个写操作（进程内互斥）。
   * @template T
   * @param {() => Promise<T>} task 任务。
   * @returns {Promise<T>} 结果。
   */
  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 抢跨进程锁并执行。
   * @template T
   * @param {() => Promise<T>} task 任务。
   * @returns {Promise<T>} 结果。
   */
  async withLock(task) {
    await fs.mkdir(this.dir, { recursive: true });
    const started = Date.now();
    let handle = null;
    while (handle === null) {
      try {
        handle = await fs.open(this.lockPath, 'wx');
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const stale = await this.isStaleLock();
        if (stale) {
          await fs.rm(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() - started > this.lockTimeoutMs) {
          throw new StoreError(
            STORE_ERRORS.LOCK_TIMEOUT,
            `等待口径写锁超时（${this.lockTimeoutMs}ms）。若确认没有其它进程在写，删除 ${this.lockPath} 后重试。`,
          );
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return await task();
    } finally {
      try {
        await handle.close();
      } catch {
        /* 已关闭 */
      }
      await fs.rm(this.lockPath, { force: true });
    }
  }

  /**
   * 判断残留锁是否过期。
   * @returns {Promise<boolean>} 是否可接管。
   */
  async isStaleLock() {
    try {
      const stat = await fs.stat(this.lockPath);
      return Date.now() - stat.mtimeMs > this.lockTimeoutMs;
    } catch {
      return true;
    }
  }

  /**
   * 原子写文件。
   * @param {string} file 目标路径。
   * @param {string} text 内容。
   * @returns {Promise<void>} 完成。
   */
  async writeAtomic(file, text) {
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, file);
  }

  /**
   * 新增条目。
   * @param {object} input 输入。
   * @param {string} input.kind 类型。
   * @param {string} input.title 标题。
   * @param {string} input.statement 正文。
   * @param {string[]} [input.aliases] 定位词。
   * @param {string[]} [input.tags] 标签。
   * @param {object} [input.actor] 操作者。
   * @param {string} [input.note] 备注。
   * @returns {Promise<object>} 新条目。
   */
  async add(input) {
    return this.serialize(() => this.withLock(async () => {
      this.assertWritable();
      await this.reload();
      this.assertWritable();
      const kind = normalizeKind(input?.kind);
      if (kind === '') {
        throw new StoreError(STORE_ERRORS.INVALID_KIND, `kind 只能是 ${KINDS.join(' / ')}。`);
      }
      const statement = String(input?.statement ?? '').trim();
      if (statement === '') throw new StoreError(STORE_ERRORS.EMPTY_STATEMENT, 'statement 不能为空。');
      const title = String(input?.title ?? '').trim() || statement.slice(0, 40);
      const prefix = KIND_PREFIX[kind];
      const now = Date.now();
      let attempt = 0;
      for (;;) {
        const id = this.nextId(prefix);
        const entry = {
          id,
          kind,
          title,
          statement,
          aliases: normalizeList(input?.aliases),
          deprecatedPhrases: [],
          tags: normalizeList(input?.tags),
          rev: 1,
          supersededBy: null,
          createdAt: now,
          updatedAt: now,
          history: [{
            seq: 1,
            rev: 1,
            change: 'semantic',
            at: now,
            actor: normalizeActor(input?.actor),
            note: String(input?.note ?? '初始登记'),
            statement,
            aliases: normalizeList(input?.aliases),
          }],
        };
        const file = path.join(this.entriesDir, `${id}.json`);
        try {
          const handle = await fs.open(file, 'wx');
          try {
            await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`, 'utf8');
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (error?.code === 'EEXIST') {
            attempt += 1;
            if (attempt > 20) throw new StoreError(STORE_ERRORS.ALREADY_EXISTS, `无法分配 ${prefix} 前缀的新 id。`);
            await this.reload();
            continue;
          }
          throw error;
        }
        this.cache.set(id, { entry, hash: contentHashOf(`${JSON.stringify(entry, null, 2)}\n`), file });
        await this.appendAudit({
          op: 'add',
          entryId: id,
          fingerprint: fingerprintOf(entry),
          actor: normalizeActor(input?.actor),
          note: entry.history[0].note,
        });
        return entry;
      }
    }));
  }

  /**
   * 更新条目。
   * @param {string} id 条目 id。
   * @param {object} patch 改动。
   * @param {object} meta 元信息。
   * @returns {Promise<{entry: object, revChanged: boolean, deprecatedAdded: string[]}>} 结果。
   */
  async update(id, patch, meta = {}) {
    return this.serialize(() => this.withLock(async () => {
      this.assertWritable();
      await this.reload();
      this.assertWritable();
      const record = this.cache.get(String(id));
      if (record === undefined) throw new StoreError(STORE_ERRORS.NOT_FOUND, `没有找到口径 ${id}。`);
      const change = String(meta.change ?? 'semantic').toLowerCase();
      if (change !== 'semantic' && change !== 'wording') {
        throw new StoreError(STORE_ERRORS.INVALID_CHANGE, 'change 只能是 semantic 或 wording。');
      }
      const before = record.entry;
      const next = { ...before, history: [...before.history] };
      let touched = false;

      if (patch?.statement !== undefined) {
        const statement = String(patch.statement).trim();
        if (statement === '') throw new StoreError(STORE_ERRORS.EMPTY_STATEMENT, 'statement 不能为空。');
        if (statement !== before.statement) {
          next.statement = statement;
          touched = true;
        }
      }
      if (patch?.title !== undefined) {
        const title = String(patch.title).trim();
        if (title !== '' && title !== before.title) {
          next.title = title;
          touched = true;
        }
      }
      if (patch?.aliases !== undefined) {
        const aliases = normalizeList(patch.aliases);
        if (JSON.stringify(aliases) !== JSON.stringify(before.aliases)) {
          next.aliases = aliases;
          touched = true;
        }
      }
      if (patch?.tags !== undefined) {
        const tags = normalizeList(patch.tags);
        if (JSON.stringify(tags) !== JSON.stringify(before.tags)) {
          next.tags = tags;
          touched = true;
        }
      }
      const explicitDeprecated = normalizeList(patch?.addDeprecated);
      if (explicitDeprecated.length > 0) touched = true;
      if (!touched) {
        return { entry: before, revChanged: false, deprecatedAdded: [] };
      }

      const now = Date.now();
      const deprecatedAdded = [];
      if (change === 'semantic') {
        next.rev = before.rev + 1;
        if (explicitDeprecated.length === 0 && meta.learnDeprecated !== false) {
          const kept = new Set(next.aliases ?? []);
          for (const alias of before.aliases ?? []) {
            if (!kept.has(alias)) deprecatedAdded.push(alias);
          }
        }
      }
      for (const phrase of explicitDeprecated) {
        if (!deprecatedAdded.includes(phrase)) deprecatedAdded.push(phrase);
      }
      if (deprecatedAdded.length > 0) {
        const existing = new Map((before.deprecatedPhrases ?? []).map((item) => [item.text, item]));
        for (const phrase of deprecatedAdded) {
          existing.set(phrase, { text: phrase, retiredAtRev: next.rev });
        }
        next.deprecatedPhrases = [...existing.values()];
      }
      const seq = (before.history.at(-1)?.seq ?? 0) + 1;
      next.updatedAt = now;
      next.history = [...before.history, {
        seq,
        rev: next.rev,
        change,
        at: now,
        actor: normalizeActor(meta.actor),
        note: String(meta.note ?? (change === 'semantic' ? '语义改动' : '措辞修订')),
        statement: next.statement,
        aliases: next.aliases,
      }];

      await this.persist(next, record.file);
      this.cache.set(next.id, { entry: next, hash: contentHashOf(`${JSON.stringify(next, null, 2)}\n`), file: record.file });
      await this.appendAudit({
        op: 'update',
        entryId: next.id,
        fromRev: before.rev,
        toRev: next.rev,
        change,
        deprecatedAdded,
        actor: normalizeActor(meta.actor),
        note: String(meta.note ?? ''),
      });
      return { entry: next, revChanged: change === 'semantic', deprecatedAdded };
    }));
  }

  /**
   * 归档条目。
   * @param {string} id 条目 id。
   * @param {object} meta 元信息。
   * @returns {Promise<object>} 归档后的条目。
   */
  async archive(id, meta = {}) {
    return this.serialize(() => this.withLock(async () => {
      this.assertWritable();
      await this.reload();
      this.assertWritable();
      const record = this.cache.get(String(id));
      if (record === undefined) throw new StoreError(STORE_ERRORS.NOT_FOUND, `没有找到口径 ${id}。`);
      const before = record.entry;
      const supersededBy = meta.supersededBy === undefined || meta.supersededBy === null || meta.supersededBy === ''
        ? before.supersededBy ?? null
        : String(meta.supersededBy);
      if (supersededBy !== null && supersededBy === before.id) {
        throw new StoreError(STORE_ERRORS.ALREADY_EXISTS, 'supersededBy 不能指向自己。');
      }
      if (supersededBy !== null && !this.cache.has(supersededBy)) {
        throw new StoreError(STORE_ERRORS.NOT_FOUND, `supersededBy 指向的 ${supersededBy} 不存在。`);
      }
      if (before.supersededBy === supersededBy) {
        return before;
      }
      const now = Date.now();
      const next = {
        ...before,
        supersededBy,
        updatedAt: now,
        history: [...before.history, {
          seq: (before.history.at(-1)?.seq ?? 0) + 1,
          rev: before.rev,
          change: 'archive',
          at: now,
          actor: normalizeActor(meta.actor),
          note: String(meta.note ?? (supersededBy === null ? '取消归档' : `由 ${supersededBy} 取代`)),
          statement: before.statement,
          aliases: before.aliases,
        }],
      };
      await this.persist(next, record.file);
      this.cache.set(next.id, { entry: next, hash: contentHashOf(`${JSON.stringify(next, null, 2)}\n`), file: record.file });
      await this.appendAudit({
        op: 'archive',
        entryId: next.id,
        supersededBy,
        actor: normalizeActor(meta.actor),
        note: String(meta.note ?? ''),
      });
      return next;
    }));
  }

  /**
   * 写条目文件。
   * @param {object} entry 条目。
   * @param {string} file 目标文件。
   * @returns {Promise<void>} 完成。
   */
  async persist(entry, file) {
    await this.writeAtomic(file, `${JSON.stringify(entry, null, 2)}\n`);
  }

  /**
   * 追加审计事件。
   * @param {object} event 事件。
   * @returns {Promise<void>} 完成。
   */
  async appendAudit(event) {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const line = `${JSON.stringify({ at: Date.now(), ...event })}\n`;
      await fs.appendFile(this.auditPath, line, 'utf8');
    } catch (error) {
      this.logger?.warn?.(`[dsh-canon-keeper] audit append failed: ${error?.message ?? error}`);
      throw new StoreError('AUDIT_FAILED', `审计写入失败：${error?.message ?? error}`);
    }
  }

  /**
   * 读审计事件。
   * @returns {Promise<Array<object>>} 事件列表（坏行跳过）。
   */
  async readAudit() {
    let text;
    try {
      text = await fs.readFile(this.auditPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* merge=union 之后可能出现半行，跳过即可 */
      }
    }
    return out;
  }

  /**
   * 读派生索引。
   * @returns {Promise<object|null>} 索引或 null。
   */
  async readIndex() {
    try {
      const text = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') return null;
      if (parsed.version !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 写派生索引（失败不致命）。
   * @param {object} index 索引。
   * @returns {Promise<void>} 完成。
   */
  async writeIndex(index) {
    try {
      await this.writeAtomic(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`[dsh-canon-keeper] index write failed: ${error?.message ?? error}`);
    }
  }

  /**
   * 给一组文本算基线（供 resolve 验证用）。
   * @param {string} id 条目 id。
   * @param {string} file 文件。
   * @param {number} rev 版本。
   * @param {string} paragraphHash 段落哈希。
   * @returns {string} 基线键。
   */
  static baselineKey(id, file) {
    return `${id}|${String(file).replace(/\\/g, '/')}`;
  }
}

/**
 * 归一化 actor。
 * @param {unknown} actor 输入。
 * @returns {object} actor。
 */
export function normalizeActor(actor) {
  if (actor === null || typeof actor !== 'object') return { kind: 'unknown' };
  const kind = ['agent', 'user', 'cli', 'unknown'].includes(actor.kind) ? actor.kind : 'unknown';
  const out = { kind };
  if (typeof actor.name === 'string' && actor.name !== '') out.name = actor.name;
  if (typeof actor.sessionId === 'string' && actor.sessionId !== '') out.sessionId = actor.sessionId;
  if (typeof actor.pid === 'number') out.pid = actor.pid;
  if (typeof actor.host === 'string' && actor.host !== '') out.host = actor.host;
  return out;
}

/**
 * 校验条目结构。
 * @param {unknown} entry 条目。
 * @returns {string|null} 问题描述，合法时为 null。
 */
export function validateEntryShape(entry) {
  if (entry === null || typeof entry !== 'object') return '不是对象';
  if (typeof entry.id !== 'string' || entry.id === '') return '缺少 id';
  if (!KINDS.includes(entry.kind)) return `kind 非法（${String(entry.kind)}）`;
  if (typeof entry.statement !== 'string' || entry.statement.trim() === '') return 'statement 为空';
  if (!Number.isInteger(entry.rev) || entry.rev < 1) return `rev 非法（${String(entry.rev)}）`;
  if (!Array.isArray(entry.history) || entry.history.length === 0) return 'history 为空';
  return null;
}

/**
 * 比较两个 id（先比前缀，再比序号）。
 * @param {string} a id a。
 * @param {string} b id b。
 * @returns {number} 排序值。
 */
export function compareId(a, b) {
  const pa = prefixOf(a);
  const pb = prefixOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return seqOf(a) - seqOf(b);
}

/**
 * 计算语句指纹（导出给规则层复用）。
 * @param {object} entry 条目。
 * @returns {string} 指纹。
 */
export function entryFingerprint(entry) {
  return sha1Short(`${entry.id}\n${normalizeForHash(entry.statement ?? '')}`);
}
