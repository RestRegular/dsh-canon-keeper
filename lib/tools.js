/**
 * Agent 侧工具：口径的登记、查询、核验。
 *
 * 工具只做参数校验与文本渲染，真正的存储与规则计算都在 ops 里，
 * 与 CLI、面板共用同一条实现路径。
 *
 * 标记语法只写在 canon_add 与 canon_update 的 description 里（其它工具一句话带过），
 * 避免同一份规则在七个工具里各说一遍。
 *
 * @module dsh-canon-keeper/tools
 */

import { actorOf, cwdOf } from './ops.js';
import { renderMarker, styleFor } from './marker.js';

/** 工具名。 */
export const TOOL_NAMES = {
  list: 'canon_list',
  get: 'canon_get',
  add: 'canon_add',
  update: 'canon_update',
  archive: 'canon_archive',
  resolve: 'canon_resolve',
  check: 'canon_check',
};

/** 单次列出的上限。 */
const MAX_LIST_ROWS = 60;

/** 单次影响清单上限。 */
const MAX_IMPACT_ROWS = 40;

/** 标记语法的统一说明（只在 add/update 里出现）。 */
const MARKER_DOC = [
  '写进文档时用标记把表述钉到口径版本，标记随文档走、自带版本号：',
  'Markdown/HTML 用 `<!-- canon:D-001@r3 -->`，MDX 用 `{/* canon:D-001@r3 */}`，reStructuredText 用 `.. canon:D-001@r3`，AsciiDoc 用 `// canon:D-001@r3`，纯文本用 `[[canon:D-001@r3]]`。',
  '标记放在它所约束的那一段里（独占一行时归属其后第一个非空段落）。省略 `@rN` 表示未验证：不计入覆盖率，`canon_check` 会一直报 UNPINNED。',
  '围栏代码块与行内代码里的标记不算引用，可以放心在文档里写语法示例。',
].join('');

/**
 * 把工具返回值包成宿主要求的 content 数组。
 * @param {string} text 文本。
 * @returns {Array<object>} content。
 */
const asText = (text) => [{ type: 'text', text }];

/**
 * 渲染条目一行。
 * @param {object} entry 条目。
 * @returns {string} 文本。
 */
function entryLine(entry) {
  const flags = [];
  if (entry.supersededBy) flags.push(`已被 ${entry.supersededBy} 取代`);
  const counts = entry.counts ?? {};
  if ((counts.error ?? 0) > 0) flags.push(`${counts.error} 个错误`);
  if ((counts.warn ?? 0) > 0) flags.push(`${counts.warn} 个待处理`);
  if ((counts.info ?? 0) > 0) flags.push(`${counts.info} 个提示`);
  const tail = flags.length === 0 ? '' : `  [${flags.join('、')}]`;
  return `- ${entry.id} (${entry.kind}, r${entry.rev}) ${entry.title}${tail}`;
}

/**
 * 渲染影响清单。
 * @param {Array<object>} impact 影响项。
 * @returns {string} 文本。
 */
function renderImpact(impact) {
  if (impact.length === 0) return '  目前没有任何文档引用这条口径。';
  const lines = [];
  for (const item of impact.slice(0, MAX_IMPACT_ROWS)) {
    const pin = item.pinRev === null || item.pinRev === undefined ? '未钉版本' : `r${item.pinRev}`;
    lines.push(`  - ${item.file}:${item.line}（${pin}${item.stale === true ? '，需处理' : ''}）`);
    lines.push(`    ${item.snippet ?? ''}`);
  }
  if (impact.length > MAX_IMPACT_ROWS) lines.push(`  … 另有 ${impact.length - MAX_IMPACT_ROWS} 处。`);
  return lines.join('\n');
}

/**
 * 把异常翻成模型能读懂的一句话。
 * @param {Error} error 异常。
 * @returns {string} 说明。
 */
function explain(error) {
  const code = error?.code;
  if (code === 'STORE_UNREADABLE') return `拒绝操作：${error.message}`;
  if (code === 'NOT_FOUND') return error.message;
  if (code === 'EMPTY_STATEMENT') return 'statement 不能为空：口径要写成一句可判定真假的陈述。';
  if (code === 'INVALID_KIND') return error.message;
  if (code === 'INVALID_CHANGE') return 'change 只能是 semantic（事实变了，rev+1）或 wording（只是措辞，rev 不变）。';
  if (code === 'LOCK_TIMEOUT') return error.message;
  if (code === 'MISSING_NOTE') return error.message;
  if (code === 'INVALID_INPUT') return error.message;
  if (code === 'AUDIT_FAILED') return `写入被拒绝：审计记录失败（${error.message}）。`;
  return `操作失败：${error?.message ?? String(error)}`;
}

/**
 * 创建 7 个工具。
 * @param {(definition: object) => object} defineTool 宿主工具 DSL。
 * @param {object} deps 依赖。
 * @param {() => Promise<object>} deps.ops 取 CanonOps（按工作区缓存）。
 * @param {string} deps.fallbackCwd 兜底工作区目录。
 * @returns {Array<object>} 工具定义。
 */
export function createCanonTools(defineTool, deps) {
  if (typeof defineTool !== 'function') throw new TypeError('createCanonTools requires defineTool');
  if (typeof deps?.ops !== 'function') throw new TypeError('createCanonTools requires deps.ops');

  /**
   * 取当前工作区的 ops。
   * @param {object} exec 执行上下文。
   * @returns {Promise<object>} ops。
   */
  const opsFor = async (exec) => deps.ops(cwdOf(exec, deps.fallbackCwd));

  const listTool = defineTool({
    name: TOOL_NAMES.list,
    description: [
      '列出口径库里的条目及其状态（已对齐/过期/未验证/无引用）。',
      '开工前先看一遍，避免重复登记已有口径；查具体某条用 canon_get。',
    ].join(''),
    parameters: {
      query: { type: 'string', description: '按关键词过滤（标题、正文、定位词、标签、id）。' },
      kind: {
        type: 'string',
        enum: ['decision', 'rule', 'value', 'term', 'fact'],
        description: '只看某类：decision 决策、rule 规则、value 取值、term 术语、fact 事实。',
      },
      tag: { type: 'string', description: '按标签过滤。' },
      status: {
        type: 'string',
        enum: ['all', 'problem', 'stale', 'orphan'],
        description: 'all 全部（默认）；problem 只看有错误或待处理项的；stale 只看有位置没跟上的；orphan 只看没有任何引用的。',
      },
      includeArchived: { type: 'boolean', description: '是否包含已归档（被取代）的条目，默认 false。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const result = await ops.list(args);
        const stats = result.stats ?? {};
        const lines = [
          `口径 ${stats.entries ?? 0} 条，引用 ${stats.refs ?? 0} 处；覆盖率 ${(Number(stats.coverage ?? 0) * 100).toFixed(1)}%`,
          '',
        ];
        if (result.entries.length === 0) {
          lines.push('（没有匹配的条目）');
        } else {
          for (const entry of result.entries.slice(0, MAX_LIST_ROWS)) lines.push(entryLine(entry));
          if (result.entries.length > MAX_LIST_ROWS) {
            lines.push(`… 另有 ${result.entries.length - MAX_LIST_ROWS} 条，用 query 缩小范围。`);
          }
        }
        return lines.join('\n');
      } catch (error) {
        return explain(error);
      }
    },
  });

  const getTool = defineTool({
    name: TOOL_NAMES.get,
    description: [
      '取一条口径的全文、历史，以及它在哪些文档的哪些行被引用（含每处当前是已对齐还是过期）。',
      '改口径之前先用它看清影响面。',
    ].join(''),
    parameters: {
      id: { type: 'string', required: true, description: '口径 id，例如 D-001。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const detail = await ops.get(String(args.id ?? ''));
        if (detail === null) return `没有找到口径 ${args.id}。用 canon_list 查现有 id。`;
        const entry = detail.entry;
        const lines = [
          `${entry.id} (${entry.kind}) ${entry.title}`,
          `当前版本 r${entry.rev}${entry.supersededBy ? `（已被 ${entry.supersededBy} 取代）` : ''}`,
          '',
          entry.statement,
        ];
        if ((entry.aliases ?? []).length > 0) lines.push('', `定位词：${entry.aliases.join('、')}`);
        if ((entry.deprecatedPhrases ?? []).length > 0) {
          lines.push(`已废弃说法：${entry.deprecatedPhrases.map((item) => item.text).join('、')}`);
        }
        if ((entry.tags ?? []).length > 0) lines.push(`标签：${entry.tags.join('、')}`);
        lines.push('', `写进文档的标记：${renderMarker(entry.id, entry.rev, 'html')}（其它格式用 canon_add 里写的样式）`);
        lines.push('', `引用 ${detail.refs.length} 处：`);
        lines.push(renderImpact(detail.refs.map((ref) => ({
          file: ref.file,
          line: ref.line,
          pinRev: ref.pinRev,
          stale: (ref.issues ?? []).some((item) => item.level !== 'info'),
          snippet: ref.snippet,
        }))));
        const problems = (detail.issues ?? []).filter((item) => item.level !== 'info');
        if (problems.length > 0) {
          lines.push('', '待处理：');
          for (const item of problems) {
            lines.push(`  [${item.level}] ${item.code} ${item.file ?? ''}${item.line === undefined ? '' : `:${item.line}`} ${item.message ?? ''}`);
          }
        }
        const last = entry.history?.at(-1);
        if (last !== undefined) {
          lines.push('', `最近一次变更：seq ${last.seq} / r${last.rev} / ${last.change} / ${new Date(last.at).toISOString()}${last.note ? ` / ${last.note}` : ''}`);
        }
        return lines.join('\n');
      } catch (error) {
        return explain(error);
      }
    },
  });

  const addTool = defineTool({
    name: TOOL_NAMES.add,
    description: [
      '登记一条新口径：一句可判定真假、后续会被反复引用的陈述（决策、规则、取值、术语、事实）。',
      '只登记真正稳定、多处会引用的东西；一次性细节不要进口径库。',
      '返回新 id、可直接粘贴的标记文本、库里可能重复的相似条目，以及文档里已经命中这些定位词、但还没标记的位置。',
      MARKER_DOC,
    ].join(''),
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['decision', 'rule', 'value', 'term', 'fact'],
        description: '类型，决定 id 前缀（D/R/V/T/F）。',
      },
      statement: {
        type: 'string',
        required: true,
        description: '口径正文：一句话，能判断真假，例如「所有对外接口的超时默认 8 秒」。',
      },
      title: { type: 'string', description: '短标题，省略时取正文前 40 字。' },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        description: '文档里提到它时常用的说法，用于发现「提到了却没标记」的位置。给 2~5 个具体词，别给「系统」「配置」这类泛词。',
      },
      tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
      note: { type: 'string', description: '登记原因或出处。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const result = await ops.add({
          kind: args.kind,
          statement: args.statement,
          title: args.title,
          aliases: args.aliases,
          tags: args.tags,
          note: args.note,
          actor: actorOf(exec),
        });
        const entry = result.entry;
        const lines = [
          `已登记 ${entry.id}（${entry.kind}，r${entry.rev}）：${entry.title}`,
          '',
          '写进文档的标记：',
          `  Markdown/HTML  ${renderMarker(entry.id, entry.rev, 'html')}`,
          `  MDX            ${renderMarker(entry.id, entry.rev, 'mdx')}`,
          `  reST           ${renderMarker(entry.id, entry.rev, 'rst')}`,
          `  AsciiDoc       ${renderMarker(entry.id, entry.rev, 'adoc')}`,
          `  纯文本         ${renderMarker(entry.id, entry.rev, 'plain')}`,
        ];
        if (result.similar.length > 0) {
          lines.push('', '库里已有相似条目，若其实是同一件事请归档新的那条并改用旧的：');
          for (const item of result.similar) lines.push(`  - ${item.id} ${item.title}（相似度 ${item.score}）`);
        }
        if (result.hits.length > 0) {
          lines.push('', `文档里已有 ${result.hits.length} 处提到它但没有标记，建议补上：`);
          for (const hit of result.hits.slice(0, MAX_IMPACT_ROWS)) {
            lines.push(`  - ${hit.file}:${hit.line}（命中「${hit.alias}」）`);
            lines.push(`    ${hit.snippet}`);
          }
        }
        return lines.join('\n');
      } catch (error) {
        return explain(error);
      }
    },
  });

  const updateTool = defineTool({
    name: TOOL_NAMES.update,
    description: [
      '改一条口径。semantic 表示事实本身变了（rev+1，所有钉着旧版本的位置都会变成过期，返回影响清单）；wording 只改措辞、rev 不变。',
      '改完必须逐个处理影响清单里的位置：要么改文并把标记改成新版本，要么确认无影响后用 canon_resolve 记一笔。',
      MARKER_DOC,
    ].join(''),
    parameters: {
      id: { type: 'string', required: true, description: '口径 id。' },
      change: {
        type: 'string',
        required: true,
        enum: ['semantic', 'wording'],
        description: 'semantic = 事实变了（rev+1）；wording = 只调措辞、意思不变（rev 不变）。拿不准就选 semantic。',
      },
      statement: { type: 'string', description: '新的正文。' },
      title: { type: 'string', description: '新的短标题。' },
      aliases: { type: 'array', items: { type: 'string' }, description: '新的定位词（整体替换）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '新的标签（整体替换）。' },
      addDeprecated: {
        type: 'array',
        items: { type: 'string' },
        description: '本次一并作废的旧说法，之后文档里再出现会被报 RESURRECTED。',
      },
      note: { type: 'string', description: '变更原因。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const result = await ops.update(
          String(args.id ?? ''),
          {
            statement: args.statement,
            title: args.title,
            aliases: args.aliases,
            tags: args.tags,
            addDeprecated: args.addDeprecated,
          },
          { change: args.change, note: args.note, actor: actorOf(exec) },
        );
        const entry = result.entry;
        const lines = [];
        if (!result.revChanged && result.previousRev === entry.rev && result.impact.length === 0) {
          lines.push(`没有实际改动：${entry.id} 仍是 r${entry.rev}。`);
        } else if (result.revChanged) {
          lines.push(`已更新 ${entry.id}：r${result.previousRev} → r${entry.rev}（语义改动）`);
        } else {
          lines.push(`已更新 ${entry.id}：措辞修订，仍为 r${entry.rev}`);
        }
        lines.push('', `新标记：${renderMarker(entry.id, entry.rev, 'html')}（其它样式见 canon_add）`);
        if (result.deprecatedAdded.length > 0) {
          lines.push(`已作废旧说法：${result.deprecatedAdded.join('、')}`);
        }
        lines.push('', `影响 ${result.impact.length} 处：`);
        if (result.impact.length === 0) {
          lines.push('  没有文档引用它，改完即生效。');
        } else {
          for (const item of result.impact.slice(0, MAX_IMPACT_ROWS)) {
            const pin = item.pinRev === null || item.pinRev === undefined ? '未钉版本' : `r${item.pinRev}`;
            lines.push(`  - ${item.file}:${item.line}（${pin}${item.stale ? '，需处理' : ''}）`);
            lines.push(`    ${item.snippet ?? ''}`);
          }
          if (result.impact.length > MAX_IMPACT_ROWS) lines.push(`  … 另有 ${result.impact.length - MAX_IMPACT_ROWS} 处。`);
          lines.push('', '逐处处理：改文后把标记改成上面的新版本，然后调用 canon_resolve（每处都要写 note 说明改了什么或为什么不受影响）。');
        }
        return lines.join('\n');
      } catch (error) {
        return explain(error);
      }
    },
  });

  const archiveTool = defineTool({
    name: TOOL_NAMES.archive,
    description: [
      '归档一条口径：它不再有效。用 supersededBy 指明取代它的口径，之后仍指向它的标记会被报 SUPERSEDED_REF。',
      '归档不删数据、不改号；把标记改到新口径用 CLI 的 `canon repoint <旧> <新> --paths <文件…> --apply`（默认只预览）。',
    ].join(''),
    parameters: {
      id: { type: 'string', required: true, description: '要归档的口径 id。' },
      supersededBy: { type: 'string', description: '取代它的口径 id；省略表示只是作废、没有替代。' },
      note: { type: 'string', description: '归档原因。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const result = await ops.archive(String(args.id ?? ''), {
          supersededBy: args.supersededBy,
          note: args.note,
          actor: actorOf(exec),
        });
        const entry = result.entry;
        const lines = [
          entry.supersededBy
            ? `已归档 ${entry.id}，由 ${entry.supersededBy} 取代。`
            : `已归档 ${entry.id}（无替代）。`,
        ];
        if (result.refs.length > 0) {
          lines.push('', `仍有 ${result.refs.length} 处标记指向它：`);
          for (const ref of result.refs.slice(0, MAX_IMPACT_ROWS)) lines.push(`  - ${ref.file}:${ref.line}`);
          if (entry.supersededBy) {
            lines.push('', `把这些文件里的标记改到 ${entry.supersededBy}：canon repoint ${entry.id} ${entry.supersededBy} --paths <上面的文件> --apply`);
          } else {
            lines.push('', '没有替代口径时，请手工删掉或改掉这些标记。');
          }
        }
        return lines.join('\n');
      } catch (error) {
        return explain(error);
      }
    },
  });

  const resolveTool = defineTool({
    name: TOOL_NAMES.resolve,
    description: [
      '核验某条口径在某些文档位置已经处理过（改文或确认无影响）。这是记账，不是盖章：',
      '工具会核对文档现状 —— 标记必须已钉到当前版本；记 updated 要求该段落文字确实变了，记 confirmed 要求说明理由。对不上会拒绝。',
      '批量处理过期位置时，每项都要带具体 note；空 note 一律拒绝。',
    ].join(''),
    parameters: {
      items: {
        type: 'array',
        required: true,
        description: '要核验的位置，至少一项。',
        items: {
          type: 'object',
          properties: {
            entryId: { type: 'string', required: true, description: '口径 id。' },
            file: { type: 'string', required: true, description: '文档路径（工作区相对路径，正斜杠）。' },
            outcome: {
              type: 'string',
              required: true,
              enum: ['updated', 'confirmed'],
              description: 'updated = 这处表述已按新口径改过；confirmed = 核对了，这处不需要改。',
            },
            note: { type: 'string', required: true, description: '改了什么，或为什么这处不受影响。必填。' },
          },
          additionalProperties: false,
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const result = await ops.resolve(args.items, { actor: actorOf(exec) });
        const lines = [];
        for (const item of result.results) {
          lines.push(`${item.ok ? '✓' : '✗'} ${item.entryId} ${item.file}：${item.message}`);
        }
        if (result.failed.length > 0) {
          lines.push('', `有 ${result.failed.length} 项没通过核验，按上面的说明处理后重试。`);
        }
        return lines.join('\n');
      } catch (error) {
        return explain(error);
      }
    },
  });

  const checkTool = defineTool({
    name: TOOL_NAMES.check,
    description: [
      '全库体检：列出所有标记问题（悬空、过期、未验证、废弃说法复活、无标记的表述、无引用的口径），带文件行号。',
      '改完一批文档后跑一次确认没有遗漏。历史类文档（handover/CHANGELOG 等）的问题只作提示。',
    ].join(''),
    parameters: {
      only: {
        type: 'string',
        enum: ['error', 'warn', 'info'],
        description: '只看该级别及以上的问题；省略看全部。',
      },
      force: { type: 'boolean', description: '忽略缓存全量重扫（默认增量）。' },
      limit: { type: 'integer', description: '最多列多少条，默认 80。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args = {}, exec) {
      try {
        const ops = await opsFor(exec);
        const report = await ops.check({ force: args.force === true });
        const rank = { error: 0, warn: 1, info: 2 };
        const floor = args.only === undefined ? 0 : rank[args.only] ?? 0;
        const filtered = (report.issues ?? []).filter((item) => rank[item.level] <= floor || floor === 2);
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 80;
        return ops.renderReport({ ...report, issues: filtered }, { limit });
      } catch (error) {
        return explain(error);
      }
    },
  });

  return [listTool, getTool, addTool, updateTool, archiveTool, resolveTool, checkTool];
}
