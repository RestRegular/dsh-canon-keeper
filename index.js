/**
 * dsh-canon-keeper — Host half.
 *
 * 「口径守护」：把项目里那些会被反复引用的关键事实（决策、规则、取值、术语）
 * 登记成带语义版本的编号条目，用带版本的标记钉进文档；口径一改，
 * 就能机械列出所有引用位置并逐处核验。
 *
 * 本插件只提供三样东西：Agent 工具（登记/查询/核验）、一条可脚本化的 CLI、
 * 以及后续的侧边栏面板。刻意**不做**运行时自动注入、轮末强制检查、拦截 write/edit ——
 * 那类做法要么把未核验的状态洗成已核验，要么在 Agent 不配合时静默失效。
 *
 * @module dsh-canon-keeper
 */

import path from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CanonOps } from './lib/ops.js';
import { createCanonTools } from './lib/tools.js';
import { DEFAULT_MARKER_STYLES } from './lib/marker.js';
import { SCAN_DEFAULTS } from './lib/scan.js';
import { createToken, mountRoutes } from './lib/routes.js';
import { mountPrompt } from './lib/prompt.js';
import { mountBundledSkills } from './lib/skills.js';

const field = (type, description, extra = {}) => ({
  type,
  meta: { volatile: true, description },
  ...extra,
});

const CONFIG_FIELDS = {
  storeDir: field('string', '口径库目录（工作区相对路径），默认 canon，建议纳入 git。'),
  markerStyles: field('string', '扩展名到标记样式的映射，JSON 对象，例如 {"md":"html"}；留空用内置默认。'),
  includeExtensions: field('string', '参与扫描的扩展名，逗号分隔，默认 md,markdown,mdx,txt,rst,adoc。'),
  ignoreGlobs: field('string', '不扫描的路径 glob，逗号分隔，每行一个也可。'),
  historicalGlobs: field('string', '历史类文档的 glob，逗号分隔；这些文件里的告警只作提示。'),
  mentionMinLength: field('string', '报告「提到却没标记」的最短长度，形如 2,4（中文, 拉丁），默认 2,4。'),
  learnDeprecated: field('boolean', '语义改动时把被替换掉的定位词自动记为废弃说法。'),
  maxFiles: field('integer', '单次扫描的文件数上限，默认 2000。', { min: 1, max: 200000 }),
  maxFileBytes: field('integer', '单个文件体积上限（字节），默认 524288。', { min: 1024, max: 104857600 }),
  lockTimeoutMs: field('integer', '跨进程写锁的过期时间（毫秒），默认 30000。', { min: 1000, max: 600000 }),
  injectPrompt: field('boolean', '是否在系统提示里常驻一段「有这个机制、什么时候用」的说明，默认 true。关掉后 Agent 只能靠工具描述自己发现。'),
  bundledSkill: field('boolean', '是否注册随包技能（完整标记语法与核验口径），默认 true。'),
};

const DEFAULTS = {
  storeDir: 'canon',
  markerStyles: '',
  includeExtensions: SCAN_DEFAULTS.includeExtensions.join(','),
  ignoreGlobs: SCAN_DEFAULTS.ignoreGlobs.join(','),
  historicalGlobs: SCAN_DEFAULTS.historicalGlobs.join(','),
  mentionMinLength: `${SCAN_DEFAULTS.mentionMinLength.cjk},${SCAN_DEFAULTS.mentionMinLength.latin}`,
  learnDeprecated: true,
  maxFiles: SCAN_DEFAULTS.maxFiles,
  maxFileBytes: SCAN_DEFAULTS.maxFileBytes,
  lockTimeoutMs: 30_000,
  injectPrompt: true,
  bundledSkill: true,
};

/**
 * 拆分逗号/换行分隔的列表。
 * @param {unknown} value 输入。
 * @param {string[]} fallback 兜底。
 * @returns {string[]} 列表。
 */
function splitList(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const items = value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? fallback : items;
}

/**
 * 解析 JSON 对象配置。
 * @param {unknown} value 输入。
 * @param {Record<string, string>} fallback 兜底。
 * @returns {Record<string, string>} 结果。
 */
function parseMap(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const out = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item !== 'string') continue;
      out[key.startsWith('.') ? key.toLowerCase() : `.${key.toLowerCase()}`] = item;
    }
    return Object.keys(out).length === 0 ? fallback : out;
  } catch {
    return fallback;
  }
}

/**
 * 补齐配置。
 * @param {unknown} raw 行配置。
 * @returns {object} 完整配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const integer = (value, fallback, min, max) => {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  };
  const pair = typeof source.mentionMinLength === 'string' ? source.mentionMinLength.split(',') : [];
  const cjk = Number(pair[0]);
  const latin = Number(pair[1]);
  return {
    storeDir: typeof source.storeDir === 'string' && source.storeDir.trim() !== ''
      ? source.storeDir.trim()
      : DEFAULTS.storeDir,
    markerStyles: parseMap(source.markerStyles, DEFAULT_MARKER_STYLES),
    includeExtensions: splitList(source.includeExtensions, SCAN_DEFAULTS.includeExtensions),
    ignoreGlobs: splitList(source.ignoreGlobs, SCAN_DEFAULTS.ignoreGlobs),
    historicalGlobs: splitList(source.historicalGlobs, SCAN_DEFAULTS.historicalGlobs),
    mentionMinLength: {
      cjk: Number.isFinite(cjk) && cjk > 0 ? Math.trunc(cjk) : SCAN_DEFAULTS.mentionMinLength.cjk,
      latin: Number.isFinite(latin) && latin > 0 ? Math.trunc(latin) : SCAN_DEFAULTS.mentionMinLength.latin,
    },
    learnDeprecated: bool(source.learnDeprecated, DEFAULTS.learnDeprecated),
    maxFiles: integer(source.maxFiles, DEFAULTS.maxFiles, 1, 200000),
    maxFileBytes: integer(source.maxFileBytes, DEFAULTS.maxFileBytes, 1024, 104857600),
    lockTimeoutMs: integer(source.lockTimeoutMs, DEFAULTS.lockTimeoutMs, 1000, 600000),
    injectPrompt: bool(source.injectPrompt, DEFAULTS.injectPrompt),
    bundledSkill: bool(source.bundledSkill, DEFAULTS.bundledSkill),
  };
}

/**
 * 给配置节点补 meta（settings.describe 会读 schema.meta.volatile）。
 * @param {object} node 节点。
 * @returns {object} 描述符。
 */
function descriptor(node) {
  const result = {
    ...node,
    meta: { ...(node.meta ?? {}) },
    toJSON() {
      return JSON.parse(JSON.stringify({ ...this, toJSON: undefined }));
    },
  };
  if (node.dict !== undefined) {
    result.dict = Object.fromEntries(
      Object.entries(node.dict).map(([key, child]) => [key, descriptor(child)]),
    );
  }
  return result;
}

export const Config = Object.assign(descriptor({ type: 'object', dict: CONFIG_FIELDS }), {
  '~standard': {
    version: 1,
    vendor: 'dsh-canon-keeper',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    },
  },
});

/**
 * 插件体。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} [rawConfig] 行配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;

  /** 工作区根目录 → CanonOps（每个工作区一个实例，互不干扰）。 */
  const instances = new Map();

  /**
   * 取（或创建）某工作区的操作集合。
   * @param {string} cwd 工作区根目录。
   * @returns {Promise<CanonOps>} 操作集合。
   */
  const opsFor = async (cwd) => {
    const root = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    let ops = instances.get(root);
    if (ops === undefined) {
      ops = new CanonOps({
        cwd: root,
        storeDir: path.resolve(root, config.storeDir),
        scanConfig: {
          includeExtensions: config.includeExtensions,
          ignoreGlobs: config.ignoreGlobs,
          historicalGlobs: config.historicalGlobs,
          mentionMinLength: config.mentionMinLength,
          maxFiles: config.maxFiles,
          maxFileBytes: config.maxFileBytes,
        },
        logger,
        lockTimeoutMs: config.lockTimeoutMs,
      });
      instances.set(root, ops);
    }
    await ops.ensure();
    return ops;
  };

  // ------------------------------------------------------------------
  // Agent 工具（7 个）
  // ------------------------------------------------------------------
  ctx.inject(['tools'], (scoped) => {
    try {
      const definitions = createCanonTools(defineTool, {
        ops: opsFor,
        fallbackCwd: process.cwd(),
      });
      for (const definition of definitions) {
        scoped.effect(() => scoped.tools.register(definition), `dsh-canon-keeper: ${definition.name} tool`);
      }
    } catch (error) {
      // 用 error 级、带栈：这里的失败是**整套机制静默消失**（七个工具一个都没
      // 注册，界面上却一切正常）。0.2.0 就是被一行 warn 埋掉的 —— 参数 DSL 写错
      // 一个 required 数组，真实 defineTool 抛 JsonSchemaError，谁都没看见。
      // 不回抛：面板与 CLI 还能用，但日志里必须能一眼看出「工具没上」。
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      logger?.error?.(`[dsh-canon-keeper] 工具注册失败，本次会话里 canon_* 全部不可用：${detail}`);
    }
  });

  // ------------------------------------------------------------------
  // 常驻系统提示 + 随包技能：让 Agent 知道这套机制存在
  //
  // 工具描述只有**被调用之后**才进模型视野。没有触发点，Agent 不会去调，
  // 描述写得再全也是死代码。这两段各管一半：常驻说明给「什么时候用」，
  // 随包技能给完整细节（按需加载，不占常驻 context）。
  // ------------------------------------------------------------------
  ctx.inject(['systemPrompt'], (scoped) => {
    mountPrompt(scoped, {
      logger,
      enabled: () => config.injectPrompt,
    });
  });

  ctx.inject(['skills'], (scoped) => {
    if (!config.bundledSkill) return;
    mountBundledSkills(scoped, { logger });
  });

  // ------------------------------------------------------------------
  // 面板：回环 HTTP 路由
  // ------------------------------------------------------------------
  /** 面板写操作的 token，每次进程启动随机生成。 */
  const panelToken = createToken();

  /**
   * 从请求里解析工作区根目录。
   *
   * **只认 sessionId 反查出来的 cwd**，不接受客户端直接传路径 —— 否则面板就能
   * 被用来读写任意目录。会话 id 来自右侧边栏标签页自身，拿不到就明确报错。
   *
   * @param {object} payload 请求体/查询参数。
   * @returns {string} 工作区根目录，解析不出来时为空串。
   */
  const cwdOfRequest = (payload) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (sessionId === '') return '';
    const sessions = ctx.get('sessions');
    const session = sessions?.get?.(sessionId);
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : '';
  };

  ctx.inject(['webServer'], (scoped) => {
    mountRoutes(scoped, {
      deps: {
        token: () => panelToken,
        cwdOf: cwdOfRequest,
        opsFor,
      },
      logger,
    });
  });

  ctx.effect(() => () => {
    instances.clear();
  }, 'dsh-canon-keeper: instances');
}

export { CanonOps };
export { TOOL_NAMES } from './lib/tools.js';
export { ROUTE, API } from './lib/routes.js';
export const PLUGIN_VERSION = '0.3.0';
export const HOME = os.homedir();
