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
import { apply, Config, normalizeConfig, TOOL_NAMES, ROUTE, API } from '../index.js';

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
 *
 * `inject` 按名字分派：`tools` 收集工具定义，`webServer` 收集路由。两者都是
 * index.js 真实注入的服务，缺哪个都不该让其它用例连带失败。
 *
 * @param {object} [options] 覆盖。
 * @returns {{ctx: object, registered: Array<object>, routes: Array<object>}} 上下文与注册表。
 */
function fakeHost(options = {}) {
  const registered = [];
  const routes = [];
  const sections = [];
  const providers = [];
  const sessions = options.sessions ?? {
    get(id) {
      if (id === 'sess-known') return { header: { id, cwd: options.cwd ?? process.cwd() } };
      return undefined;
    },
  };
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:9999',
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const systemPrompt = {
    section(section) {
      sections.push(section);
      return () => {};
    },
  };
  const skills = {
    registerProvider(build) {
      providers.push(build);
      return () => {};
    },
  };
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    get(key) {
      if (key === 'sessions') return sessions;
      if (key === 'webServer') return webServer;
      if (key === 'systemPrompt') return systemPrompt;
      if (key === 'skills') return skills;
      return undefined;
    },
    inject(names, callback) {
      assert.ok(Array.isArray(names), 'inject 的第一个参数应是数组');
      const scoped = {
        effect(fn) {
          return fn();
        },
        tools: {
          register(definition) {
            registered.push(definition);
          },
        },
        get: ctx.get,
        webServer,
        systemPrompt,
        skills,
      };
      callback(scoped);
    },
    effect(fn) {
      fn();
    },
  };
  return { ctx, registered, routes, sessions, webServer, sections, providers };
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
  assert.equal(std.validate({}).value.storeDir, '.dsh/canon-keeper', 'storeDir 默认 .dsh/canon-keeper');
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

await test('canon_resolve 的 items 是对象数组且逐字段必填', () => {
  const { ctx, registered } = fakeHost();
  apply(ctx, {});
  const resolve = registered.find((definition) => definition.name === 'canon_resolve');
  const items = resolve.parameters.items;
  assert.equal(items.type, 'array');
  assert.equal(items.required, true);
  assert.equal(items.items.type, 'object');
  // 必填只能逐字段写 required: true —— 数组层的 required: [...] 会被宿主 DSL 拒绝。
  assert.equal(Object.hasOwn(items.items, 'required'), false, 'items 内不能出现 required 数组');
  for (const key of ['entryId', 'file', 'note', 'outcome']) {
    assert.equal(items.items.properties[key].required, true, `${key} 应逐字段标 required: true`);
  }
  assert.deepEqual(items.items.properties.outcome.enum, ['updated', 'confirmed']);
});

await test('常驻系统提示：注入一段「什么时候用」，且不含口径正文', () => {
  const { ctx, sections } = fakeHost();
  apply(ctx, {});
  const section = sections.find((item) => item.name === 'canon-keeper:policy');
  assert.notEqual(section, undefined, '应挂上 canon-keeper:policy 段落');
  assert.equal(typeof section.text, 'function', 'text 应是函数（每轮重新求值）');
  const text = section.text();
  assert.ok(text.includes('canon_list'), '要指路到具体工具');
  assert.ok(text.includes('canon:D-001@r3'), '要给一个标记样例');
  assert.ok(text.includes('canon-keeper'), '要指向随包技能');
  // 关键约束：不塞口径正文 —— 注入只讲机制，不讲内容。
  assert.ok(text.length < 1200, `常驻说明要短，实际 ${text.length} 字`);
});

await test('常驻系统提示：injectPrompt=false 时返回空串而不是不挂段落', () => {
  const { ctx, sections } = fakeHost();
  apply(ctx, { injectPrompt: false });
  const section = sections.find((item) => item.name === 'canon-keeper:policy');
  assert.notEqual(section, undefined, '段落仍应挂上（换开关不该留下孤儿段落）');
  assert.equal(section.text(), '', '关掉后应返回空串');
});

await test('随包技能：注册 provider，能列出并加载 canon-keeper', async () => {
  const { ctx, providers } = fakeHost();
  apply(ctx, {});
  assert.equal(providers.length, 1, '应注册一个技能 provider');
  const build = providers[0];
  const registry = build();
  assert.equal(registry.name, 'dsh-canon-keeper');
  const candidates = await registry.list();
  const names = candidates.map((item) => item.name);
  assert.deepEqual(names, ['canon-keeper']);
  const candidate = candidates[0];
  assert.equal(candidate.source, 'bundled');
  assert.equal(candidate.rank, 600, '要和宿主 BUNDLED_SKILL_RANK 对齐');
  assert.equal(candidate.resourceBase.kind, 'directory');
  assert.ok(candidate.description.length >= 40, 'description 是唯一的路由信号，不能太短');
  const loaded = await registry.get({ name: 'canon-keeper' });
  assert.ok(loaded.content.includes('canon:D-001@r3'), '正文应含标记语法');
  assert.ok(loaded.content.includes('canon_resolve'), '正文应讲清各工具分工');
  assert.equal(loaded.rank, undefined, 'rank 是注册表用的，不该进加载结果');
});

await test('随包技能：bundledSkill=false 时不注册', () => {
  const { ctx, providers } = fakeHost();
  apply(ctx, { bundledSkill: false });
  assert.equal(providers.length, 0);
});

await test('常驻提示与随包技能都缺服务时不拖垮工具注册', () => {
  const { ctx, registered } = fakeHost();
  // 模拟老宿主：没有 systemPrompt / skills 服务
  const original = ctx.inject;
  ctx.inject = (names, callback) => {
    if (names.includes('systemPrompt') || names.includes('skills')) return;
    return original(names, callback);
  };
  apply(ctx, {});
  assert.equal(registered.length, 7, '工具注册不受影响');
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

await test('apply 挂载面板路由，前缀与 API 常量一致', () => {
  const { ctx, routes } = fakeHost();
  apply(ctx, {});
  assert.equal(routes.length, 1, '应挂载一条面板路由');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, ROUTE);
  assert.equal(typeof routes[0].handler, 'function');
});

await test('面板的 cwd 只认 sessionId 反查，不接受客户端传路径', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-panel-'));
  const { ctx, routes } = fakeHost({ cwd: dir });
  apply(ctx, {});
  const handler = routes[0].handler;

  /**
   * 直接驱动 handler，绕开真实 socket（鉴权已在 routes.mjs 里用真 socket 验过）。
   * @param {object} options 选项。
   * @returns {Promise<{status: number, body: any}>} 结果。
   */
  const drive = async (options) => {
    const chunks = [];
    const req = {
      method: options.method ?? 'GET',
      url: options.url,
      headers: { host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999', ...(options.headers ?? {}) },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'end') cb();
        return req;
      },
    };
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        res.status = status;
        res.headers = headers ?? {};
      },
      end(text) {
        chunks.push(text);
      },
    };
    await handler(req, res);
    const raw = chunks.join('');
    return { status: res.status, body: raw === '' ? null : JSON.parse(raw) };
  };

  // 不传 sessionId，但直接塞一个 cwd：必须拒绝，绝不能拿它去读写
  const spoofed = await drive({ url: `${API}/overview?cwd=${encodeURIComponent(dir)}` });
  assert.equal(spoofed.status, 400);
  assert.match(spoofed.body.error, /缺少工作区路径/u);

  // 未知会话同样拒绝
  const unknown = await drive({ url: `${API}/overview?sessionId=sess-nope` });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /缺少工作区路径/u);

  // 已知会话才放行，并且用的是会话的 cwd
  const ok = await drive({ url: `${API}/overview?sessionId=sess-known` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.equal(ok.body.ok, true);
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
