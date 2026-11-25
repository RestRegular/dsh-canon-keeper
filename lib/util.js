/**
 * 通用工具：哈希、归一化、glob 匹配、相似度。
 *
 * 全部是纯函数，不碰文件系统，方便在测试里直接验证。
 *
 * @module dsh-canon-keeper/util
 */

import { createHash } from 'node:crypto';

/**
 * 取 sha1 前 8 位十六进制。
 * @param {string} text 输入。
 * @returns {string} 8 位摘要。
 */
export function sha1Short(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 8);
}

/**
 * 折叠空白并去首尾。
 * @param {string} text 输入。
 * @returns {string} 归一化文本。
 */
export function normalizeText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * 哈希用的归一化：折叠空白 + 拉丁小写（CJK 不受影响）。
 * @param {string} text 输入。
 * @returns {string} 归一化文本。
 */
export function normalizeForHash(text) {
  return normalizeText(text).toLowerCase();
}

/**
 * 把 glob 转成正则。支持 `**`、`*`、`?`。
 * @param {string} glob glob 表达式。
 * @returns {RegExp} 锚定到整条路径的正则。
 */
export function globToRegExp(glob) {
  const source = String(glob).replace(/\\/g, '/');
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '*') {
      if (source[i + 1] === '*') {
        i += 2;
        if (source[i] === '/') {
          out += '(?:.*/)?';
          i += 1;
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * 判断相对路径是否命中任一 glob。
 *
 * 不含 `/` 且不含通配符的 glob 视为目录前缀（`node_modules` 匹配整棵子树）。
 *
 * @param {string} relPath 工作区相对路径（正斜杠）。
 * @param {readonly string[]} globs glob 列表。
 * @returns {boolean} 是否命中。
 */
export function matchesAny(relPath, globs) {
  const target = String(relPath).replace(/\\/g, '/');
  for (const glob of globs ?? []) {
    const pattern = String(glob).replace(/\\/g, '/');
    if (!pattern.includes('/') && !/[*?]/.test(pattern)) {
      if (target === pattern || target.startsWith(`${pattern}/`)) return true;
      continue;
    }
    if (globToRegExp(pattern).test(target)) return true;
  }
  return false;
}

/**
 * 文本的三元组集合。
 * @param {string} text 输入。
 * @returns {Set<string>} 三元组。
 */
function trigrams(text) {
  const source = ` ${normalizeForHash(text)} `;
  const set = new Set();
  for (let i = 0; i + 3 <= source.length; i += 1) set.add(source.slice(i, i + 3));
  return set;
}

/**
 * 两段文本的 trigram 相似度（0~1）。
 * @param {string} a 文本 a。
 * @param {string} b 文本 b。
 * @returns {number} 相似度。
 */
export function similarity(a, b) {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

/**
 * 截取片段用于展示。
 * @param {string} text 文本。
 * @param {number} [limit] 最大长度。
 * @returns {string} 片段。
 */
export function snippet(text, limit = 120) {
  const flat = normalizeText(text);
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

/**
 * 毫秒睡眠。
 * @param {number} ms 毫秒。
 * @returns {Promise<void>} 完成。
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 把条目归一化成可比对的指纹（id + statement）。
 * @param {{id: string, statement: string}} entry 条目。
 * @returns {string} 8 位指纹。
 */
export function fingerprintOf(entry) {
  return sha1Short(`${entry.id}\n${normalizeForHash(entry.statement ?? '')}`);
}
