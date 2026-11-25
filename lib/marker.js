/**
 * 标记的识别与生成。
 *
 * 设计要点（见 docs/design.md §4）：
 *   - 标记自带版本 `@rN`，所以「某处是否跟上口径」只看文档本身；
 *   - 按扩展名选注释样式生成，但**识别**对所有已知样式都生效；
 *   - 扫描必须跳过围栏代码块与行内代码，否则文档里讲标记语法的示例会被当成真引用。
 *
 * @module dsh-canon-keeper/marker
 */

/** 扩展名 → 生成样式。 */
export const DEFAULT_MARKER_STYLES = {
  '.md': 'html',
  '.markdown': 'html',
  '.html': 'html',
  '.htm': 'html',
  '.mdx': 'mdx',
  '.rst': 'rst',
  '.adoc': 'adoc',
  '.asciidoc': 'adoc',
  '.txt': 'plain',
};

/** id 的语法：1~3 个字母前缀 + 连字符 + 至少 1 位数字。 */
const ID_SOURCE = '[A-Za-z]{1,3}-\\d{1,6}';

/**
 * 所有样式的识别正则。捕获组 1 = id，捕获组 2 = 可选版本号。
 *
 * 刻意宽松：只要形如 canon:<ID>[@rN] 就算标记，样式本身不限制，
 * 因为混用样式（例如在 .md 里写了 rst 注释）不应该导致漏检。
 */
const MARKER_SOURCE = `canon:(${ID_SOURCE})(?:@r(\\d{1,6}))?`;

/** 单个标记的识别正则（不带 g）。 */
export const MARKER_RE = new RegExp(MARKER_SOURCE);

/** 全局版，用于一行里多个标记。 */
const MARKER_RE_G = new RegExp(MARKER_SOURCE, 'g');

/**
 * 生成标记文本。
 * @param {string} id 条目 id。
 * @param {number} rev 版本号；非正整数时省略 `@rN`。
 * @param {string} [style] 样式（html|mdx|rst|adoc|plain）。
 * @returns {string} 标记文本。
 */
export function renderMarker(id, rev, style = 'html') {
  const pin = Number.isInteger(rev) && rev > 0 ? `@r${rev}` : '';
  const body = `canon:${id}${pin}`;
  switch (style) {
    case 'mdx':
      return `{/* ${body} */}`;
    case 'rst':
      return `.. ${body}`;
    case 'adoc':
      return `// ${body}`;
    case 'plain':
      return `[[${body}]]`;
    case 'html':
    default:
      return `<!-- ${body} -->`;
  }
}

/**
 * 按文件路径选生成样式。
 * @param {string} filePath 文件路径。
 * @param {Record<string, string>} [styles] 扩展名映射。
 * @returns {string} 样式名。
 */
export function styleFor(filePath, styles = DEFAULT_MARKER_STYLES) {
  const path = String(filePath).toLowerCase();
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'html';
  return styles[path.slice(dot)] ?? 'html';
}

/**
 * 判断某行是否处于围栏代码块内部。
 *
 * 返回一个新的状态，调用方逐行推进。围栏长度必须匹配（```` ``` ```` 与 ```` ```` ```` 不算闭合）。
 *
 * @param {string} line 当前行。
 * @param {{fence: string|null, marker: string, length: number}} state 当前状态。
 * @returns {{fence: string|null, marker: string, length: number}} 推进后的状态。
 */
export function advanceFence(line, state) {
  const trimmed = line.trimStart();
  const match = /^(`{3,}|~{3,})/.exec(trimmed);
  if (state.fence === null) {
    if (match === null) return state;
    return { fence: match[1][0], marker: match[1], length: match[1].length };
  }
  if (match === null) return state;
  const sameChar = match[1][0] === state.fence;
  const longEnough = match[1].length >= state.length;
  // 闭合围栏后面不能再跟其它内容（允许尾随空格）。
  const rest = trimmed.slice(match[1].length).trim();
  if (sameChar && longEnough && rest === '') return { fence: null, marker: '', length: 0 };
  return state;
}

/**
 * 把一行里的行内代码替换成等长空白，保持列位置不变。
 * @param {string} line 原始行。
 * @returns {string} 处理后的行。
 */
export function maskInlineCode(line) {
  const chars = [...line];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`') {
      i += 1;
      continue;
    }
    let run = 0;
    while (chars[i + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    const close = line.indexOf(fence, i + run);
    if (close === -1) {
      // 没有配对：把这一串反引号本身抹掉即可，后续内容按普通文本处理。
      for (let k = 0; k < run; k += 1) chars[i + k] = ' ';
      i += run;
      continue;
    }
    for (let k = i; k < close + run; k += 1) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
    i = close + run;
  }
  return chars.join('');
}

/**
 * 从一行文本里抽取所有标记。
 * @param {string} line 已处理过代码块/行内代码的行。
 * @returns {Array<{id: string, rev: number|null, raw: string, bad: boolean}>} 标记列表。
 */
export function extractMarkers(line) {
  const out = [];
  MARKER_RE_G.lastIndex = 0;
  let match;
  while ((match = MARKER_RE_G.exec(line)) !== null) {
    out.push({
      id: match[1],
      rev: match[2] === undefined ? null : Number(match[2]),
      raw: match[0],
      bad: match[2] !== undefined && Number(match[2]) <= 0,
    });
  }
  return out;
}

/**
 * 抽取一行里第一个标记（面板/工具里用于展示「这行钉的是谁」）。
 * @param {string} line 文本行。
 * @returns {{id: string, rev: number|null}|null} 标记。
 */
export function firstMarker(line) {
  const found = extractMarkers(maskInlineCode(line));
  return found.length === 0 ? null : found[0];
}

/**
 * 从文本里剥掉所有标记，用于段落哈希与相似度计算。
 * @param {string} text 文本。
 * @returns {string} 去掉标记后的文本。
 */
export function stripMarkers(text) {
  MARKER_RE_G.lastIndex = 0;
  return String(text).replace(MARKER_RE_G, ' ');
}

/**
 * 判断 id 是否合法。
 * @param {string} id 候选 id。
 * @returns {boolean} 是否合法。
 */
export function isValidId(id) {
  return new RegExp(`^${ID_SOURCE}$`).test(String(id));
}

/**
 * 从 id 取前缀（`D-001` → `D`）。
 * @param {string} id 条目 id。
 * @returns {string} 前缀。
 */
export function prefixOf(id) {
  const dash = String(id).indexOf('-');
  return dash === -1 ? String(id) : String(id).slice(0, dash);
}

/**
 * 从 id 取序号（`D-001` → 1）。
 * @param {string} id 条目 id。
 * @returns {number} 序号；解析失败为 0。
 */
export function seqOf(id) {
  const dash = String(id).indexOf('-');
  if (dash === -1) return 0;
  const value = Number(String(id).slice(dash + 1));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 组装 id。
 * @param {string} prefix 前缀。
 * @param {number} seq 序号。
 * @returns {string} 补零后的 id。
 */
export function makeId(prefix, seq) {
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}
