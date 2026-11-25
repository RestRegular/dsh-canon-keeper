/**
 * 面板用的回环 HTTP 路由。
 *
 * 面板走 `fetch('/dsh-canon-keeper/api/…')`，与 Agent 工具共享同一份 `CanonOps`。
 * 这一层只做三件事：鉴权、参数校验、JSON 包装。任何业务判断都在 `ops` 里，
 * 否则面板与工具会悄悄分叉。
 *
 * ## 鉴权模型
 *
 * 本机回环并不等于安全：任何本机进程都能发请求，浏览器里任意网页也能发跨站请求
 * （DNS rebinding 还能让 Origin 看着像本机）。所以分三级：
 *
 * | 操作 | 回环 | Origin/Host 一致 | x-canon-token |
 * |---|---|---|---|
 * | 读（GET） | 必须 | 必须 | 不要求 |
 * | 写（POST/PUT/DELETE） | 必须 | 必须 | 必须 |
 *
 * 写必须带 token，token 每次进程启动随机生成，通过同源 `GET /api/session` 交给面板。
 *
 * ### 为什么 token 走同源 GET 而不是注入 index.html
 *
 * 桌面端 index.html 由安装包的静态 dist 直出，`webServer.tapIndex` 的函数变换
 * **永远过不去**（见 `webserver/index-inject` 事件的注释与 dsh-whale-widget 的踩坑），
 * 所以「tapIndex 注入 meta」在桌面端根本不会发生 —— 照那个方案写，面板会永远
 * 拿不到 token、写操作全部 403。
 *
 * 同源 GET 拿 token 是安全的，因为跨站页面**读不到响应体**（我们不返回任何
 * `Access-Control-Allow-*`），即便拿到了，带自定义头的请求会触发预检，而这里从不
 * 批准预检。于是「读得到」这件事只对同源页面成立。
 *
 * 被拒时返回 403 并说明**哪一条**没过，但不回显 token 本身。
 *
 * @module dsh-canon-keeper/routes
 */

import { randomBytes } from 'node:crypto';

/** 路由前缀。 */
export const ROUTE = '/dsh-canon-keeper';

/** API 子前缀。 */
export const API = `${ROUTE}/api`;

/** token 的 HTTP 头名。 */
export const TOKEN_HEADER = 'x-canon-token';

/** index.html 里承载 token 的 meta 名。 */
export const TOKEN_META = 'canon-keeper-token';

/** 请求体上限。够放下一批 resolve 项。 */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * 生成进程级随机 token。
 * @returns {string} 32 字节十六进制。
 */
export function createToken() {
  return randomBytes(32).toString('hex');
}

/**
 * 判断请求是否来自本机回环。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否回环。
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.');
}

/**
 * 校验 Origin/Host 一致。
 *
 * 浏览器发起的跨站请求一定带 `Origin`，且与 `Host` 不同；同源请求两者一致。
 * 没有 `Origin` 的请求（curl、部分同源 GET）按 Host 与监听地址比对。
 *
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {string} [expectedOrigin] 期望的 origin（`webServer.getOrigin()`）。
 * @returns {{ok: boolean, reason?: string}} 结果。
 */
export function checkOrigin(req, expectedOrigin) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') {
    return { ok: false, reason: '缺少 Host 头' };
  }
  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: 'Origin 头不是合法 URL' };
    }
    if (originHost !== host) {
      return { ok: false, reason: 'Origin 与 Host 不一致' };
    }
    if (typeof expectedOrigin === 'string' && expectedOrigin !== '') {
      if (origin !== expectedOrigin) {
        return { ok: false, reason: 'Origin 不是本机监听地址' };
      }
    }
    return { ok: true };
  }
  // 无 Origin：只接受 Host 就是监听地址本身。
  if (typeof expectedOrigin === 'string' && expectedOrigin !== '') {
    let expectedHost;
    try {
      expectedHost = new URL(expectedOrigin).host;
    } catch {
      return { ok: false, reason: '监听地址无法解析' };
    }
    if (host !== expectedHost) {
      return { ok: false, reason: 'Host 不是本机监听地址' };
    }
  }
  return { ok: true };
}

/**
 * 读完整请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<string>} 文本。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {unknown} value 响应体。
 * @param {number} [status] 状态码。
 * @returns {void}
 */
export function sendJson(res, value, status = 200) {
  try {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (error) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    } catch {
      /* 响应已断开 */
    }
  }
}

/**
 * 把 token 注入 HTML。
 *
 * 只用于 Web 形态（非桌面壳）的 index 变换；桌面端走 `GET /api/session`。
 * 保留这个纯函数是为了让注入逻辑可单测，且 Web 形态下能省一次往返。
 *
 * @param {string} html 原始 index.html。
 * @param {string} token 本次进程的 token。
 * @returns {string} 注入后的 HTML。
 */
export function injectTokenMeta(html, token) {
  if (typeof html !== 'string' || html === '') return html;
  const meta = `<meta name="${TOKEN_META}" content="${token}">`;
  if (html.includes(`name="${TOKEN_META}"`)) return html;
  if (html.includes('</head>')) return html.replace('</head>', `${meta}</head>`);
  return `${meta}${html}`;
}

/**
 * 面板操作表。
 *
 * 每个处理函数返回 `{ok, ...}`；`ok:false` 会变成 400。抛出的异常由挂载层
 * 统一转 500，并把 message 交给客户端（不回栈）。
 *
 * @param {object} deps 依赖。
 * @param {(cwd: string) => Promise<object>} deps.opsFor 按工作区取 ops。
 * @param {() => string} deps.token 取本次进程 token。
 * @param {(req: object) => string} deps.cwdOf 从请求取工作区根。
 * @returns {Record<string, Function>} op → 处理函数。
 */
export function createOperations(deps) {
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

  /**
   * 包一层：取 ops、跑、把 StoreError 翻成可读错误。
   * @param {object} payload 请求体/查询参数。
   * @param {(ops: object) => Promise<object>|object} body 业务。
   * @returns {Promise<object>} 结果。
   */
  const run = async (payload, body) => {
    const cwd = deps.cwdOf(payload);
    if (typeof cwd !== 'string' || cwd === '') return fail('缺少工作区路径');
    try {
      const ops = await deps.opsFor(cwd);
      const value = await body(ops);
      return { ok: true, ...value };
    } catch (error) {
      // StoreError 带 code，前端据此区分「坏档」这类需要人介入的状态。
      // 注意 opsFor 本身也可能抛（坏档在构造时就拒绝），所以它必须在 try 里。
      const code = error?.code ?? error?.name ?? 'ERROR';
      return fail(String(error?.message ?? error), { code });
    }
  };

  return {
    ping() {
      return { ok: true, plugin: 'dsh-canon-keeper', version: 1 };
    },

    /**
     * 下发本次进程的写 token。
     *
     * 只有同源页面读得到响应体（不返回 CORS 头），所以这个 GET 不需要再验 token
     * 本身 —— 验它就成循环了。
     *
     * @returns {object} token。
     */
    session() {
      return { ok: true, token: deps.token() };
    },

    /**
     * 首屏：一次拿回条目、问题、指标。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 结果。
     */
    overview(payload) {
      return run(payload, async (ops) => {
        const report = await ops.check({ force: payload?.force === true || payload?.force === 'true' });
        const entries = ops.store.list();
        const byEntry = new Map();
        for (const issue of report.issues) {
          if (issue.entryId === undefined) continue;
          const list = byEntry.get(issue.entryId) ?? [];
          list.push(issue);
          byEntry.set(issue.entryId, list);
        }
        return {
          entries: entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            statement: entry.statement,
            rev: entry.rev,
            supersededBy: entry.supersededBy ?? null,
            issues: (byEntry.get(entry.id) ?? []).map((issue) => ({
              code: issue.code,
              level: issue.level,
              demoted: issue.demoted === true,
            })),
          })),
          issues: report.issues.slice(0, 200),
          counts: report.counts,
          stats: report.stats,
          truncated: report.scan?.truncated === true,
        };
      });
    },

    /**
     * 单条详情：正文、标记、引用位置、历史。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 结果。
     */
    detail(payload) {
      return run(payload, async (ops) => {
        const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
        if (id === '') throw new Error('缺少 id');
        const result = await ops.get(id);
        // ops.get 找不到时返回 null（不是 {entry:null}）
        if (result === null || result === undefined || result.entry === undefined || result.entry === null) {
          throw new Error(`没有找到口径 ${id}`);
        }
        // ops.get 不带 mentions；从这次扫描里捞出来，面板要用它做「忽略此处」
        const { scan } = await ops.rescan();
        const mentions = (scan.mentions ?? [])
          .filter((item) => item.entryId === id)
          .map((item) => ({ file: item.file, line: item.line, alias: item.alias, snippet: item.snippet }));
        return {
          entry: result.entry,
          refs: result.refs ?? [],
          mentions,
          marker: result.marker,
        };
      });
    },

    /**
     * 改条目（正文 / 标题 / 定位词）。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 结果。
     */
    update(payload) {
      return run(payload, async (ops) => {
        const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
        if (id === '') throw new Error('缺少 id');
        const patch = { change: payload?.change === 'wording' ? 'wording' : 'semantic' };
        if (typeof payload.statement === 'string') patch.statement = payload.statement;
        if (typeof payload.title === 'string') patch.title = payload.title;
        if (Array.isArray(payload.aliases)) patch.aliases = payload.aliases.filter((item) => typeof item === 'string');
        patch.note = typeof payload.note === 'string' ? payload.note : '';
        const result = await ops.update(id, patch, { actor: { kind: 'user', name: 'panel' } });
        return {
          entry: result.entry,
          previousRev: result.previousRev,
          revChanged: result.revChanged,
          impact: result.impact ?? [],
        };
      });
    },

    /**
     * 核验若干位置。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 结果。
     */
    resolve(payload) {
      return run(payload, async (ops) => {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (items.length === 0) throw new Error('没有要核验的位置');
        const result = await ops.resolve(items.map((item) => ({
          entryId: String(item?.entryId ?? ''),
          file: String(item?.file ?? ''),
          line: item?.line === undefined ? undefined : Number(item.line),
          outcome: item?.outcome === 'updated' ? 'updated' : 'confirmed',
          note: String(item?.note ?? ''),
        })), { actor: { kind: 'user', name: 'panel' } });
        return { ok: result.ok, results: result.results, failed: result.failed };
      });
    },

    /**
     * 补钉（只补 rev == 1）。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 结果。
     */
    fixPins(payload) {
      return run(payload, async (ops) => {
        const result = await ops.fixPins();
        return result;
      });
    },

    /**
     * 读某处引用所属段落的原文（面板进入编辑态）。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 段落信息。
     */
    paragraph(payload) {
      return run(payload, async (ops) => {
        const entryId = typeof payload?.id === 'string' ? payload.id.trim() : '';
        const file = typeof payload?.file === 'string' ? payload.file.trim() : '';
        if (entryId === '') throw new Error('缺少 id');
        if (file === '') throw new Error('缺少 file');
        const result = await ops.readParagraph({
          entryId,
          file,
          line: payload?.line === undefined ? undefined : Number(payload.line),
        });
        return result;
      });
    },

    /**
     * 把段落原文写回文件并核验。
     * @param {object} payload 参数。
     * @returns {Promise<object>} 结果。
     */
    editText(payload) {
      return run(payload, async (ops) => {
        const entryId = typeof payload?.id === 'string' ? payload.id.trim() : '';
        const file = typeof payload?.file === 'string' ? payload.file.trim() : '';
        if (entryId === '') throw new Error('缺少 id');
        if (file === '') throw new Error('缺少 file');
        if (typeof payload?.text !== 'string') throw new Error('缺少 text');
        const result = await ops.editText({
          entryId,
          file,
          line: payload?.line === undefined ? undefined : Number(payload.line),
          text: payload.text,
          expectedHash: typeof payload?.expectedHash === 'string' ? payload.expectedHash : undefined,
          note: typeof payload?.note === 'string' ? payload.note : '',
        }, { actor: { kind: 'user', name: 'panel' } });
        return result;
      });
    },
  };
}

/**
 * 挂载回环路由。
 * @param {object} ctx 已注入 webServer 的上下文。
 * @param {object} options 选项。
 * @param {object} options.deps 见 createOperations。
 * @param {object} [options.logger] 日志。
 * @returns {void}
 */
export function mountRoutes(ctx, options) {
  const webServer = ctx?.webServer ?? ctx?.get?.('webServer');
  if (webServer === undefined || typeof webServer.register !== 'function') {
    options?.logger?.warn?.('[dsh-canon-keeper] webServer 服务缺失，面板 API 未启用');
    return;
  }
  const deps = options.deps;
  const operations = createOperations(deps);
  const logger = options.logger;

  /**
   * 取监听地址（可能还没 listen）。
   * @returns {string} origin，取不到时空串。
   */
  const originOf = () => {
    try {
      return typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : '';
    } catch {
      return '';
    }
  };

  try {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        // 1) 回环
        if (!isLoopback(req)) {
          sendJson(res, { ok: false, error: '仅支持本机回环访问' }, 403);
          return;
        }
        // 预检请求一律拒绝：本 API 不支持跨源调用，批准预检等于把写能力
        // 交给任意网页。带自定义头（x-canon-token）的跨源请求必然先预检，
        // 所以这一条同时挡住了「拿到 token 也没用」之外的另一半风险。
        if (req.method === 'OPTIONS') {
          sendJson(res, { ok: false, error: '不支持跨源请求' }, 403);
          return;
        }
        // 2) Origin/Host
        const originCheck = checkOrigin(req, originOf());
        if (!originCheck.ok) {
          sendJson(res, { ok: false, error: `来源校验失败：${originCheck.reason}` }, 403);
          return;
        }
        const method = req.method ?? 'GET';
        const isWrite = method !== 'GET' && method !== 'HEAD';
        // 3) 写操作要求 token
        if (isWrite) {
          const supplied = req.headers?.[TOKEN_HEADER];
          const expected = deps.token();
          if (typeof supplied !== 'string' || supplied === '' || supplied !== expected) {
            sendJson(res, { ok: false, error: `写操作缺少有效的 ${TOKEN_HEADER}` }, 403);
            return;
          }
        }

        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.startsWith(API)
          ? url.pathname.slice(API.length)
          : (url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : '');
        const opFromPath = pathname.replace(/^\//u, '');

        try {
          if (method === 'GET' || method === 'HEAD') {
            const op = opFromPath === '' || opFromPath === 'api' ? (url.searchParams.get('op') ?? 'ping') : opFromPath;
            const handler = operations[op];
            if (typeof handler !== 'function') {
              sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
              return;
            }
            const payload = Object.fromEntries(url.searchParams.entries());
            const result = await handler(payload);
            sendJson(res, result, result.ok === false ? 400 : 200);
            return;
          }
          if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
            let body = {};
            const raw = await readBody(req);
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                sendJson(res, { ok: false, error: '无效的 JSON 请求体' }, 400);
                return;
              }
            }
            const op = typeof body?.op === 'string' && body.op !== '' ? body.op : opFromPath;
            const handler = operations[op];
            if (typeof handler !== 'function') {
              sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
              return;
            }
            const result = await handler(body ?? {});
            sendJson(res, result, result.ok === false ? 400 : 200);
            return;
          }
          sendJson(res, { ok: false, error: `不支持的方法 ${method}` }, 405);
        } catch (error) {
          logger?.warn?.(`[dsh-canon-keeper] 路由错误: ${error?.stack ?? error}`);
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    }), 'dsh-canon-keeper: panel routes');
  } catch (error) {
    logger?.warn?.(`[dsh-canon-keeper] 挂载面板路由失败: ${error?.message ?? error}`);
  }
}
