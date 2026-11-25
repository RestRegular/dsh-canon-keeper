/**
 * 宿主侧冒烟：验证 index.js 能被装载、Config 描述符合法、7 个工具正确注册。
 *
 * 这一层刻意和 lib 的纯逻辑测试分开：lib 测试不需要宿主，这里专门覆盖
 * 「接进 DSH 之后长什么样」—— 也就是最容易在打包后才发现坏掉的部分。
 *
 * 用法：node --import ./test/register-stub.mjs test/host.mjs
 *
 * @module dsh-canon-keeper/test/host
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, Config, normalizeConfig, TOOL_NAMES } from '../index.js';

let passed = 0;
const failures = [];

/**
 * 跑一个用例。
 * @param {string} name 名称。
 * @param {() => Promise<void>|void} body 用例体。
 * @returns {Promise<void>} 完成。
 */
async function test(name, body) {
  try {
    await body();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error?.message ?? error}\n`);
  }
}

/**
 * 造一个假宿主上下文。
 * @returns {{ctx: object, registered: Array<object>}} 上下文与注册表。
 */
function fakeHost() {
  const registered = [];
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    inject(names, callback) {
      assert.ok(Array.isArray(names) && names.includes('tools'), 'index.js 应注入 tools');
      callback({
        effect(fn) {
          return fn();
        },
        tools: {
          register(definition) {
            registered.push(definition);
          },
        },
      });
    },
    effect(fn) {
      fn();
    },
  };
  return { ctx, registered };
}

process.stdout.write('canon-keeper host smoke\n\n');

await test('Config 描述符：每个节点都带 meta.volatile 与 description', () => {
  const json = JSON.parse(JSON.stringify(Config));
  assert.equal(json.type, 'object');
  const dict = json.dict ?? {};
  assert.ok(Object.keys(dict).length >= 8, '配置项不应过少');
  for (const [key, node] of Object.entries(dict)) {
    assert.equal(node.meta?.volatile, true, `${key} 缺 meta.volatile`);
    assert.equal(typeof node.meta?.description, 'string', `${key} 缺 description`);
    assert.notEqual(node.meta.description, '', `${key} 的 description 为空`);
  }
});

await test('Config 校验器：夹紧数值、兜底非法输入', () => {
  const std = Config['~standard'];
  assert.equal(std.version, 1);
  assert.equal(std.vendor, 'dsh-canon-keeper');
  assert.equal(std.validate({ maxFiles: 10 }).value.maxFiles, 10);
  assert.ok(std.validate({ maxFiles: 999999999 }).value.maxFiles <= 200000, 'maxFiles 要夹紧');
  assert.ok(std.validate({ lockTimeoutMs: 1 }).value.lockTimeoutMs >= 1000, 'lockTimeoutMs 要夹紧');
  const bad = std.validate({ mentionMinLength: 'abc' });
  assert.equal(bad.value.mentionMinLength.cjk, 2, '非法输入回落默认');
  assert.equal(std.validate({}).value.storeDir, 'canon', 'storeDir 默认 canon');
});

await test('normalizeConfig：解析 JSON 样式表与逗号列表', () => {
  const config = normalizeConfig({
    markerStyles: '{"md":"mdx","txt":"plain"}',
    includeExtensions: 'md, mdx',
    ignoreGlobs: 'node_modules\n.git',
  });
  assert.equal(config.markerStyles['.md'], 'mdx', '无点前缀要补上');
  assert.equal(config.markerStyles['.txt'], 'plain');
  assert.deepEqual(config.includeExtensions, ['md', 'mdx']);
  assert.deepEqual(config.ignoreGlobs, ['node_modules', '.git']);
  // 坏 JSON 不能抛，只能回落
  assert.equal(normalizeConfig({ markerStyles: '{oops' }).markerStyles['.md'], 'html');
});

await test('apply 注册 7 个工具，名字与 TOOL_NAMES 一致', () => {
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  assert.equal(registered.length, 7);
  const names = registered.map((item) => item.name).sort();
  const expected = Object.values(TOOL_NAMES).sort();
  assert.deepEqual(names, expected);
});

await test('每个工具定义完整：描述、参数、输出、并发标记', () => {
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string', `${definition.name} 缺 description`);
    assert.ok(definition.description.length >= 20, `${definition.name} 描述过短`);
    assert.equal(typeof definition.parameters, 'object', `${definition.name} 缺 parameters`);
    assert.notEqual(definition.output, undefined, `${definition.name} 缺 output`);
    assert.equal(typeof definition.output.render, 'function', `${definition.name} 缺 output.render`);
    assert.equal(typeof definition.execute, 'function', `${definition.name} 缺 execute`);
    assert.equal(typeof definition.isConcurrencySafe, 'function', `${definition.name} 缺 isConcurrencySafe`);
    assert.ok(Number.isInteger(definition.timeoutMs), `${definition.name} 缺 timeoutMs`);
  }
});

await test('标记约定只写在 canon_add / canon_update 里', () => {
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  const withMarker = registered
    .filter((definition) => definition.description.includes('canon:D-001@r3'))
    .map((definition) => definition.name)
    .sort();
  assert.deepEqual(withMarker, ['canon_add', 'canon_update'], '其它工具不该重复标记语法');
});

await test('canon_resolve 的 items 是对象数组且要求 note', () => {
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  const resolve = registered.find((definition) => definition.name === 'canon_resolve');
  const items = resolve.parameters.items;
  assert.equal(items.type, 'array');
  assert.equal(items.required, true);
  assert.equal(items.items.type, 'object');
  assert.deepEqual(items.items.required.sort(), ['entryId', 'file', 'note', 'outcome']);
  assert.deepEqual(items.items.properties.outcome.enum, ['updated', 'confirmed']);
});

await test('工具在真实工作区里能跑通一条完整链路', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-host-run-'));
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  const byName = new Map(registered.map((definition) => [definition.name, definition]));
  const exec = { agent: { name: 'lead', session: { header: { id: 's-1', cwd: dir } } } };

  // 用真工作区：工具从 exec 里取 cwd，所以这里必须让 cwd 指到临时目录。
  const addText = await byName.get('canon_add').execute({
    kind: 'decision',
    statement: '所有对外网关调用的超时默认 8 秒。',
    aliases: ['网关超时'],
    note: '测试登记',
  }, exec);
  assert.ok(addText.includes('D-001'), `应返回新 id：${addText.slice(0, 80)}`);
  assert.ok(addText.includes('canon:D-001@r1'), '应给出可直接粘贴的标记');

  await fs.writeFile(
    path.join(dir, 'docs', 'api.md'),
    '# 接口\n\n所有对外网关调用的超时默认 8 秒。<!-- canon:D-001@r1 -->\n',
    'utf8',
  );

  const checkText = await byName.get('canon_check').execute({}, exec);
  assert.ok(checkText.includes('口径 1 条'), `体检应看到 1 条口径：${checkText.slice(0, 120)}`);
  assert.ok(!checkText.includes('DANGLING'), '不该有悬空标记');

  const listText = await byName.get('canon_list').execute({}, exec);
  assert.ok(listText.includes('D-001'));
  assert.ok(listText.includes('网关超时 8 秒') || listText.includes('超时默认'), '标题要显示出来');

  const getText = await byName.get('canon_get').execute({ id: 'D-001' }, exec);
  assert.ok(getText.includes('docs/api.md:3'), `应列出引用位置：${getText.slice(0, 200)}`);

  const resolveText = await byName.get('canon_resolve').execute({
    items: [{ entryId: 'D-001', file: 'docs/api.md', outcome: 'confirmed', note: '这处只提概念' }],
  }, exec);
  assert.ok(resolveText.includes('✓'), `核验应通过：${resolveText}`);

  const updateText = await byName.get('canon_update').execute({
    id: 'D-001',
    change: 'semantic',
    statement: '所有对外网关调用的超时默认 5 秒。',
    note: '压到 5 秒',
  }, exec);
  assert.ok(updateText.includes('r1 → r2'), `应涨版本：${updateText.slice(0, 120)}`);
  assert.ok(updateText.includes('docs/api.md:3'), '应列出受影响位置');
});

await test('工具把存储错误翻成可读说明，不抛栈', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-host-err-'));
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  const byName = new Map(registered.map((definition) => [definition.name, definition]));
  const exec = { agent: { session: { header: { cwd: dir } } } };
  const text = await byName.get('canon_get').execute({ id: 'D-404' }, exec);
  assert.ok(text.includes('没有找到'), `应是可读说明：${text}`);
  assert.ok(!text.includes('    at '), '不该把栈吐给模型');
});

await test('工作区之间互不干扰（按 cwd 分实例）', async () => {
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-ws-a-'));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-ws-b-'));
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  const byName = new Map(registered.map((definition) => [definition.name, definition]));
  const execA = { agent: { session: { header: { cwd: dirA } } } };
  const execB = { agent: { session: { header: { cwd: dirB } } } };

  await byName.get('canon_add').execute({ kind: 'decision', statement: 'A 库的决策' }, execA);
  const listB = await byName.get('canon_list').execute({}, execB);
  assert.ok(listB.includes('口径 0 条'), `B 库应还是空的：${listB.slice(0, 80)}`);
  const listA = await byName.get('canon_list').execute({}, execA);
  assert.ok(listA.includes('D-001'), 'A 库应保留自己的条目');
});

process.stdout.write('\nsummary\n');
process.stdout.write(`  ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n');
  for (const item of failures) {
    process.stdout.write(`\n  ${item.name}\n  ${item.error?.stack ?? item.error}\n`);
  }
  process.exitCode = 1;
}
