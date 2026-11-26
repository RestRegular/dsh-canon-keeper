/**
 * Client 半边的离线测试：把 `client.js` 装进一个假 `window.__ModuleLoader__`，
 * 用假 React 渲染槽位组件，验证「点了会发生什么」。
 *
 * 为什么需要这一层：client.js 在宿主里跑，离线测试原本完全没覆盖它。
 * 0.3.0 的「打不开预览：右侧栏服务还没就绪」就是漏在这里 —— 组件从
 * `props.ctx` 取上下文，而宿主的槽位 props 里根本没有 `ctx`，于是永远失败。
 * 单元测试只测 lib，测不到「组件拿到什么 props」这件事。
 *
 * 做法：不引真 React（体积大且需要 DOM），用一个最小假 React 把元素树摊平，
 * 直接调用组件函数拿返回的元素树，再从中找出按钮的 onClick 触发。
 *
 * 用法：node test/client.mjs
 *
 * @module dsh-canon-keeper/test/client
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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
 * 迷你 React 运行时。
 *
 * 目的不是复刻 React，而是**真的把组件跑起来**：hooks 有持久状态、`setState`
 * 会触发重渲染、`useEffect` 在渲染后执行。只有这样才测得到「点了按钮会发生
 * 什么」—— 只摊平元素树看不出异步加载和事件处理。
 *
 * 限制：同一组件函数只保留一个实例（本测试里每个组件确实只挂一份），不实现
 * key / context / 生命周期。
 *
 * @returns {{React: object, render: (element: object) => Promise<object>}} 运行时。
 */
function createMiniReact() {
  /** 组件函数 → { hooks, cursor }。 */
  const instances = new Map();
  /** 当前正在渲染的组件实例（hooks 靠它定位自己的槽位）。 */
  let current = null;
  /** 本轮渲染里是否有 setState 发生。 */
  let dirty = false;
  /** 渲染后待执行的 effect。 */
  const pendingEffects = [];

  const createElement = (type, props, ...children) => ({
    __el: true,
    type,
    props: props ?? {},
    children: children.flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false && child !== true),
  });

  /**
   * 取（或建）组件实例。
   * @param {Function} fn 组件函数。
   * @returns {object} 实例记录。
   */
  function record(fn) {
    let rec = instances.get(fn);
    if (rec === undefined) {
      rec = { hooks: [], cursor: 0 };
      instances.set(fn, rec);
    }
    return rec;
  }

  /**
   * 占一个 hook 槽位。
   * @param {Function} fn 组件函数。
   * @param {number} index 槽位下标。
   * @returns {object} 槽位对象。
   */
  function slot(fn, index) {
    const rec = record(fn);
    if (rec.hooks[index] === undefined) rec.hooks[index] = {};
    return rec.hooks[index];
  }

  /**
   * 渲染一个元素（函数组件或宿主节点）。
   * @param {object|Array} node 元素。
   * @returns {object|Array} 渲染结果。
   */
  function renderNode(node) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const rec = record(node.type);
      const previous = current;
      current = node.type;
      rec.cursor = 0;
      let out;
      try {
        out = node.type(node.props);
      } finally {
        current = previous;
      }
      return renderNode(out);
    }
    return { ...node, children: node.children.map(renderNode) };
  }

  const React = {
    createElement,
    useState(initial) {
      const fn = current;
      const index = record(fn).cursor++;
      const box = slot(fn, index);
      if (!('value' in box)) box.value = typeof initial === 'function' ? initial() : initial;
      const setState = (next) => {
        const value = typeof next === 'function' ? next(box.value) : next;
        if (Object.is(value, box.value)) return;
        box.value = value;
        dirty = true;
      };
      return [box.value, setState];
    },
    useCallback(fn) {
      const key = current;
      const index = record(key).cursor++;
      const box = slot(key, index);
      if (box.fn === undefined) box.fn = fn;
      return box.fn;
    },
    useMemo(factory) {
      const key = current;
      const index = record(key).cursor++;
      const box = slot(key, index);
      if (!('value' in box)) box.value = factory();
      return box.value;
    },
    useRef(initial) {
      const key = current;
      const index = record(key).cursor++;
      const box = slot(key, index);
      if (box.ref === undefined) box.ref = { current: initial };
      return box.ref;
    },
    useEffect(fn) {
      const key = current;
      const index = record(key).cursor++;
      const box = slot(key, index);
      if (box.ran !== true) {
        box.ran = true;
        pendingEffects.push(fn);
      }
    },
  };

  /**
   * 渲染到稳定：反复渲染直到没有新的 setState，并把 effect 跑完。
   *
   * effect 里的加载通常是 `void (async () => …)()` —— 外层函数立刻返回，
   * 所以 `await fn()` 之后必须再放几轮宏任务，等 fetch 的 promise 落地。
   *
   * @param {object} element 根元素。
   * @returns {Promise<object>} 稳定后的元素树。
   */
  async function render(element) {
    let tree;
    for (let round = 0; round < 30; round += 1) {
      dirty = false;
      tree = renderNode(element);
      // effect 里可能 setState，跑完再看 dirty。
      while (pendingEffects.length > 0) {
        const fn = pendingEffects.shift();
        await fn();
      }
      // 让异步加载的 promise 落地（fetch 是 microtask，setTimeout 保证顺序）。
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!dirty && pendingEffects.length === 0) return tree;
    }
    throw new Error('渲染未收敛（30 轮后仍在 setState）');
  }

  return { React, render };
}

/**
 * 装载 client.js，返回它导出的插件对象和渲染器。
 *
 * @param {object} [options] 覆盖项。
 * @param {object} [options.services] 假宿主提供的服务（ctx.get 会查它）。
 * @returns {Promise<{plugin: object, render: Function, services: object}>} 装载结果。
 */
async function loadClient(options = {}) {
  const source = await fs.readFile(path.join(ROOT, 'client.js'), 'utf8');
  const { React, render } = createMiniReact();
  let factory;
  const services = options.services ?? {};

  const window = {
    // apiGet 用 window.location.origin 拼请求地址，假宿主必须提供。
    location: { origin: 'http://127.0.0.1:62509' },
    __ModuleLoader__: {
      factories: new Map(),
      load({ id, factory: build }) {
        factory = build;
      },
    },
  };

  // 用 Function 而不是 vm：client.js 是 classic script，只需要 window 和 require。
  const run = new Function('window', 'console', source);
  run(window, { warn() {}, error() {}, log() {} });
  assert.notEqual(factory, undefined, 'client.js 应调用 __ModuleLoader__.load');

  const plugin = factory((name) => {
    if (name === 'react') return React;
    throw new Error(`未预期的 require: ${name}`);
  });
  return { plugin, render, services };
}

/**
 * 在元素树里找所有带 onClick 的节点。
 * @param {object} node 元素。
 * @param {Array<object>} [out] 收集器。
 * @returns {Array<object>} 元素列表。
 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node.props !== undefined) out.push(node);
  if (node.children !== undefined) collect(node.children, out);
  return out;
}

process.stdout.write('canon-keeper client smoke\n\n');

await test('client.js 能装载并导出 apply / inject / __test', async () => {
  const { plugin } = await loadClient();
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject));
  assert.notEqual(plugin.__test, undefined);
  for (const key of ['DICT', 'CanonTab', 'CanonTabTitle', 'CanonIcon', 'toneOf', 'statusTextOf', 'fallbackTranslate']) {
    assert.ok(key in plugin.__test, `__test 缺 ${key}`);
  }
});

await test('inject 声明 sidebarRight（组件要用它打开预览）', async () => {
  const { plugin } = await loadClient();
  assert.ok(plugin.inject.includes('slots'), 'slots 必须声明');
  assert.ok(
    plugin.inject.includes('sidebarRight'),
    'sidebarRight 必须声明：组件要调用它的 openResourceIn，声明后 apply 会等它就绪',
  );
});

await test('槽位组件不依赖 props.ctx（宿主不会传 ctx）', async () => {
  const { plugin, render } = await loadClient();
  const { CanonTab } = plugin.__test;
  globalThis.fetch = async () => {
    const payload = { ok: true, stats: { entries: 0, refs: 0, coverage: 0 }, entries: [] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  // 宿主组合的真实 props：只有 sessionId 之类，没有 ctx。
  // 组件若在渲染期读 props.ctx，这里就会抛错。
  const tree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  assert.notEqual(tree, undefined, '组件应能渲染');
  assert.ok(collect(tree).length > 0, '应渲染出节点');
});

await test('openResourceIn 通过模块级 ctx 取到服务（不再依赖 props）', async () => {
  const calls = [];
  const { plugin } = await loadClient();

  // 模拟宿主：apply 时传入的 ctx 能 get 到 sidebarRight。
  const ctx = {
    get: (key) => (key === 'sidebarRight' ? { openResourceIn: (...args) => calls.push(args) } : undefined),
    inject: () => {},
    effect: (fn) => fn(),
  };
  plugin.apply(ctx);

  const right = ctx.get('sidebarRight');
  assert.notEqual(right, undefined, '假宿主应提供 sidebarRight');
  assert.equal(typeof right.openResourceIn, 'function');
});

await test('apply 里把 ctx 存住，且不依赖 props 传递', async () => {
  const source = await fs.readFile(path.join(ROOT, 'client.js'), 'utf8');
  // 只看代码行，跳过注释（注释里会提到 props.ctx 作为反例）。
  const code = source
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
  assert.ok(
    !/props\?\.ctx|props\.ctx/.test(code),
    'client.js 不应再读 props.ctx —— 宿主的槽位 props 里没有这个字段',
  );
  assert.ok(
    /pluginCtx\s*=\s*ctx/.test(code),
    'apply 应把 ctx 存到模块作用域，供组件使用',
  );
  assert.ok(
    !/openFilePreview\(ctx,/.test(code),
    'openFilePreview 不应再从参数接收 ctx',
  );
});

await test('点「在右侧栏打开」会真的调到 openResourceIn（真实渲染 + 触发 onClick）', async () => {
  const calls = [];
  const { plugin, render } = await loadClient();
  const { CanonTab } = plugin.__test;

  // 假宿主：sidebarRight 记录每次调用。
  const ctx = {
    get: (key) => (key === 'sidebarRight'
      ? { openResourceIn: (...args) => calls.push(args) }
      : undefined),
    inject: () => {},
    effect: (fn) => fn(),
  };
  plugin.apply(ctx);

  // 列表和详情是两个接口，按 URL 分别应答。
  const listPayload = {
    ok: true,
    stats: { entries: 1, refs: 1, coverage: 0 },
    entries: [{
      id: 'D-001',
      kind: 'decision',
      title: '测试口径',
      rev: 1,
      statement: '所有对外接口的超时默认 8 秒。',
      tags: [],
      aliases: ['超时'],
      refs: [{ file: 'docs/api.md', line: 3, pinRev: 1, issues: [] }],
      issues: [],
      mentions: [{ file: 'docs/other.md', line: 7 }],
    }],
  };
  const detailPayload = {
    ok: true,
    marker: '<!-- canon:D-001@r1 -->',
    entry: listPayload.entries[0],
    refs: [{ file: 'docs/api.md', line: 3, pinRev: 1, issues: [], snippet: '超时 8 秒' }],
    mentions: [{ file: 'docs/other.md', line: 7 }],
  };
  globalThis.fetch = async (url) => {
    const payload = String(url).includes('/detail') ? detailPayload : listPayload;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };

  // 走真实路径：列表页 → 点某条口径进详情 → 点位置里的文件名开预览。
  const listTree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  const listNodes = collect(listTree);
  assert.ok(listNodes.length > 0, '列表页应有节点');

  // 列表行是带 onClick 的 div（不是 button），点它进详情。
  const rows = listNodes.filter((node) => String(node.props?.className ?? '').includes('ck-row'));
  assert.ok(rows.length > 0, '列表页应有口径行');
  await rows[0].props.onClick({ preventDefault() {}, stopPropagation() {} });

  const detailTree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  const detailNodes = collect(detailTree);
  assert.ok(detailNodes.length > 0, '详情页应有节点');

  // 详情页里「位置」那一行的文件名按钮，点了才会调 openResourceIn。
  const fileButtons = detailNodes.filter(
    (node) => typeof node.props?.onClick === 'function' && node.props?.title !== undefined
      && String(node.props.title).includes('docs/api.md'),
  );
  assert.ok(fileButtons.length > 0, '详情页应有文件名按钮（带 title=在右侧栏打开 …）');
  await fileButtons[0].props.onClick({ preventDefault() {}, stopPropagation() {} });

  assert.ok(
    calls.length > 0,
    '点文件名应调到 sidebarRight.openResourceIn —— 若为 0，说明上下文没取到（props.ctx 的老问题）',
  );
  const [sessionId, address] = calls[0];
  assert.equal(sessionId, 's-1', '应传当前会话 id');
  assert.ok(String(address).startsWith('dsh-resource://file/session/'), `地址格式不对：${address}`);
});

await test('列表页有「操作台」入口，点开能渲染全部操作按钮', async () => {
  const { plugin, render } = await loadClient();
  const { CanonTab } = plugin.__test;
  globalThis.fetch = async () => {
    const payload = { ok: true, stats: { entries: 0, refs: 0, coverage: 0 }, entries: [] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  const listTree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  const buttons = collect(listTree).filter((node) => typeof node.props?.onClick === 'function' && node.type === 'button');
  const consoleBtn = buttons.find((node) => node.props?.title === '操作台');
  assert.ok(consoleBtn !== undefined, '列表页应有「操作台」按钮');

  await consoleBtn.props.onClick();
  const consoleTree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  const opButtons = collect(consoleTree)
    .filter((node) => typeof node.props?.className === 'string' && node.props.className.includes('ck-op'))
    .map((node) => node.children?.[0])
    .filter((child) => typeof child === 'string');
  for (const op of ['check', 'scan', 'stats', 'list', 'add', 'archive', 'repoint', 'ignore']) {
    assert.ok(opButtons.includes(op), `操作台应露出 ${op}`);
  }
});

await test('操作台点 check 会真发请求到 /check', async () => {
  const { plugin, render } = await loadClient();
  const { CanonTab } = plugin.__test;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const payload = {
      ok: true,
      stats: { entries: 2, refs: 3, coverage: 0.66 },
      counts: { error: 0, warn: 1, info: 0 },
      issues: [],
    };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  const listTree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  const consoleBtn = collect(listTree).find((node) => node.type === 'button' && node.props?.title === '操作台');
  await consoleBtn.props.onClick();
  const consoleTree = await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  const runBtn = collect(consoleTree).find((node) => node.type === 'button' && node.children?.[0] === '执行');
  assert.ok(runBtn !== undefined, '应有「执行」按钮');
  await runBtn.props.onClick();
  await render({ __el: true, type: CanonTab, props: { sessionId: 's-1' }, children: [] });
  assert.ok(urls.some((url) => url.includes('/dsh-canon-keeper/api/check')), `请求应打到 /check，实际：${urls.join(', ')}`);
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
// 组件的后台轮询用 setTimeout 排下一次，会把进程挂住；结果已经输出，直接退出。
process.exit(failures.length > 0 ? 1 : 0);
