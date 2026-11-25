/**
 * `@deepseek-ai/dsh-tools` 的测试替身。
 *
 * **这个替身必须复刻宿主的 schema DSL 校验**，否则离线测试会放过宿主里必崩
 * 的定义。0.2.0 的教训：`canon_resolve` 在数组 `items` 里写了
 * `required: ['entryId', ...]`，替身原样放行、测试全绿，而真实 `defineTool`
 * 抛 JsonSchemaError，被 index.js 的 try/catch 吞成一行 warn —— 七个工具一个
 * 都没注册，界面上看不出任何异常。
 *
 * 规则照抄宿主 `dsh-tools` 的 `runSchemaCompiler`：
 * - 每个属性用 `required: true` 标记必填，**没有** `required: [...]` 数组写法；
 * - `items` / `oneOf` 分支里 `allowRequired: false`，出现 `required` 直接报错；
 * - 只认 type / enum / const / properties / items / oneOf / description / title /
 *   default / examples 这几个键；
 * - `type: 'object'` 必须显式给 `additionalProperties: true|false`。
 *
 * @module dsh-canon-keeper/test/stub-tools
 */

/** 记录所有被 defineTool 处理过的定义。 */
export const defined = [];

/** 宿主 DSL 允许的注解键。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/** 标量类型。 */
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];

/**
 * 校验一个 schema 节点，抛错即视为宿主会拒绝。
 * @param {unknown} node 节点。
 * @param {string} path 位置（报错用）。
 * @param {boolean} allowRequired 这一层是否允许出现 `required`。
 * @returns {void}
 */
function checkNode(node, path, allowRequired) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  if (Object.hasOwn(node, 'required') && !allowRequired) {
    throw new Error(`${path}.required is not supported by the value schema DSL`);
  }
  if (Object.hasOwn(node, 'required') && node.required !== true) {
    throw new Error(`${path}.required 只能是 true（必填用 required: true，不要写数组）`);
  }

  const allowed = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];

  if (Object.hasOwn(node, 'oneOf')) {
    for (const key of Object.keys(node)) {
      if (![...allowed, 'oneOf', 'type'].includes(key)) throw new Error(`${path}.${key} is not supported by the value schema DSL`);
    }
    if (Object.hasOwn(node, 'type')) throw new Error(`${path} 不能同时写 type 与 oneOf`);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) throw new Error(`${path}.oneOf 至少两项`);
    node.oneOf.forEach((branch, index) => checkNode(branch, `${path}.oneOf[${index}]`, false));
    return;
  }

  const type = node.type;
  if (type === 'json') return;
  if (type === 'object') {
    for (const key of Object.keys(node)) {
      if (![...allowed, 'type', 'properties', 'additionalProperties'].includes(key)) throw new Error(`${path}.${key} is not supported by the value schema DSL`);
    }
    if (typeof node.additionalProperties !== 'boolean') throw new Error(`${path}.additionalProperties 必须显式 true/false`);
    if (node.properties !== undefined) {
      if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        throw new Error(`${path}.properties 必须是对象`);
      }
      for (const [key, child] of Object.entries(node.properties)) {
        checkNode(child, `${path}.properties.${key}`, true);
      }
    }
    return;
  }
  if (type === 'array') {
    for (const key of Object.keys(node)) {
      if (![...allowed, 'type', 'items'].includes(key)) throw new Error(`${path}.${key} is not supported by the value schema DSL`);
    }
    if (node.items !== undefined) checkNode(node.items, `${path}.items`, false);
    return;
  }
  if (SCALAR_TYPES.includes(type)) {
    for (const key of Object.keys(node)) {
      if (![...allowed, 'type', 'enum', 'const'].includes(key)) throw new Error(`${path}.${key} is not supported by the value schema DSL`);
    }
    if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0)) {
      throw new Error(`${path}.enum 必须是非空数组`);
    }
    return;
  }
  throw new Error(`${path}.type 必须是 string/number/integer/boolean/null/array/object/json，或改用 oneOf`);
}

/**
 * 校验逐属性参数 DSL（宿主的 `parameterSchemaSpecToJsonSchema`）。
 * @param {unknown} spec 参数表。
 * @returns {void}
 */
function checkParameters(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('parameters 必须是对象');
  }
  for (const [key, child] of Object.entries(spec)) {
    checkNode(child, `parameters.${key}`, true);
  }
}

/**
 * 校验输出 schema（宿主的 `valueSchemaSpecToJsonSchema`，根层不收 required）。
 * @param {unknown} spec schema。
 * @returns {void}
 */
function checkOutputSchema(spec) {
  checkNode(spec, 'schema', false);
}

/**
 * 复刻宿主的 defineTool：校验通过才登记，原样返回定义。
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
  if (definition.output === null || typeof definition.output !== 'object') {
    throw new TypeError(`tool ${definition.name} requires output`);
  }
  if (typeof definition.output.render !== 'function') {
    throw new TypeError(`tool ${definition.name} requires output.render`);
  }
  checkParameters(definition.parameters);
  checkOutputSchema(definition.output.schema);
  if (definition.timeoutMs !== undefined && !(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0)) {
    throw new Error(`defineTool(${definition.name}): timeoutMs 必须是正有限数`);
  }
  defined.push(definition);
  return definition;
}
