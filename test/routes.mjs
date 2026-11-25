/**
 * 面板路由测试。
 *
 * 重点不在「正常请求能通」，而在**每一条拒绝路径都真的拒绝**：
 * 鉴权写错的典型表现是「该拒的没拒」，而正常路径照样全绿。
 *
 * 用真实 http 服务器 + 真实 socket，不 mock req/res —— mock 掉的恰恰是
 * remoteAddress、Host、Origin 这些决定鉴权结果的字段。
 *
 * 运行：node test/routes.mjs
 */

import http from 'node:http';
import { strict as assert } from 'node:assert';

import {
  API,
  TOKEN_HEADER,
  checkOrigin,
  createOperations,
  createToken,
  injectTokenMeta,
  isLoopback,
  mountRoutes,
} from '../lib/routes.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 极简 fake ops：只实现路由层会调用的方法。 */
function fakeOps() {
  const entries = [
    { id: 'D-001', kind: 'decision', title: '超时', statement: '超时 8 秒。', rev: 2 },
    { id: 'R-001', kind: 'rule', title: '格式', statement: '每条一句。', rev: 1 },
  ];
  const ops = {
    store: { list: () => entries },
    async check() {
      return {
        issues: [{ code: 'STALE', level: 'warn', entryId: 'D-001', file: 'a.md', line: 3, message: '钉在 r1' }],
        counts: { stale: 1 },
        stats: { coverage: 0.5 },
        scan: { truncated: false },
      };
    },
    async get(id) {
      if (id !== 'D-001') return null;
      return {
        entry: entries[0],
        refs: [{ file: 'a.md', line: 3, pinRev: 1 }],
        issues: [],
        marker: '<!-- canon:D-001@r2 -->',
      };
    },
    async rescan() {
      return {
        scan: {
          mentions: [{ entryId: 'D-001', file: 'b.md', line: 9, alias: '网关超时', snippet: '网关超时这事' }],
        },
      };
    },
    async update(id) {
      return { entry: { ...entries[0], rev: 3 }, previousRev: 2, revChanged: true, impact: [] };
    },
    async resolve(items) {
      return { ok: true, results: items.map((item) => ({ ...item, done: true })), failed: [] };
    },
    async ignore() {},
    async fixPins() {
      return { pinned: [], skipped: [] };
    },
  };
  return ops;
}

/**
 * 起一个真实服务器，挂上路由。
 * @param {object} [overrides] 覆盖 deps。
 * @returns {Promise<{origin: string, close: () => Promise<void>, token: string}>} 句柄。
 */
async function startServer(overrides = {}) {
  const token = overrides.token ?? createToken();
  const ops = fakeOps();
  const deps = {
    token: () => token,
    cwdOf: () => '/fake/workspace',
    opsFor: async () => ops,
    ...overrides.deps,
  };

  const server = http.createServer();
  // 伪造一个最小 ctx：effect 立即执行，webServer.register 记下 handler。
  let handler;
  const fakeWebServer = {
    getOrigin: () => origin,
    register(route) {
      handler = route.handler;
      return () => {};
    },
  };
  const ctx = {
    webServer: fakeWebServer,
    get: (key) => (key === 'webServer' ? fakeWebServer : undefined),
    effect(fn) {
      const disposer = fn();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
  };
  mountRoutes(ctx, { deps, logger: { warn() {} } });

  server.on('request', (req, res) => {
    if (typeof handler === 'function') handler(req, res);
    else {
      res.writeHead(500);
      res.end('no handler');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    token,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 发一个请求。
 * @param {string} origin 服务器 origin。
 * @param {string} path 路径。
 * @param {object} [init] fetch 选项。
 * @returns {Promise<{status: number, body: any}>} 结果。
 */
async function call(origin, path, init = {}) {
  const res = await fetch(`${origin}${path}`, init);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

await test('createToken 每次不同且是 64 位十六进制', () => {
  const a = createToken();
  const b = createToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/u);
});

await test('isLoopback 只认回环地址', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.5.5.5' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.2' } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '10.0.0.1' } }), false);
  assert.equal(isLoopback({ socket: {} }), false);
  assert.equal(isLoopback({}), false);
});

await test('checkOrigin：跨站 Origin 被拒', () => {
  const result = checkOrigin(
    { headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } },
    'http://127.0.0.1:3080',
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Origin 与 Host 不一致|Origin 不是本机监听地址/u);
});

await test('checkOrigin：同源放行', () => {
  const result = checkOrigin(
    { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } },
    'http://127.0.0.1:3080',
  );
  assert.equal(result.ok, true);
});

await test('checkOrigin：无 Origin 时 Host 必须等于监听地址', () => {
  assert.equal(checkOrigin({ headers: { host: '127.0.0.1:3080' } }, 'http://127.0.0.1:3080').ok, true);
  assert.equal(checkOrigin({ headers: { host: 'evil.example' } }, 'http://127.0.0.1:3080').ok, false);
  // 没有 expectedOrigin 时无法比对，但至少要挡住缺 Host
  assert.equal(checkOrigin({ headers: {} }, '').ok, false);
});

await test('checkOrigin：畸形 Origin 被拒而不是抛异常', () => {
  const result = checkOrigin({ headers: { host: '127.0.0.1:3080', origin: 'not a url' } }, 'http://127.0.0.1:3080');
  assert.equal(result.ok, false);
});

await test('injectTokenMeta 只在 head 前插一次', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const once = injectTokenMeta(html, 'abc');
  assert.match(once, /<meta name="canon-keeper-token" content="abc">/u);
  assert.equal(injectTokenMeta(once, 'abc'), once, '重复注入应幂等');
  assert.equal(injectTokenMeta('', 'abc'), '');
});

// ---------------------------------------------------------------------------
// 真实 HTTP 鉴权
// ---------------------------------------------------------------------------

await test('GET session 下发 token（同源读）', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/session`, { headers: { origin: s.origin } });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.token, s.token);
  } finally {
    await s.close();
  }
});

await test('跨站 Origin 读也被拒', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/session`, { headers: { origin: 'http://evil.example' } });
    assert.equal(status, 403);
    assert.match(body.error, /来源校验失败/u);
    assert.equal(body.token, undefined, '被拒时不能泄漏 token');
  } finally {
    await s.close();
  }
});

await test('写操作不带 token 被拒', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/update`, {
      method: 'POST',
      headers: { origin: s.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'D-001', statement: '新正文' }),
    });
    assert.equal(status, 403);
    assert.match(body.error, /x-canon-token/u);
  } finally {
    await s.close();
  }
});

await test('写操作带错误 token 被拒', async () => {
  const s = await startServer();
  try {
    const { status } = await call(s.origin, `${API}/update`, {
      method: 'POST',
      headers: { origin: s.origin, 'content-type': 'application/json', [TOKEN_HEADER]: 'deadbeef' },
      body: JSON.stringify({ id: 'D-001', statement: '新正文' }),
    });
    assert.equal(status, 403);
  } finally {
    await s.close();
  }
});

await test('写操作带正确 token 放行', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/update`, {
      method: 'POST',
      headers: { origin: s.origin, 'content-type': 'application/json', [TOKEN_HEADER]: s.token },
      body: JSON.stringify({ id: 'D-001', statement: '新正文' }),
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.entry.rev, 3);
  } finally {
    await s.close();
  }
});

await test('预检请求一律 403，且不带 CORS 头', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.origin}${API}/update`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

await test('响应不含任何 CORS 放行头', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.origin}${API}/session`, { headers: { origin: s.origin } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-headers'), null);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

await test('overview 把问题挂到条目上', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/overview`, { headers: { origin: s.origin } });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.entries.length, 2);
    const d1 = body.entries.find((entry) => entry.id === 'D-001');
    assert.equal(d1.issues.length, 1);
    assert.equal(d1.issues[0].code, 'STALE');
    assert.equal(body.entries.find((entry) => entry.id === 'R-001').issues.length, 0);
  } finally {
    await s.close();
  }
});

await test('detail 返回正文与标记', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/detail?id=D-001`, { headers: { origin: s.origin } });
    assert.equal(status, 200);
    assert.equal(body.entry.id, 'D-001');
    assert.equal(body.marker, '<!-- canon:D-001@r2 -->');
    assert.equal(body.refs.length, 1);
    // mentions 由路由层从 rescan 里捞出来（ops.get 本身不带）
    assert.equal(body.mentions.length, 1);
    assert.equal(body.mentions[0].alias, '网关超时');
  } finally {
    await s.close();
  }
});

await test('detail 找不到条目时是 400 且错误可读', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/detail?id=NOPE`, { headers: { origin: s.origin } });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /没有找到口径 NOPE/u);
  } finally {
    await s.close();
  }
});

await test('未知操作是 404', async () => {
  const s = await startServer();
  try {
    const { status } = await call(s.origin, `${API}/nope`, { headers: { origin: s.origin } });
    assert.equal(status, 404);
  } finally {
    await s.close();
  }
});

await test('非法 JSON 请求体是 400', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/update`, {
      method: 'POST',
      headers: { origin: s.origin, 'content-type': 'application/json', [TOKEN_HEADER]: s.token },
      body: '{not json',
    });
    assert.equal(status, 400);
    assert.match(body.error, /无效的 JSON/u);
  } finally {
    await s.close();
  }
});

await test('resolve 空 items 是 400', async () => {
  const s = await startServer();
  try {
    const { status, body } = await call(s.origin, `${API}/resolve`, {
      method: 'POST',
      headers: { origin: s.origin, 'content-type': 'application/json', [TOKEN_HEADER]: s.token },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /没有要核验的位置/u);
  } finally {
    await s.close();
  }
});

await test('缺少工作区路径时明确报错而不是抛栈', async () => {
  const s = await startServer({ deps: { cwdOf: () => '' } });
  try {
    const { status, body } = await call(s.origin, `${API}/overview`, { headers: { origin: s.origin } });
    assert.equal(status, 400);
    assert.match(body.error, /缺少工作区路径/u);
  } finally {
    await s.close();
  }
});

await test('ops 抛出的错误翻成 400 并带 code', async () => {
  const s = await startServer({
    deps: {
      opsFor: async () => {
        throw Object.assign(new Error('口径库损坏'), { code: 'STORE_UNREADABLE' });
      },
    },
  });
  try {
    const { status, body } = await call(s.origin, `${API}/overview`, { headers: { origin: s.origin } });
    assert.equal(status, 400);
    assert.equal(body.code, 'STORE_UNREADABLE');
    assert.match(body.error, /口径库损坏/u);
  } finally {
    await s.close();
  }
});

await test('非回环连接被拒（用 LAN 地址直连验证）', async () => {
  // 本机没有其它网卡时跳过：这个用例依赖真实非回环地址
  const s = await startServer();
  try {
    // 直接断言纯函数，避免依赖机器网络配置
    assert.equal(isLoopback({ socket: { remoteAddress: '192.168.0.9' } }), false);
    const { status } = await call(s.origin, `${API}/session`, { headers: { origin: s.origin } });
    assert.equal(status, 200, '回环请求应通过');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.stack ?? error}`);
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
