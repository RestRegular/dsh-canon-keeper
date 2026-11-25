/**
 * 工作区扫描：把文档里的标记抽成引用，并算出段落哈希。
 *
 * 三条要点（见 docs/design.md §4.3、§5.3、§6.1）：
 *   1. 跳过围栏代码块与行内代码 —— 文档里讲标记语法的示例不能被当成真引用；
 *   2. 段落哈希取代 ±60 字窗口 —— 邻近段落编辑不再误报漂移；
 *   3. 同时找「没被标记的表述」（alias 命中但该段落没有对应标记），
 *      因为藏起来的表述恰恰没有标记，只校验已标记位置兜不住。
 *
 * 扫描永远是只读的：不写文档、不补钉（补钉由 §4.4 的显式路径负责）。
 *
 * @module dsh-canon-keeper/scan
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { advanceFence, extractMarkers, maskInlineCode, stripMarkers } from './marker.js';
import { matchesAny, normalizeForHash, normalizeText, sha1Short, snippet } from './util.js';

/** 扫描相关的默认配置。 */
export const SCAN_DEFAULTS = {
  includeExtensions: ['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc'],
  ignoreGlobs: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    'canon/index.json',
    'canon/.lock',
    'canon/audit.jsonl',
    'docs/design.md',
  ],
  historicalGlobs: ['docs/handover/**', '**/CHANGELOG.md', '**/ADR-*/superseded/**'],
  mentionMinLength: { cjk: 2, latin: 4 },
  maxFiles: 2000,
  maxFileBytes: 524288,
  maxMentionsPerAliasPerFile: 3,
};

/**
 * 归一化扫描配置。
 * @param {object} [raw] 原始配置。
 * @returns {typeof SCAN_DEFAULTS} 完整配置。
 */
export function normalizeScanConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const list = (value, fallback) => (Array.isArray(value) && value.length > 0 ? value.map(String) : fallback);
  const int = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
  };
  const min = source.mentionMinLength !== null && typeof source.mentionMinLength === 'object'
    ? source.mentionMinLength
    : {};
  return {
    includeExtensions: list(source.includeExtensions, SCAN_DEFAULTS.includeExtensions),
    ignoreGlobs: list(source.ignoreGlobs, SCAN_DEFAULTS.ignoreGlobs),
    historicalGlobs: list(source.historicalGlobs, SCAN_DEFAULTS.historicalGlobs),
    mentionMinLength: {
      cjk: int(min.cjk, SCAN_DEFAULTS.mentionMinLength.cjk),
      latin: int(min.latin, SCAN_DEFAULTS.mentionMinLength.latin),
    },
    maxFiles: int(source.maxFiles, SCAN_DEFAULTS.maxFiles),
    maxFileBytes: int(source.maxFileBytes, SCAN_DEFAULTS.maxFileBytes),
    maxMentionsPerAliasPerFile: int(
      source.maxMentionsPerAliasPerFile,
      SCAN_DEFAULTS.maxMentionsPerAliasPerFile,
    ),
  };
}

/**
 * 递归列出待扫描文件。
 * @param {string} cwd 工作区根。
 * @param {object} config 扫描配置。
 * @returns {Promise<{files: string[], truncated: boolean}>} 相对路径列表。
 */
export async function listFiles(cwd, config) {
  const extensions = new Set(config.includeExtensions.map((ext) => `.${ext.replace(/^\./, '').toLowerCase()}`));
  const files = [];
  let truncated = false;
  const walk = async (dirAbs, dirRel) => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of entries) {
      const rel = dirRel === '' ? item.name : `${dirRel}/${item.name}`;
      if (matchesAny(rel, config.ignoreGlobs)) continue;
      if (item.isDirectory()) {
        await walk(path.join(dirAbs, item.name), rel);
        if (truncated) return;
        continue;
      }
      if (!item.isFile()) continue;
      const dot = item.name.toLowerCase().lastIndexOf('.');
      if (dot === -1) continue;
      if (!extensions.has(item.name.toLowerCase().slice(dot))) continue;
      if (files.length >= config.maxFiles) {
        truncated = true;
        return;
      }
      files.push(rel);
    }
  };
  await walk(cwd, '');
  return { files, truncated };
}

/**
 * 判断文件是否属于「历史类」（告警降级）。
 * @param {string} relPath 相对路径。
 * @param {string} text 文件全文（用于 front matter）。
 * @param {string[]} historicalGlobs glob 列表。
 * @returns {boolean} 是否历史类。
 */
export function isHistorical(relPath, text, historicalGlobs) {
  if (matchesAny(relPath, historicalGlobs)) return true;
  const head = text.slice(0, 2048);
  return /^---\r?\n[\s\S]*?^canon_historical:\s*true\s*$/m.test(head);
}

/**
 * 把文档切成段落（连续非空行块），并返回每行的可见文本。
 *
 * 返回的 `lines` 里，代码块内的行与围栏行都是空串，行内代码已被等长空白替换。
 *
 * @param {string} text 文件全文。
 * @returns {{lines: string[], paragraphs: Array<{start: number, end: number, text: string, hash: string}>}} 解析结果。
 */
export function parseDocument(text) {
  const rawLines = String(text).split(/\r?\n/);
  const lines = [];
  let state = { fence: null, marker: '', length: 0 };
  for (const line of rawLines) {
    const before = state;
    state = advanceFence(line, before);
    const isFenceLine = state !== before;
    if (before.fence !== null || isFenceLine) {
      lines.push('');
      continue;
    }
    lines.push(maskInlineCode(line));
  }

  const paragraphs = [];
  let start = -1;
  const flush = (end) => {
    if (start === -1) return;
    const chunk = [];
    for (let i = start; i <= end; i += 1) chunk.push(lines[i]);
    const plain = normalizeForHash(stripMarkers(chunk.join('\n')));
    paragraphs.push({
      start,
      end,
      text: plain,
      hash: sha1Short(plain),
    });
    start = -1;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const visible = lines[i].trim();
    if (visible === '') {
      flush(i - 1);
      continue;
    }
    if (start === -1) start = i;
  }
  flush(lines.length - 1);
  return { lines, paragraphs };
}

/**
 * 判断段落文本是否包含某段关键词（CJK 直接子串，拉丁忽略大小写）。
 * @param {string} haystack 段落文本（已归一化）。
 * @param {string} needle 关键词。
 * @returns {boolean} 是否命中。
 */
export function containsPhrase(haystack, needle) {
  const phrase = normalizeForHash(needle);
  if (phrase === '') return false;
  return haystack.includes(phrase);
}

/**
 * 判断关键词长度是否达到报告门槛。
 * @param {string} phrase 关键词。
 * @param {{cjk: number, latin: number}} min 门槛。
 * @returns {boolean} 是否够长。
 */
export function longEnough(phrase, min) {
  const cjk = (phrase.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const latin = (phrase.match(/[A-Za-z0-9]/g) ?? []).length;
  return cjk >= min.cjk || latin >= min.latin;
}

/**
 * 扫描单个文件，产出引用与命中。
 * @param {string} relPath 相对路径。
 * @param {string} text 全文。
 * @param {object} options 选项。
 * @returns {{refs: Array<object>, mentions: Array<object>, resurrected: Array<object>}} 结果。
 */
export function scanText(relPath, text, options) {
  const { entriesById, aliases, deprecated, config, historical } = options;
  const { lines, paragraphs } = parseDocument(text);
  const refs = [];
  const mentions = [];
  const resurrected = [];

  /** 每行上的标记。 */
  const lineMarkers = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const found = extractMarkers(lines[i]);
    if (found.length === 0) continue;
    lineMarkers.set(i, found);
    for (const marker of found) {
      const ownText = stripMarkers(lines[i]).trim();
      let paragraph = null;
      if (ownText === '') {
        // 标记独占一行：归属其后的第一个非空块。
        paragraph = paragraphs.find((item) => item.start > i) ?? null;
      } else {
        paragraph = paragraphs.find((item) => item.start <= i && i <= item.end) ?? null;
      }
      refs.push({
        entryId: marker.id,
        file: relPath,
        line: i + 1,
        pinRev: marker.rev,
        badMarker: marker.bad,
        paragraphHash: paragraph?.hash ?? '',
        paragraphText: paragraph?.text ?? '',
        style: 'scanned',
        historical,
        snippet: snippet(paragraph?.text ?? lines[i]),
      });
    }
  }

  /** 该段落里已标记的条目 id。 */
  const markedInParagraph = (paragraph) => {
    const set = new Set();
    if (paragraph === null) return set;
    for (let i = paragraph.start; i <= paragraph.end; i += 1) {
      for (const marker of lineMarkers.get(i) ?? []) set.add(marker.id);
    }
    return set;
  };

  const perAliasCount = new Map();
  for (const paragraph of paragraphs) {
    const marked = markedInParagraph(paragraph);
    for (const item of aliases) {
      if (!containsPhrase(paragraph.text, item.alias)) continue;
      if (marked.has(item.entryId)) continue;
      if (!longEnough(item.alias, config.mentionMinLength)) continue;
      const key = `${item.entryId}\u0000${item.alias}`;
      const count = perAliasCount.get(key) ?? 0;
      if (count >= config.maxMentionsPerAliasPerFile) continue;
      perAliasCount.set(key, count + 1);
      mentions.push({
        entryId: item.entryId,
        alias: item.alias,
        file: relPath,
        line: paragraph.start + 1,
        paragraphHash: paragraph.hash,
        snippet: snippet(paragraph.text),
        historical,
      });
    }
    for (const item of deprecated) {
      if (!containsPhrase(paragraph.text, item.text)) continue;
      if (!longEnough(item.text, config.mentionMinLength)) continue;
      const key = `${item.entryId}\u0000${item.text}`;
      const count = perAliasCount.get(key) ?? 0;
      if (count >= config.maxMentionsPerAliasPerFile) continue;
      perAliasCount.set(key, count + 1);
      resurrected.push({
        entryId: item.entryId,
        phrase: item.text,
        file: relPath,
        line: paragraph.start + 1,
        paragraphHash: paragraph.hash,
        snippet: snippet(paragraph.text),
        historical,
      });
    }
  }

  // 条目已不存在的标记也算一条 ref，由规则层报 DANGLING。
  void entriesById;
  return { refs, mentions, resurrected };
}

/**
 * 扫描整个工作区。
 * @param {object} options 选项。
 * @param {string} options.cwd 工作区根。
 * @param {Array<object>} options.entries 全部条目。
 * @param {object} options.config 扫描配置。
 * @param {object|null} [options.previous] 上一次的索引（用于增量）。
 * @param {string[]} [options.onlyFiles] 只扫这些相对路径（resolve 用）。
 * @returns {Promise<object>} 扫描结果。
 */
export async function scanWorkspace(options) {
  const { cwd, entries, config, previous = null, onlyFiles = null } = options;
  const started = Date.now();

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const aliases = [];
  const deprecated = [];
  for (const entry of entries) {
    if (entry.supersededBy) continue;
    for (const alias of entry.aliases ?? []) aliases.push({ entryId: entry.id, alias });
    for (const item of entry.deprecatedPhrases ?? []) deprecated.push({ entryId: entry.id, text: item.text });
  }

  const historicalGlobs = config.historicalGlobs;
  // scanFromIndex 交回的是 fileCache；直接吃原始 index 时字段名是 files。
  const cache = previous?.fileCache ?? previous?.files ?? {};

  // 缓存命中的条件不只是「文件没变」，还包括「口径集合没变」。
  //
  // refs 只依赖文件内容，但 mentions / resurrected 依赖 aliases 与 deprecatedPhrases：
  // 新登记一条口径后，所有老文件里本来就有、但当时没人在意的提法，现在应该变成
  // UNMARKED_MENTION。只看 mtime 会把这些命中整片漏掉，而漏掉的恰恰是
  // 「藏起来的表述」—— 这个插件最该发现的东西。
  //
  // 所以把口径指纹并进缓存戳：口径一改，全部文件重扫。
  const entriesStamp = sha1Short(JSON.stringify(entries
    .map((entry) => [
      entry.id,
      entry.rev,
      entry.supersededBy ?? null,
      entry.aliases ?? [],
      (entry.deprecatedPhrases ?? []).map((item) => item.text),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));

  let files;
  let truncated = false;
  if (onlyFiles === null) {
    const listed = await listFiles(cwd, config);
    files = listed.files;
    truncated = listed.truncated;
  } else {
    files = onlyFiles.map((item) => String(item).replace(/\\/g, '/'));
  }

  const refs = [];
  const mentions = [];
  const resurrected = [];
  const nextFiles = {};
  let scanned = 0;

  // 局部重扫（resolve 用）必须把未触及的文件原样搬进结果，
  // 否则上层会用这份残缺结果覆盖 index.json，缓存整片丢失。
  if (onlyFiles !== null) {
    const touched = new Set(files);
    for (const [rel, record] of Object.entries(cache)) {
      if (touched.has(rel)) continue;
      nextFiles[rel] = record;
      refs.push(...(record.refs ?? []));
      mentions.push(...(record.mentions ?? []));
      resurrected.push(...(record.resurrected ?? []));
    }
  }

  for (const rel of files) {
    const abs = path.join(cwd, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > config.maxFileBytes) continue;
    const stamp = `${stat.mtimeMs}:${stat.size}:${entriesStamp}`;
    const cached = cache[rel];
    // 局部重扫必须真读：调用方刚改过这些文件，mtime 精度不足时会误判为未变。
    if (onlyFiles === null && cached !== undefined && cached.stamp === stamp) {
      nextFiles[rel] = cached;
      refs.push(...cached.refs);
      mentions.push(...cached.mentions);
      resurrected.push(...cached.resurrected);
      continue;
    }
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const historical = isHistorical(rel, text, historicalGlobs);
    const result = scanText(rel, text, {
      entriesById,
      aliases,
      deprecated,
      config,
      historical,
    });
    scanned += 1;
    nextFiles[rel] = { stamp, refs: result.refs, mentions: result.mentions, resurrected: result.resurrected };
    refs.push(...result.refs);
    mentions.push(...result.mentions);
    resurrected.push(...result.resurrected);
  }

  // 全量扫描时 nextFiles 只含现存文件，被删掉的自然不会留在缓存里；
  // 局部重扫时 nextFiles 已经是「未触及的缓存 + 本次重扫」的合并结果，无需再删。

  return {
    at: Date.now(),
    files: Object.keys(nextFiles).length,
    scanned,
    truncated,
    durationMs: Date.now() - started,
    refs,
    mentions,
    resurrected,
    fileCache: nextFiles,
  };
}

/**
 * 组装可写入 index.json 的结构。
 * @param {object} scan 扫描结果。
 * @param {object} baselines 基线表。
 * @param {object} stats 统计。
 * @returns {object} 索引。
 */
export function buildIndex(scan, baselines, stats) {
  return {
    version: 1,
    scan: {
      at: scan.at,
      files: scan.files,
      scanned: scan.scanned,
      markers: scan.refs.length,
      durationMs: scan.durationMs,
      complete: !scan.truncated,
    },
    refs: scan.refs,
    mentions: scan.mentions,
    resurrected: scan.resurrected,
    baselines,
    stats,
    files: scan.fileCache,
  };
}

/**
 * 从索引里取回扫描结果（用于增量）。
 * @param {object|null} index 索引。
 * @returns {object|null} 扫描结果形态。
 */
export function scanFromIndex(index) {
  if (index === null || index === undefined) return null;
  return {
    at: index.scan?.at ?? 0,
    files: index.scan?.files ?? 0,
    truncated: index.scan?.complete === false,
    durationMs: index.scan?.durationMs ?? 0,
    refs: Array.isArray(index.refs) ? index.refs : [],
    mentions: Array.isArray(index.mentions) ? index.mentions : [],
    resurrected: Array.isArray(index.resurrected) ? index.resurrected : [],
    fileCache: index.files ?? {},
  };
}

/**
 * 判断一个段落是否为空（用于展示）。
 * @param {string} text 文本。
 * @returns {boolean} 是否为空。
 */
export function isBlank(text) {
  return normalizeText(text) === '';
}
