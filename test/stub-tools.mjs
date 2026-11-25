/**
 * `@deepseek-ai/dsh-tools` 的测试替身。
 *
 * 宿主里的 defineTool 主要做身份包装与校验；离线测试只需要一个能记录
 * 定义原样返回的版本，好让我们断言 name / parameters / description 的形状。
 *
 * @module dsh-canon-keeper/test/stub-tools
 */

/** 记录所有被 defineTool 处理过的定义。 */
export const defined = [];

/**
 * 原样返回定义（宿主会在此加 identity）。
 * @param {object} definition 工具定义。
 * @returns {object} 同一个定义。
 */
export function defineTool(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('defineTool requires an object');
  }
  if (typeof definition.name !== 'string' || definition.name === '') {
    throw new TypeError('tool definition requires a name');
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`tool ${definition.name} requires execute`);
  }
  defined.push(definition);
  return definition;
}
