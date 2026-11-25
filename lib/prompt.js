/**
 * 常驻系统提示：让 Agent 知道这套机制存在、什么时候该用。
 *
 * 为什么需要这一段:七个工具的描述只有**被调用之后**才进入模型视野,而 Agent
 * 不知道有这套东西就不会去调 —— 没有触发点,工具描述写得再全也是死代码。
 * 0.2.0 就栽在这里:工具没注册上(见 tools.js 的 required 数组事故)时,
 * 界面上没有任何异常,整套机制静默缺席。
 *
 * 注入内容的边界(与 design.md §13 一致):
 * - 只讲「有这个机制、什么时候用、去哪看细节」,**不塞任何口径正文**。
 *   把口径内容每轮灌进上下文,等于把未核验的状态洗成已核验。
 * - 只用确定性文本,不做任何 I/O —— 这个函数每轮 pre-step 都会被求值。
 * - 完整用法(标记语法、各工具取舍、核验口径)在随包技能里按需加载,
 *   所以这里只留指路的一句。
 *
 * @module dsh-canon-keeper/lib/prompt
 */

/** 段落名。宿主按 name 去重,换名字会让旧段落残留。 */
export const PROMPT_SECTION = 'canon-keeper:policy';

/**
 * 段落排序位。
 *
 * 宿主自己的段落:id 在 100 段,记忆策略在 650 段。口径是**项目级**约定,
 * 排在记忆之后(记忆是跨项目事实,先讲),但在工具说明之前。
 */
export const PROMPT_ORDER = 670;

/**
 * 生成常驻说明。
 *
 * 文本刻意短:它每轮都占 context。细节全部推给随包技能与工具描述。
 *
 * @returns {string} 系统提示段落正文。
 */
export function promptText() {
  return [
    '## 口径守护（canon-keeper）',
    '',
    '本项目用 `canon` 库登记「会被反复引用的关键事实」：决策、规则、取值、术语、事实。',
    '每条有编号（如 `D-001`）和语义版本；写进文档时用带版本的标记钉住，例如 `<!-- canon:D-001@r3 -->`。',
    '口径一改，就能机械列出所有引用位置并逐处核验。',
    '',
    '什么时候用：',
    '- **开工前**先 `canon_list` 看一遍已有口径，避免重复登记或与既有决策冲突。',
    '- 要登记/修改关键事实时用 `canon_add` / `canon_update`——它们的描述里有完整标记语法。',
    '- 改了口径之后用 `canon_get` 看清影响面，改完文档用 `canon_resolve` 逐处记账。',
    '- 一批文档改完后 `canon_check` 做全库体检。',
    '',
    '口径库不存在时不要凭空猜；`canon_list` 会告诉你当前状态。',
    '完整用法（各格式标记样式、核验口径、常见误用）见随包技能 `canon-keeper`。',
  ].join('\n');
}

/**
 * 把常驻说明挂到系统提示上。
 *
 * 失败只记一行日志:提示段落是增强,缺了它工具照常可用,不该把整条 entry 拖下水。
 *
 * @param {object} scoped 已注入 systemPrompt 的 scope。
 * @param {object} [options] 覆盖项。
 * @param {object} [options.logger] 日志器。
 * @param {() => boolean} [options.enabled] 是否注入。
 * @returns {boolean} 是否挂上。
 */
export function mountPrompt(scoped, options = {}) {
  const systemPrompt = scoped?.systemPrompt;
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    options.logger?.warn?.('[dsh-canon-keeper] systemPrompt 服务不可用，常驻说明未注入（工具照常可用）');
    return false;
  }
  const enabled = options.enabled ?? (() => true);
  try {
    systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      // 函数形式:每轮 pre-step 重新求值,开关改了下一次就生效。
      text: () => (enabled() ? promptText() : ''),
    });
    return true;
  } catch (error) {
    options.logger?.warn?.(`[dsh-canon-keeper] 常驻说明注入失败:${error?.message ?? error}`);
    return false;
  }
}
