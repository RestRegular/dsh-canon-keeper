/**
 * 随包技能：`skills/<name>/SKILL.md` → 技能注册表候选。
 *
 * 为什么随包发而不是写进 `~/.agents/skills`：标记语法、核验口径、各工具的取舍
 * 都是**这个插件的**约定，必须和代码同版本、同一次安装。写进用户目录就成了
 * 「另一份需要单独维护的副本」，改代码忘了改文档，Agent 照着过期文档写标记。
 *
 * 注册成 provider 而不是 runtime skill：技能以后要带 `references/` 这类资源文件，
 * 只有 `resourceBase` 能让模型解析相对路径（见 skill-authoring 的 plugin-bundled 说明）。
 *
 * 与 dsh-memory 的同名模块保持同一套做法：正文每次现读，注册表只缓存目录。
 *
 * @module dsh-canon-keeper/lib/skills
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 随包技能目录。产物里是 `<pkg>/skills/`。 */
export const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/** 与 `@deepseek-ai/dsh-skill` 的 BUNDLED_SKILL_RANK 对齐：项目 / 用户技能可以覆盖它。 */
export const BUNDLED_SKILL_RANK = 600;

/** provider 名必须是本包名的一部分，且不能是保留字 `runtime`。 */
export const PROVIDER = 'dsh-canon-keeper';

/**
 * 取 frontmatter 里某个单行字段（只处理 `key: value` / `key: "value"`）。
 * @param {string} text 文件全文。
 * @param {string} key 字段名。
 * @returns {string|undefined} 值。
 */
function frontmatterField(text, key) {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return undefined;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match === null || match[1] !== key) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.trim() === '' ? undefined : value;
  }
  return undefined;
}

/**
 * frontmatter 之后的正文。
 * @param {string} text 文件全文。
 * @returns {string} 正文。
 */
function skillBody(text) {
  if (!text.startsWith('---')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text.trim();
  const after = text.indexOf('\n', end + 1);
  return (after < 0 ? '' : text.slice(after + 1)).trim();
}

/**
 * 读一个技能目录成候选。
 *
 * **这里就把错误抛出来**：注册表要求候选合法，否则整批观察失败；宁可启动时
 * 看见一行明确日志，也不要「技能悄悄不存在」。
 *
 * @param {string} name 技能名。
 * @returns {object} 候选。
 */
function candidateFor(name) {
  const directory = join(SKILLS_ROOT, name);
  const file = join(directory, 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  const description = frontmatterField(text, 'description');
  if (description === undefined) {
    throw new Error(`随包技能 "${name}" 的 SKILL.md 缺少 description:${file}`);
  }
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
    locator: file,
    path: file,
  };
}

/**
 * 磁盘上实际存在的技能名（目录里有 SKILL.md 的）。
 * @returns {string[]} 技能名。
 */
export function skillNames() {
  try {
    if (!existsSync(SKILLS_ROOT)) return [];
    return readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_ROOT, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 注册随包技能。
 *
 * 失败只记一行日志：技能资产出问题不该把工具与面板一起带下水 —— 与仓库
 * 「任何半边抛错只写一行日志」的铁律一致。
 *
 * @param {object} scoped 已注入 skills 的 scope。
 * @param {object} [options] 覆盖项。
 * @param {object} [options.logger] 日志器。
 * @returns {boolean} 是否注册成功。
 */
export function mountBundledSkills(scoped, options = {}) {
  const logger = options.logger ?? scoped?.logger;
  let skills;
  try {
    skills = scoped?.skills ?? scoped?.get?.('skills');
  } catch {
    skills = undefined;
  }
  if (skills === undefined || typeof skills.registerProvider !== 'function') {
    logger?.warn?.('[dsh-canon-keeper] skills 服务不可用，随包技能未注册（工具与面板不受影响）');
    return false;
  }

  const names = skillNames();
  if (names.length === 0) {
    logger?.warn?.(`[dsh-canon-keeper] 没找到随包技能目录 ${SKILLS_ROOT}`);
    return false;
  }

  const build = () => {
    const candidates = names.map(candidateFor);
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    return {
      name: PROVIDER,
      list: () => Promise.resolve(candidates),
      // 正文每次现读：改 SKILL.md 下一次加载就生效（注册表只缓存目录）。
      get: (winner) => {
        const known = byName.get(winner?.name);
        if (known === undefined) throw new Error(`随包技能 "${String(winner?.name)}" 不存在`);
        const { rank: _rank, locator: _locator, ...summary } = known;
        return Promise.resolve({ ...summary, content: skillBody(readFileSync(known.path, 'utf8')) });
      },
    };
  };

  try {
    if (typeof scoped.effect === 'function') {
      scoped.effect(() => skills.registerProvider(build), 'dsh-canon-keeper: bundled skills');
    } else {
      skills.registerProvider(build);
    }
    return true;
  } catch (error) {
    logger?.warn?.(`[dsh-canon-keeper] 随包技能未能注册:${error?.message ?? error}`);
    return false;
  }
}
