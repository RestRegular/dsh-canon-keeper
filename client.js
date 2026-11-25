/**
 * dsh-canon-keeper — Client half.
 *
 * 右侧边栏的「口径」标签页：列表 ↔ 详情两态。
 *
 * 设计上刻意只做两件事 —— **看**和**盖章**：
 *
 * - 看：哪些口径有未处理位置、每一处钉在哪个版本、正文前后差异。
 * - 盖章：逐处给 `updated`（改过文了）/ `confirmed`（核对过、无影响），
 *   或明确「暂不处理」。
 *
 * 不做「一键全部确认」。`confirmed` 强制填备注，因为「我看过了」这句话只有
 * 带上「看到了什么」才算证据；否则一次误点就把未核验洗成了已核验。
 *
 * 几条必须遵守的宿主约定：
 * - 整文件包在 IIFE 里：client bundle 被拼进同一个 classic-script 批次执行，
 *   顶层绑定会与其它插件冲突（重名会让整条 web boot 失败）。
 * - 服务用 `ctx.inject([...], scope => …)` 等待：apply 时一次性 `ctx.get` 取到的
 *   undefined 不会重试，会表现为「插件启用着但标签页不出现」。
 * - 所有 fetch 都带 AbortController 超时：黑洞 socket 不会 reject，没有超时就会
 *   永久 pending，界面从此点不动。
 * - 样式只用 `--dsw-alias-*` token，浅色/深色由宿主继承。
 */
(() => {
  const MODULE_ID = '@restregular/dsh-canon-keeper';

  /** 宿主 facade 已登记过本模块时直接退出（重复加载）。 */
  function alreadyRegistered() {
    const factories = window.__ModuleLoader__?.factories;
    return factories !== undefined && typeof factories.has === 'function' && factories.has(MODULE_ID);
  }

  if (alreadyRegistered()) return;

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: (require) => {
      const React = require('react');
      const h = React.createElement;
      const { useCallback, useEffect, useMemo, useRef, useState } = React;

      const NS = 'dsh-canon-keeper';
      const API = '/dsh-canon-keeper/api';
      const TOKEN_HEADER = 'x-canon-token';
      /** 普通动作超时。 */
      const FETCH_TIMEOUT_MS = 8000;
      /** 轮询超时（比动作短，宁可这一轮空着）。 */
      const POLL_TIMEOUT_MS = 3500;
      /** 列表自动刷新间隔。 */
      const POLL_MS = 4000;
      const PANEL_ID = 'canon-keeper';

      // ------------------------------------------------------------------
      // 文案
      // ------------------------------------------------------------------
      const DICT = {
        zh: {
          'tab.title': '口径',
          'tab.guide': '查看已登记的口径、它们被哪些文档引用，以及每条引用是否还和当前口径一致。',
          'panel.title': '口径',
          'panel.refresh': '重扫',
          'panel.pending': '待处理 {count}',
          'panel.unverified': '未验证 {count}',
          'panel.empty': '还没有登记口径。让 Agent 用 canon_add 登记第一条。',
          'panel.failed': '操作失败：{message}',
          'panel.noSession': '当前标签页没有会话上下文。',
          'panel.coverage': '覆盖率 {value}',
          'panel.back': '返回',
          'panel.statement': '正文',
          'panel.marker': '标记',
          'panel.copyMarker': '复制标记',
          'panel.copied': '已复制',
          'panel.locations': '受影响位置',
          'panel.noLocations': '没有钉住这条口径的位置。',
          'panel.pinnedAt': '钉在 r{rev}',
          'panel.unpinned': '未钉版本',
          'panel.confirm': '核对无影响',
          'panel.updated': '已修改',
          'panel.updatedHint': '文件已在别处改过，点这里核验并记录',
          'panel.editDoc': '修改文档',
          'panel.save': '保存',
          'panel.cancelEdit': '取消',
          'panel.saved': '已保存并核验',
          'panel.editNotLoaded': '段落还没读到，请稍后重试',
          'panel.fileChanged': '文件已被改动，请刷新后重新编辑',
          'panel.openFile': '在右侧栏打开 {file}',
          'panel.openFailed': '打不开预览：右侧栏服务还没就绪',
          'onboard.title': '怎么用',
          'onboard.dismiss': '不再显示',
          'onboard.step1': '左侧列表是已登记的口径，点一条看详情：哪些文档引用了它、哪些过期了。',
          'onboard.step2': '在文档里改完文字后，回这里点「已修改」并写一句备注，那一处就算核验过。',
          'onboard.step3': '新增和修改口径不用手改文件，直接让 Agent 用 canon_add / canon_update 这些工具。',
          'onboard.foot': '口径改了版本号，引用它的旧标记会变黄，提示你逐处确认。',
          'panel.copyFailed': '剪贴板不可用',
          'panel.fixPinsDone': '已补钉 {count} 处',
          'panel.fixPinsNone': '没有可补钉的位置',
          'panel.fixPinsHint': '把 rev 1 的未钉标记补上版本号',
          'panel.pendingNone': '全部已核验',
          'panel.superseded': '已被取代',
          'panel.noteRequired': '核对无影响必须填写备注',
          'panel.notePlaceholder': '写清你核对了什么、为什么不受影响',
          'panel.done': '已处理',
          'panel.history': '修订历史',
          'panel.rev': '第 {rev} 版',
          'panel.semantic': '语义',
          'panel.wording': '措辞',
          'panel.fixPins': '补钉（仅 r1）',
          'panel.mentions': '提到但没标记',
          'panel.mentionHint': '这处提到该口径却没有标记。请手工补上标记，或确认确实无需标记。',
          'panel.stale': '过期',
          'panel.drift': '正文漂移',
          'panel.dangling': '悬空引用',
          'panel.truncated': '文件过多，扫描已截断，结果不完整。',
          'panel.readOnly': '只读模式：没拿到写 token，无法盖章。',
        },
        en: {
          'tab.title': 'Canon',
          'tab.guide': 'Review registered canon entries, which documents reference them, and whether each reference still matches.',
          'panel.title': 'Canon',
          'panel.refresh': 'Rescan',
          'panel.pending': 'Pending {count}',
          'panel.unverified': 'Unverified {count}',
          'panel.empty': 'No canon entries yet. Ask the agent to register one with canon_add.',
          'panel.failed': 'Failed: {message}',
          'panel.noSession': 'This tab has no session context.',
          'panel.coverage': 'Coverage {value}',
          'panel.back': 'Back',
          'panel.statement': 'Statement',
          'panel.marker': 'Marker',
          'panel.copyMarker': 'Copy marker',
          'panel.copied': 'Copied',
          'panel.locations': 'Affected locations',
          'panel.noLocations': 'No location pins this entry.',
          'panel.pinnedAt': 'pinned r{rev}',
          'panel.unpinned': 'unpinned',
          'panel.confirm': 'Verified, no impact',
          'panel.updated': 'Changed',
          'panel.updatedHint': 'The file changed elsewhere; verify and record it',
          'panel.editDoc': 'Edit document',
          'panel.save': 'Save',
          'panel.cancelEdit': 'Cancel',
          'panel.saved': 'Saved and verified',
          'panel.editNotLoaded': 'The paragraph is not loaded yet; try again',
          'panel.fileChanged': 'The file changed; reload and edit again',
          'panel.openFile': 'Open {file} in the right sidebar',
          'panel.openFailed': 'Cannot open the preview: the sidebar service is not ready',
          'onboard.title': 'How it works',
          'onboard.dismiss': 'Dismiss',
          'onboard.step1': 'The list on the left is your registered canon. Open one to see which documents reference it and which have gone stale.',
          'onboard.step2': 'After editing the text in a document, come back here, click “Text updated” and leave a note — that location is then verified.',
          'onboard.step3': 'To add or change canon entries, ask the Agent to use canon_add / canon_update; no hand-editing needed.',
          'onboard.foot': 'When an entry’s revision goes up, its older markers turn amber so you can confirm each location.',
          'panel.copyFailed': 'Clipboard unavailable',
          'panel.fixPinsDone': 'Pinned {count} location(s)',
          'panel.fixPinsNone': 'Nothing to pin',
          'panel.fixPinsHint': 'Add version numbers to unpinned rev-1 markers',
          'panel.pendingNone': 'All verified',
          'panel.superseded': 'superseded',
          'panel.noteRequired': 'A note is required to verify without impact',
          'panel.notePlaceholder': 'What you checked and why it is unaffected',
          'panel.done': 'Handled',
          'panel.history': 'History',
          'panel.rev': 'rev {rev}',
          'panel.semantic': 'semantic',
          'panel.wording': 'wording',
          'panel.fixPins': 'Fix pins (r1 only)',
          'panel.mentions': 'Mentioned but unmarked',
          'panel.mentionHint': 'This location names the entry without a marker. Add the marker by hand, or confirm none is needed.',
          'panel.stale': 'stale',
          'panel.drift': 'text drift',
          'panel.dangling': 'dangling',
          'panel.truncated': 'Too many files; the scan was truncated and results are incomplete.',
          'panel.readOnly': 'Read-only: no write token, cannot stamp.',
        },
      };

      /** 当前翻译函数，`locale` 服务就绪后换成宿主的。 */
      let translateCurrent = (key, params) => fallbackTranslate(key, params);

      function fallbackTranslate(key, params) {
        const table = DICT.zh;
        const template = table[key] ?? key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/gu, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
      }

      const t = (key, params) => {
        try {
          return translateCurrent(key, params);
        } catch {
          return fallbackTranslate(key, params);
        }
      };

      // ------------------------------------------------------------------
      // 宿主路由
      // ------------------------------------------------------------------

      /** 本进程写 token；读一次缓存住。 */
      let writeToken;
      let writeTokenPromise;

      /**
       * 带超时的 fetch。
       *
       * 黑洞 socket 不会 reject —— 没有 AbortController 就会永久 pending，
       * 之后所有操作排队，界面表现为「点不动」。
       *
       * @param {string} url 地址。
       * @param {object} [init] fetch 选项。
       * @param {number} [timeoutMs] 超时。
       * @returns {Promise<object>} 解析后的 JSON。
       */
      async function fetchJson(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, { ...init, signal: controller.signal });
          let payload;
          try {
            payload = await response.json();
          } catch {
            throw new Error(`HTTP ${response.status}`);
          }
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          return payload;
        } catch (error) {
          if (error?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }

      /**
       * 取写 token。
       * @returns {Promise<string|undefined>} token，拿不到时 undefined。
       */
      function ensureToken() {
        if (writeToken !== undefined) return Promise.resolve(writeToken);
        if (writeTokenPromise === undefined) {
          writeTokenPromise = fetchJson(`${API}/session`, { headers: { Accept: 'application/json' } }, POLL_TIMEOUT_MS)
            .then((payload) => {
              writeToken = typeof payload.token === 'string' ? payload.token : '';
              return writeToken;
            })
            .catch(() => {
              writeToken = '';
              return '';
            })
            .finally(() => {
              writeTokenPromise = undefined;
            });
        }
        return writeTokenPromise;
      }

      /**
       * GET 一个操作。
       * @param {string} op 操作名。
       * @param {object} params 参数。
       * @returns {Promise<object>} 结果。
       */
      function apiGet(op, params = {}, timeoutMs = FETCH_TIMEOUT_MS) {
        const url = new URL(`${API}/${op}`, window.location.origin);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        return fetchJson(url.toString(), { headers: { Accept: 'application/json' } }, timeoutMs);
      }

      /**
       * POST 一个操作（自动带 token）。
       * @param {string} op 操作名。
       * @param {object} body 请求体。
       * @returns {Promise<object>} 结果。
       */
      async function apiPost(op, body) {
        const token = await ensureToken();
        if (token === '') throw new Error(t('panel.readOnly'));
        return fetchJson(`${API}/${op}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', [TOKEN_HEADER]: token },
          body: JSON.stringify(body),
        });
      }

      // ------------------------------------------------------------------
      // 样式
      // ------------------------------------------------------------------
      const STYLE_ID = 'canon-keeper-style';
      const CSS = `
.ck-root { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; font-size:13px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); }

/* 文件名做成按钮：点一下在右侧栏打开该文件的预览页。 */
.ck-loc-link { padding:0; border:0; background:none; font:inherit; cursor:pointer; color:var(--dsw-alias-brand-primary); text-align:left; border-radius:3px; }
.ck-loc-link:hover { text-decoration:underline; text-underline-offset:2px; }
.ck-loc-link:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }

/* ---------- 新手引导 ---------- */
.ck-onboard { box-shadow:0 1px 2px rgb(15 23 42/.06); flex:none; margin:10px 14px 0; padding:11px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); }
.ck-onboard-head { display:flex; align-items:center; gap:8px; margin-bottom:7px; }
.ck-onboard-title { flex:1; min-width:0; font-size:12px; font-weight:600; }
.ck-onboard-steps { margin:0; padding-left:16px; font-size:11.5px; line-height:1.65; color:var(--dsw-alias-label-secondary); }
.ck-onboard-steps > li { margin:0 0 3px; }
.ck-onboard-steps > li:last-child { margin-bottom:0; }
.ck-onboard-foot { margin-top:8px; padding-top:7px; border-top:1px solid var(--dsw-alias-border-l1); font-size:11px; color:var(--dsw-alias-label-secondary); }

/* ---------- 标签栏 chip ---------- */
.ck-tabtitle { display:inline-flex; align-items:center; gap:5px; min-width:0; }
.ck-tabtitle > svg { flex:none; opacity:.85; }

/* ---------- 顶栏 ---------- */
.ck-head { display:flex; align-items:center; gap:8px; padding:12px 14px 10px; flex:none; }
.ck-title { font-weight:600; font-size:13.5px; letter-spacing:.01em; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck-head-actions { display:flex; align-items:center; gap:2px; flex:none; }
.ck-iconbtn { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-family:inherit; transition:background .12s ease, color .12s ease; }
.ck-iconbtn:hover { background:rgb(128 128 128 / 14%); color:var(--dsw-alias-label-primary); }
.ck-iconbtn:disabled { opacity:.4; cursor:default; }
.ck-iconbtn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.ck-iconbtn-spin svg { animation:ck-spin .7s linear infinite; }

/* ---------- 统计条 ---------- */
.ck-stats { display:flex; align-items:center; gap:6px; padding:0 14px 10px; flex-wrap:wrap; flex:none; }
.ck-chip { display:inline-flex; align-items:center; gap:4px; font-size:11px; line-height:1; padding:4px 8px; border-radius:999px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); border:1px solid transparent; }
.ck-chip-warn { color:var(--dsw-alias-state-warn-primary); background:var(--dsw-alias-bg-layer-1); }
.ck-chip-err { color:var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1); }
.ck-chip-ok { color:var(--dsw-alias-state-success-primary); background:var(--dsw-alias-bg-layer-1); }

/* ---------- 列表 ---------- */
.ck-list { flex:1; min-height:0; overflow-y:auto; padding:0 8px 44px; }
.ck-list::-webkit-scrollbar { width:8px; }
.ck-list::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l1); border-radius:4px; }
.ck-list::-webkit-scrollbar-thumb:hover { background:var(--dsw-alias-border-l2); }
.ck-row { position:relative; display:flex; align-items:flex-start; gap:9px; padding:10px 10px 10px 11px; border-radius:8px; cursor:pointer; border:1px solid transparent; transition:background .12s ease, border-color .12s ease; }
.ck-row + .ck-row { margin-top:1px; }
/* hover 用中性灰半透明叠加，不用表面色 token。
   原因：bg-layer-1 在浅色下与 bg-base 几乎同色，拿它做 hover 等于没有效果。
   用 rgb(128 128 128 / .12) 在浅色和深色下都能自然出层次，且不偏色。
   叠加层用 ::before 是为了只覆盖背景、不影响左侧状态条与内容层级。 */
.ck-row:hover::before { content:''; position:absolute; inset:0; border-radius:inherit; background:rgb(128 128 128 / 12%); pointer-events:none; }
.ck-row:hover { border-color:var(--dsw-alias-border-l2); }
.ck-row:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.ck-row:focus-visible::before { content:''; position:absolute; inset:0; border-radius:inherit; background:rgb(128 128 128 / 12%); pointer-events:none; }
.ck-row-bar { position:absolute; left:0; top:9px; bottom:9px; width:2.5px; border-radius:2px; z-index:1; }
.ck-row-bar-warn { background:var(--dsw-alias-state-warn-primary); }
.ck-row-bar-err { background:var(--dsw-alias-state-error-primary); }
.ck-row-bar-ok { background:var(--dsw-alias-state-success-primary); }
.ck-row-bar-idle { background:transparent; }
.ck-rowmain { flex:1; min-width:0; position:relative; z-index:1; }
.ck-id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px; letter-spacing:.02em; color:var(--dsw-alias-label-secondary); flex:none; padding-top:2px; }
.ck-rowtitle { font-size:12.5px; line-height:1.45; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck-rowsub { display:flex; align-items:center; gap:6px; font-size:10.5px; color:var(--dsw-alias-label-secondary); margin-top:3px; overflow:hidden; }
.ck-rowsub > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck-sep { opacity:.45; }
.ck-chev { flex:none; align-self:center; color:var(--dsw-alias-label-secondary); opacity:0; transition:opacity .12s ease; position:relative; z-index:1; }
.ck-row:hover .ck-chev, .ck-row:focus-visible .ck-chev { opacity:.7; }

/* ---------- 详情 ---------- */
.ck-back { display:inline-flex; align-items:center; gap:4px; flex:none; padding:3px 6px 3px 4px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); font-family:inherit; font-size:11.5px; cursor:pointer; transition:background .12s ease, color .12s ease; }
.ck-back:hover { background:rgb(128 128 128 / 14%); color:var(--dsw-alias-label-primary); }
.ck-back:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.ck-body { flex:1; min-height:0; overflow-y:auto; padding:4px 14px 48px; }
.ck-body::-webkit-scrollbar { width:8px; }
.ck-body::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l1); border-radius:4px; }
.ck-label { display:flex; align-items:center; gap:6px; font-size:10.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); margin:18px 0 7px; }
.ck-label:first-child { margin-top:6px; }
.ck-label-count { font-weight:500; letter-spacing:0; text-transform:none; opacity:.75; }
.ck-text { white-space:pre-wrap; word-break:break-word; line-height:1.65; font-size:12.5px; }
.ck-card { box-shadow:0 1px 2px rgb(15 23 42/.06); border:1px solid var(--dsw-alias-border-l2); border-radius:9px; padding:11px 12px; background:var(--dsw-alias-bg-layer-1); }
.ck-code { display:flex; align-items:center; gap:8px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius:7px; padding:8px 10px; word-break:break-all; }
.ck-code > code { flex:1; min-width:0; }
.ck-copy { flex:none; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:0; border-radius:5px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; transition:background .12s ease, color .12s ease; }
.ck-copy:hover { background:rgb(128 128 128 / 14%); color:var(--dsw-alias-label-primary); }
.ck-copy:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }

/* ---------- 受影响位置 ---------- */
.ck-loc { box-shadow:0 1px 2px rgb(15 23 42/.06); border:1px solid var(--dsw-alias-border-l2); border-radius:9px; padding:10px 11px; margin-bottom:8px; background:var(--dsw-alias-bg-layer-1); transition:border-color .12s ease; }
.ck-loc:hover { border-color:var(--dsw-alias-border-l2); }
.ck-loc-stale { border-left:2.5px solid var(--dsw-alias-state-warn-primary); }
.ck-loc-head { display:flex; align-items:center; gap:7px; font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.ck-loc-file { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck-tag { flex:none; font-size:10px; line-height:1; padding:3px 6px; border-radius:5px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.ck-tag-warn { color:var(--dsw-alias-state-warn-primary); background:var(--dsw-alias-bg-layer-2); }
.ck-loc-snippet { font-size:11.5px; line-height:1.6; margin:8px 0 0; color:var(--dsw-alias-label-primary); white-space:pre-wrap; word-break:break-word; opacity:.9; }
.ck-loc-note { margin-top:8px; }
.ck-input-doc { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; line-height:1.6; resize:vertical; min-height:64px; }
.ck-input { width:100%; box-sizing:border-box; font-family:inherit; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:7px; padding:7px 9px; resize:vertical; min-height:48px; transition:border-color .12s ease; }
.ck-input::placeholder { color:var(--dsw-alias-label-secondary); opacity:.7; }
.ck-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.ck-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
/* 推到行尾：核验类按钮留在左侧成组，「修改文档」单独靠右。 */
.ck-btn-right { margin-left:auto; }

/* ---------- 按钮 ---------- */
.ck-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:7px; padding:5px 11px; font-size:11.5px; font-family:inherit; line-height:1.4; cursor:pointer; transition:background .12s ease, border-color .12s ease, color .12s ease; }
.ck-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
.ck-btn:disabled { opacity:.45; cursor:default; }
.ck-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.ck-btn-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); font-weight:500; background:transparent; }
.ck-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-brand-primary); }
.ck-btn-ghost { border-color:transparent; background:transparent; color:var(--dsw-alias-label-secondary); }
.ck-btn-ghost:hover:not(:disabled) { background:rgb(128 128 128 / 14%); color:var(--dsw-alias-label-primary); border-color:transparent; }

/* ---------- 提示与空态 ---------- */
.ck-note { font-size:10.5px; color:var(--dsw-alias-label-secondary); padding:8px 14px 10px; flex:none; opacity:.8; }
.ck-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; padding:44px 24px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.7; }
.ck-empty-icon { opacity:.35; }
.ck-hist { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.75; }
.ck-hist-row { display:flex; gap:7px; padding:3px 0; }
.ck-hist-seq { flex:none; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.65; }
.ck-hist-body { flex:1; min-width:0; word-break:break-word; }

/* ---------- toast ---------- */
/* 底部浮层：靠 margin-top:auto 压在 flex 列末端，不用绝对定位。
   绝对定位版本会被滚动容器裁掉而完全不显示，这是最初「看不到 toast」的原因。 */
/* 浮层：绝对定位，脱离文档流，不挤压任何内容。
   父级 .ck-root 已有 position:relative，所以不需要额外定位祖先。
   早先绝对定位看不到 toast 的根因是 installStyles 不覆盖旧样式表，
   不是定位方式本身的问题 —— 那个 bug 修掉后浮层才能用。 */
.ck-toast { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); z-index:20; display:flex; align-items:center; gap:8px; max-width:calc(100% - 28px); padding:8px 11px; border-radius:8px; background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1)); border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-size:11.5px; line-height:1.45; box-shadow:0 6px 18px rgb(15 23 42/.16); animation:ck-drop .18s ease-out; }
.ck-toast-ok { border-color:var(--dsw-alias-state-success-primary); }
.ck-toast-err { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.ck-toast-icon { flex:none; display:inline-flex; }
.ck-toast-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ---------- 骨架屏 ---------- */
.ck-skel { border-radius:8px; background:var(--dsw-alias-bg-layer-1); animation:ck-pulse 1.3s ease-in-out infinite; }
.ck-skel-row { height:52px; margin-bottom:6px; }
.ck-skel-short { width:55%; }

@keyframes ck-spin { to { transform:rotate(360deg); } }
/* 关键帧必须重复 translateX(-50%)：animation 会覆盖元素自身的 transform，
   只写 translateY 会让 toast 在动画结束后丢掉水平居中、跑到左边去。 */
@keyframes ck-drop { from { opacity:0; transform:translate(-50%,6px); } to { opacity:1; transform:translate(-50%,0); } }
@keyframes ck-pulse { 0%,100% { opacity:.5; } 50% { opacity:.85; } }
@media (prefers-reduced-motion:reduce) {
  .ck-toast, .ck-skel, .ck-iconbtn-spin svg { animation:none; }
  .ck-btn, .ck-iconbtn, .ck-row, .ck-loc, .ck-input, .ck-chev { transition:none; }
}
`;

      /**
       * 装样式表。
       *
       * 不能「元素已存在就直接 return」：插件重装或热重载时旧的 `<style>` 还留在
       * DOM 里，那样新 CSS 永远装不上，改了样式却看不到任何变化（这个坑很隐蔽，
       * 因为代码看起来完全正确）。所以存在就覆盖 `textContent`。
       *
       * @param {object} ctx 客户端上下文。
       * @returns {void}
       */
      function installStyles(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const existing = document.getElementById(STYLE_ID);
          if (existing !== null) {
            // 覆盖已有样式表，保证改动立即生效。
            if (existing.textContent !== CSS) existing.textContent = CSS;
            return () => {};
          }
          const el = document.createElement('style');
          el.id = STYLE_ID;
          el.setAttribute('data-plugin', MODULE_ID);
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => {
            try {
              el.remove();
            } catch {
              /* 宿主已移除 */
            }
          };
        }, 'dsh-canon-keeper: styles');
      }

      function bindLocale(ctx) {
        ctx.inject(['locale'], (scope) => {
          const locale = scope.get('locale');
          if (locale === undefined || typeof locale.register !== 'function') return;
          scope.effect(() => {
            let dispose;
            try {
              dispose = locale.register(NS, DICT);
              if (typeof locale.bind === 'function') translateCurrent = locale.bind(NS);
            } catch (error) {
              console.warn('[dsh-canon-keeper] locale 注册失败:', error?.message ?? error);
            }
            return () => {
              translateCurrent = (key, params) => fallbackTranslate(key, params);
              try {
                dispose?.();
              } catch {
                /* 忽略卸载失败 */
              }
            };
          }, 'dsh-canon-keeper: dictionaries');
        });
      }

      // ------------------------------------------------------------------
      // 图标（全部用 currentColor，深浅主题自动跟随）
      // ------------------------------------------------------------------

      function svg(size, children) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        }, children);
      }

      const IconCheck = ({ size = 14 }) => svg(size, h('path', { d: 'M3 8.5l3.2 3.2L13 5' }));
      const IconX = ({ size = 14 }) => svg(size, [h('path', { key: 'a', d: 'M4 4l8 8' }), h('path', { key: 'b', d: 'M12 4l-8 8' })]);
      const IconChevron = ({ size = 13 }) => svg(size, h('path', { d: 'M6 3.5l4.5 4.5L6 12.5' }));
      const IconBack = ({ size = 13 }) => svg(size, h('path', { d: 'M10 3.5L5.5 8l4.5 4.5' }));
      const IconRefresh = ({ size = 14 }) => svg(size, [
        h('path', { key: 'a', d: 'M13.5 8a5.5 5.5 0 1 1-1.9-4.2' }),
        h('path', { key: 'b', d: 'M13.5 2v3.2h-3.2' }),
      ]);
      const IconCopy = ({ size = 13 }) => svg(size, [
        h('rect', { key: 'a', x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6 }),
        h('path', { key: 'b', d: 'M10.5 3.5h-6a1.6 1.6 0 0 0-1.6 1.6v6' }),
      ]);
      const IconBook = ({ size = 28 }) => h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, [
        h('path', { key: 'a', d: 'M5 4.5h9.5a2 2 0 0 1 2 2V19H7a2 2 0 0 1-2-2V4.5Z' }),
        h('path', { key: 'b', d: 'M8.5 8.5h5' }),
        h('path', { key: 'c', d: 'M8.5 12h5' }),
        h('path', { key: 'd', d: 'M8.5 15.5h3' }),
      ]);
      const IconWarn = ({ size = 13 }) => svg(size, [
        h('path', { key: 'a', d: 'M8 2.5l6 11H2l6-11Z' }),
        h('path', { key: 'b', d: 'M8 6.5v3.2' }),
        h('path', { key: 'c', d: 'M8 11.8v.2' }),
      ]);

      // ------------------------------------------------------------------
      // toast
      // ------------------------------------------------------------------

      /**
       * 面板内 toast。返回 `{toast, show}`。
       *
       * 用 `role="status"` 让读屏软件播报；定时器在卸载时清掉，
       * 否则连续操作会堆一串 setState 打到已卸载组件上。
       *
       * @returns {{toast: object|null, show: Function}} 当前 toast 与触发器。
       */
      function useToast() {
        const [toast, setToast] = useState(null);
        const timerRef = useRef(undefined);

        useEffect(() => () => {
          if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        }, []);

        const show = useCallback((message, tone = 'ok') => {
          if (timerRef.current !== undefined) clearTimeout(timerRef.current);
          setToast({ id: Date.now(), message, tone });
          timerRef.current = setTimeout(() => setToast(null), tone === 'err' ? 4200 : 2200);
        }, []);

        return { toast, show };
      }

      /**
       * 渲染 toast 节点。
       * @param {object|null} toast 状态。
       * @returns {object|null} 节点。
       */
      function ToastNode({ toast }) {
        if (toast === null || toast === undefined) return null;
        return h('div', {
          className: `ck-toast${toast.tone === 'err' ? ' ck-toast-err' : ' ck-toast-ok'}`,
          role: 'status',
          'aria-live': 'polite',
        },
          h('span', { className: 'ck-toast-icon' }, toast.tone === 'err' ? h(IconWarn) : h(IconCheck)),
          h('span', { className: 'ck-toast-text' }, toast.message),
        );
      }

      // ------------------------------------------------------------------
      // 小组件
      // ------------------------------------------------------------------

      function Chip({ text, tone }) {
        const cls = tone === 'warn' ? 'ck-chip ck-chip-warn' : tone === 'err' ? 'ck-chip ck-chip-err' : tone === 'ok' ? 'ck-chip ck-chip-ok' : 'ck-chip';
        return h('span', { className: cls }, text);
      }

      function Skeleton({ rows = 4 }) {
        const items = [];
        for (let index = 0; index < rows; index += 1) {
          items.push(h('div', {
            key: `s${index}`,
            className: `ck-skel ck-skel-row${index === rows - 1 ? ' ck-skel-short' : ''}`,
          }));
        }
        return h('div', { style: { padding: '4px 8px' } }, items);
      }

      function EmptyState({ icon, text }) {
        return h('div', { className: 'ck-empty' },
          h('span', { className: 'ck-empty-icon' }, icon ?? h(IconBook)),
          h('span', null, text),
        );
      }

      /**
       * 一行条目的状态色。
       * @param {object} entry 条目。
       * @returns {string} warn / err / ok / idle。
       */
      function toneOf(entry) {
        const issues = entry.issues ?? [];
        if (issues.some((issue) => issue.code === 'STORE_UNREADABLE' || issue.code === 'ID_COLLISION')) return 'err';
        const effective = issues.filter((issue) => issue.demoted !== true);
        if (effective.some((issue) => issue.code === 'STALE' || issue.code === 'DRIFT' || issue.code === 'DANGLING')) return 'warn';
        if (effective.length > 0) return 'ok';
        return 'idle';
      }

      /**
       * 状态标签文本。
       * @param {object} entry 条目。
       * @returns {string} 文本。
       */
      function statusTextOf(entry) {
        const codes = new Set((entry.issues ?? []).filter((issue) => issue.demoted !== true).map((issue) => issue.code));
        if (codes.has('STALE')) return t('panel.stale');
        if (codes.has('DRIFT')) return t('panel.drift');
        if (codes.has('DANGLING')) return t('panel.dangling');
        return `r${entry.rev}`;
      }

      /**
       * 把工作区相对路径拼成文档预览认得的资源地址。
       *
       * 宿主只认 `dsh-resource://file/session/<sessionId>/<path>`，逐段编码，
       * 但 `:` 要保持字面（Windows 盘符）；反斜杠统一成正斜杠。
       *
       * @param {string} sessionId 会话 id。
       * @param {string} file 相对或绝对路径。
       * @returns {string} 资源地址。
       */
      function fileAddressOf(sessionId, file) {
        const normalized = String(file).replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
        const encoded = normalized
          .split('/')
          .map((segment) => encodeURIComponent(segment).replace(/%3A/giu, ':'))
          .join('/');
        return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`;
      }

      /**
       * 在右侧栏打开某个文件的预览页。
       *
       * 服务是冷启动后才 provide 的，所以每次点击都重新 `ctx.get`，不能在
       * apply 阶段取样一次存着。
       *
       * @param {object} ctx 客户端上下文。
       * @param {string} sessionId 会话 id。
       * @param {string} file 文件路径。
       * @returns {boolean} 是否成功打开（服务缺失时返回 false）。
       */
      function openFilePreview(ctx, sessionId, file) {
        const right = ctx?.get?.('sidebarRight');
        if (right === undefined || right === null || typeof right.openResourceIn !== 'function') return false;
        try {
          right.openResourceIn(sessionId, fileAddressOf(sessionId, file));
          return true;
        } catch {
          return false;
        }
      }

      // ------------------------------------------------------------------
      // 详情
      // ------------------------------------------------------------------

      function DetailView({ ctx, sessionId, entryId, onBack, onChanged }) {
        const [detail, setDetail] = useState(undefined);
        const [error, setError] = useState('');
        const [busy, setBusy] = useState(false);
        /** 每处的核验草稿：`file:line` → {outcome, note, text}。 */
        const [drafts, setDrafts] = useState({});
        /** 当前正在编辑的位置 key；同一时间只允许改一处，避免多处写盘互相干扰。 */
        const [editingKey, setEditingKey] = useState(null);
        /** 进入编辑态时读到的段落：key → {text, hash, startLine, endLine}。 */
        const [paragraphs, setParagraphs] = useState({});
        const { toast, show } = useToast();

        const load = useCallback(async () => {
          try {
            const payload = await apiGet('detail', { sessionId, id: entryId });
            setDetail(payload);
            setError('');
          } catch (failure) {
            // 首屏失败：正文区给空态说明，顶部不再挂红条。
            setError(String(failure?.message ?? failure));
            show(String(failure?.message ?? failure), 'err');
          }
        }, [sessionId, entryId, show]);

        useEffect(() => {
          let alive = true;
          void (async () => {
            if (alive) await load();
          })();
          return () => {
            alive = false;
          };
        }, [load]);

        const submit = useCallback(async (ref, outcome) => {
          const key = `${ref.file}:${ref.line}`;
          const draft = drafts[key] ?? { outcome, note: '' };
          const note = (draft.note ?? '').trim();
          // confirmed 必须带备注：没有备注的「我看过了」不构成证据。
          if (outcome === 'confirmed' && note === '') {
            show(t('panel.noteRequired'), 'err');
            return;
          }
          setBusy(true);
          try {
            const result = await apiPost('resolve', {
              sessionId,
              items: [{ entryId, file: ref.file, line: ref.line, outcome, note }],
            });
            if (result.ok !== true) throw new Error(result.failed?.[0]?.error ?? '核验未通过');
            setDrafts((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
            show(t('panel.done'));
            await load();
            onChanged?.();
          } catch (failure) {
            show(String(failure?.message ?? failure), 'err');
          } finally {
            setBusy(false);
          }
        }, [drafts, entryId, sessionId, load, onChanged, show]);

        const copyMarker = useCallback(async () => {
          const marker = detail?.marker;
          if (typeof marker !== 'string') return;
          try {
            await navigator.clipboard.writeText(marker);
            show(t('panel.copied'));
          } catch {
            show(t('panel.copyFailed'), 'err');
          }
        }, [detail, show]);

        /**
         * 进入编辑态：读磁盘上的段落原文放进 textarea。
         *
         * 同时记下读到的哈希，保存时带回去做冲突检测 —— 这样「面板打开后
         * 别人又改了文件」能被拦住，而不是默默覆盖。
         *
         * @param {object} ref 引用。
         * @param {string} key 位置 key。
         * @returns {Promise<void>} 完成。
         */
        const startEdit = useCallback(async (ref, key) => {
          setEditingKey(key);
          setBusy(true);
          try {
            const payload = await apiPost('paragraph', { sessionId, id: entryId, file: ref.file, line: ref.line });
            setParagraphs((previous) => ({ ...previous, [key]: payload }));
            setDrafts((previous) => ({ ...previous, [key]: { ...(previous[key] ?? { outcome: 'updated', note: '' }), text: payload.text } }));
          } catch (failure) {
            setEditingKey(null);
            show(String(failure?.message ?? failure), 'err');
          } finally {
            setBusy(false);
          }
        }, [sessionId, entryId, show]);

        /**
         * 退出编辑态并丢弃未保存的文本。
         * @param {string} key 位置 key。
         * @returns {void}
         */
        const cancelEdit = useCallback((key) => {
          setEditingKey(null);
          setParagraphs((previous) => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
          setDrafts((previous) => {
            const next = { ...previous };
            if (next[key] !== undefined) {
              const { text, ...rest } = next[key];
              next[key] = rest;
            }
            return next;
          });
        }, []);

        /**
         * 保存：把段落原文写回文件，并按「已改文」核验。
         *
         * 备注必填 —— 没写备注就点保存会直接被拦下来，提示先写一句。
         *
         * @param {object} ref 引用。
         * @param {string} key 位置 key。
         * @returns {Promise<void>} 完成。
         */
        const saveEdit = useCallback(async (ref, key) => {
          const draft = drafts[key] ?? {};
          const note = String(draft.note ?? '').trim();
          if (note === '') {
            show(t('panel.noteRequired'), 'err');
            return;
          }
          const loaded = paragraphs[key];
          if (loaded === undefined) {
            show(t('panel.editNotLoaded'), 'err');
            return;
          }
          setBusy(true);
          try {
            const result = await apiPost('editText', {
              sessionId,
              id: entryId,
              file: ref.file,
              line: ref.line,
              text: String(draft.text ?? ''),
              expectedHash: loaded.hash,
              note,
            });
            if (result.ok !== true) {
              throw new Error(result.resolved?.failed?.[0]?.message ?? '保存后核验未通过');
            }
            setEditingKey(null);
            setParagraphs((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
            setDrafts((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
            show(t('panel.saved'));
            await load();
            onChanged?.();
          } catch (failure) {
            // FILE_CHANGED 要明确告诉用户刷新，而不是笼统报错。
            const code = failure?.code;
            show(
              code === 'FILE_CHANGED' ? t('panel.fileChanged') : String(failure?.message ?? failure),
              'err',
            );
          } finally {
            setBusy(false);
          }
        }, [drafts, paragraphs, entryId, sessionId, load, onChanged, show]);

        if (detail === undefined) {
          return h('div', { className: 'ck-root' },
            h('div', { className: 'ck-head' },
              h('button', { className: 'ck-back', onClick: onBack, type: 'button' }, h(IconBack), t('panel.back')),
              h('span', { className: 'ck-title' }, entryId),
            ),
            h('div', { className: 'ck-body' },
              error === ''
                ? h(Skeleton, { rows: 5 })
                : h(EmptyState, { icon: h(IconWarn, { size: 28 }), text: t('panel.failed', { message: error }) }),
            ),
            h(ToastNode, { toast }),
          );
        }

        const entry = detail?.entry;
        const refs = detail?.refs ?? [];
        const mentions = detail?.mentions ?? [];
        const history = Array.isArray(entry?.history) ? entry.history : [];

        return h('div', { className: 'ck-root' },
          h('div', { className: 'ck-head' },
            h('button', { className: 'ck-back', onClick: onBack, type: 'button' }, h(IconBack), t('panel.back')),
            h('span', { className: 'ck-title' }, entry?.title || entryId),
            h('span', { className: 'ck-id' }, entryId),
          ),
          h('div', { className: 'ck-body' },
            entry === undefined ? null : h(React.Fragment, null,
              h('div', { className: 'ck-label' }, t('panel.statement')),
              h('div', { className: 'ck-card' }, h('div', { className: 'ck-text' }, entry.statement)),
              detail.marker === undefined ? null : h(React.Fragment, null,
                h('div', { className: 'ck-label' },
                  t('panel.marker'),
                  h('span', { className: 'ck-label-count' }, t('panel.rev', { rev: entry.rev })),
                ),
                h('div', { className: 'ck-code' },
                  h('code', null, detail.marker),
                  h('button', {
                    className: 'ck-copy',
                    type: 'button',
                    onClick: copyMarker,
                    title: t('panel.copyMarker'),
                    'aria-label': t('panel.copyMarker'),
                  }, h(IconCopy)),
                ),
              ),
              h('div', { className: 'ck-label' },
                t('panel.locations'),
                h('span', { className: 'ck-label-count' }, refs.length),
              ),
              refs.length === 0
                ? h('div', { className: 'ck-card' }, h('div', { className: 'ck-rowsub' }, t('panel.noLocations')))
                : refs.map((ref) => {
                  const key = `${ref.file}:${ref.line}`;
                  const draft = drafts[key] ?? { outcome: 'confirmed', note: '' };
                  const unpinned = ref.pinRev === null || ref.pinRev === undefined;
                  const stale = unpinned || ref.pinRev < entry.rev;
                  const editing = editingKey === key;
                  const loaded = paragraphs[key];
                  return h('div', { className: `ck-loc${stale ? ' ck-loc-stale' : ''}`, key },
                    h('div', { className: 'ck-loc-head' },
                      h('button', {
                        className: 'ck-loc-file ck-loc-link',
                        type: 'button',
                        title: t('panel.openFile', { file: ref.file }),
                        onClick: () => {
                          if (!openFilePreview(ctx, sessionId, ref.file)) show(t('panel.openFailed'), 'err');
                        },
                      }, `${ref.file}:${ref.line}`),
                      h('span', { className: `ck-tag${stale ? ' ck-tag-warn' : ''}` },
                        unpinned ? t('panel.unpinned') : t('panel.pinnedAt', { rev: ref.pinRev })),
                    ),
                    editing
                      ? h('div', { className: 'ck-loc-note' },
                        loaded === undefined
                          ? h(Skeleton, { rows: 2 })
                          : h('textarea', {
                            className: 'ck-input ck-input-doc',
                            value: draft.text ?? '',
                            rows: Math.min(12, Math.max(3, String(draft.text ?? '').split('\n').length + 1)),
                            onChange: (event) => {
                              const value = event.target.value;
                              setDrafts((previous) => ({ ...previous, [key]: { ...draft, text: value } }));
                            },
                          }),
                      )
                      : h('div', { className: 'ck-loc-snippet' }, ref.snippet ?? ''),
                    h('div', { className: 'ck-loc-note' },
                      h('textarea', {
                        className: 'ck-input',
                        placeholder: t('panel.notePlaceholder'),
                        value: draft.note,
                        rows: 2,
                        onChange: (event) => {
                          const value = event.target.value;
                          setDrafts((previous) => ({ ...previous, [key]: { ...draft, note: value } }));
                        },
                      }),
                    ),
                    h('div', { className: 'ck-actions' },
                      editing
                        ? h(React.Fragment, null,
                          h('button', {
                            className: 'ck-btn ck-btn-primary',
                            type: 'button',
                            disabled: busy || loaded === undefined,
                            onClick: () => void saveEdit(ref, key),
                          }, h(IconCheck), t('panel.save')),
                          h('button', {
                            className: 'ck-btn ck-btn-ghost',
                            type: 'button',
                            disabled: busy,
                            onClick: () => cancelEdit(key),
                          }, t('panel.cancelEdit')),
                        )
                        : h(React.Fragment, null,
                          h('button', {
                            className: 'ck-btn ck-btn-primary',
                            type: 'button',
                            disabled: busy,
                            onClick: () => void submit(ref, 'updated'),
                            title: t('panel.updatedHint'),
                          }, h(IconCheck), t('panel.updated')),
                          h('button', {
                            className: 'ck-btn ck-btn-ghost',
                            type: 'button',
                            disabled: busy,
                            onClick: () => void submit(ref, 'confirmed'),
                          }, t('panel.confirm')),
                          /* 放最后 + margin-left:auto 才能真正单独靠右；
                             插在中间会把后面的按钮一起带到右边。 */
                          h('button', {
                            className: 'ck-btn ck-btn-right',
                            type: 'button',
                            disabled: busy,
                            onClick: () => void startEdit(ref, key),
                          }, t('panel.editDoc')),
                        ),
                    ),
                  );
                }),
              mentions.length === 0 ? null : h(React.Fragment, null,
                h('div', { className: 'ck-label' },
                  t('panel.mentions'),
                  h('span', { className: 'ck-label-count' }, mentions.length),
                ),
                mentions.map((mention, index) => h('div', { className: 'ck-loc', key: `m${index}` },
                  h('div', { className: 'ck-loc-head' },
                    h('button', {
                      className: 'ck-loc-file ck-loc-link',
                      type: 'button',
                      title: t('panel.openFile', { file: mention.file }),
                      onClick: () => {
                        if (!openFilePreview(ctx, sessionId, mention.file)) show(t('panel.openFailed'), 'err');
                      },
                    }, `${mention.file}:${mention.line}`),
                  ),
                  h('div', { className: 'ck-loc-snippet' }, mention.snippet ?? ''),
                  h('div', { className: 'ck-rowsub', style: { marginTop: '7px' } },
                    h('span', null, t('panel.mentionHint'))),
                )),
              ),
              history.length === 0 ? null : h(React.Fragment, null,
                h('div', { className: 'ck-label' }, t('panel.history')),
                h('div', { className: 'ck-hist' },
                  history.slice(-8).reverse().map((item, index) => h('div', { className: 'ck-hist-row', key: `h${index}` },
                    h('span', { className: 'ck-hist-seq' }, `#${item.seq ?? ''}`),
                    h('span', { className: 'ck-hist-body' },
                      `${item.change === 'semantic' ? t('panel.semantic') : t('panel.wording')}`
                      + `${item.actor?.name ? ` · ${item.actor.name}` : ''}`
                      + `${item.note ? ` · ${item.note}` : ''}`),
                  )),
                ),
              ),
            ),
          ),
          h(ToastNode, { toast }),
        );
      }

      // ------------------------------------------------------------------
      // 列表
      // ------------------------------------------------------------------

      function ListView({ ctx, sessionId, onOpen }) {
        const [data, setData] = useState(undefined);
        const [error, setError] = useState('');
        const [busy, setBusy] = useState(false);
        const [force, setForce] = useState(false);
        const { toast, show } = useToast();
        /** 轮询代次：旧请求的回调不许覆盖新状态。 */
        const generation = useRef(0);

        const load = useCallback(async (options = {}) => {
          const current = generation.current + 1;
          generation.current = current;
          try {
            const payload = await apiGet(
              'overview',
              { sessionId, force: options.force === true ? 'true' : undefined },
              options.force === true ? FETCH_TIMEOUT_MS : POLL_TIMEOUT_MS,
            );
            if (generation.current !== current) return;
            setData(payload);
            setError('');
          } catch (failure) {
            if (generation.current !== current) return;
            const message = String(failure?.message ?? failure);
            setError(message);
            // 后台轮询每 4 秒一次，失败时弹 toast 会刷屏；只有手动刷新才提示。
            if (options.force === true) show(message, 'err');
          }
        }, [sessionId, show]);

        // 首屏 + 轮询。轮询永远在 try/catch 之后无条件安排下一次，
        // 一次失败不能让它退出循环（否则界面从此冻结）。
        useEffect(() => {
          let alive = true;
          let timer;
          const tick = async () => {
            if (!alive) return;
            await load();
            if (!alive) return;
            timer = setTimeout(tick, POLL_MS);
          };
          void tick();
          return () => {
            alive = false;
            if (timer !== undefined) clearTimeout(timer);
          };
        }, [load]);

        const runForce = useCallback(async () => {
          setBusy(true);
          setForce(true);
          try {
            await load({ force: true });
          } finally {
            setBusy(false);
            setTimeout(() => setForce(false), 1200);
          }
        }, [load]);

        const fixPins = useCallback(async () => {
          setBusy(true);
          try {
            const result = await apiPost('fixPins', { sessionId });
            const pinned = result?.pinned ?? 0;
            show(pinned > 0 ? t('panel.fixPinsDone', { count: pinned }) : t('panel.fixPinsNone'));
            await load({ force: true });
          } catch (failure) {
            show(String(failure?.message ?? failure), 'err');
          } finally {
            setBusy(false);
          }
        }, [sessionId, load, show]);

        const entries = data?.entries ?? [];
        const counts = data?.counts ?? {};
        const stats = data?.stats ?? {};
        const pending = (counts.stale ?? 0) + (counts.dangling ?? 0);
        const unpinned = counts.unpinned ?? 0;
        const coverage = typeof stats.coverage === 'number' ? Math.round(stats.coverage * 100) : 0;

        const body = () => {
          if (data === undefined) {
            return error !== ''
              ? h(EmptyState, { icon: h(IconWarn, { size: 28 }), text: t('panel.failed', { message: error }) })
              : h(Skeleton, { rows: 5 });
          }
          if (entries.length === 0) return h(EmptyState, { text: t('panel.empty') });
          return entries.map((entry) => {
            const tone = toneOf(entry);
            return h('div', {
              className: 'ck-row',
              key: entry.id,
              onClick: () => onOpen(entry.id),
              role: 'button',
              tabIndex: 0,
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen(entry.id);
                }
              },
            },
              h('span', { className: `ck-row-bar ck-row-bar-${tone}` }),
              h('div', { className: 'ck-rowmain' },
                h('div', { className: 'ck-rowtitle' }, entry.title || entry.statement),
                h('div', { className: 'ck-rowsub' },
                  h('span', { className: 'ck-id' }, entry.id),
                  h('span', { className: 'ck-sep' }, '·'),
                  h('span', null, statusTextOf(entry)),
                  entry.supersededBy ? h('span', { className: 'ck-sep' }, '·') : null,
                  entry.supersededBy ? h('span', null, t('panel.superseded')) : null,
                ),
              ),
              h('span', { className: 'ck-chev' }, h(IconChevron)),
            );
          });
        };

        return h('div', { className: 'ck-root' },
          h('div', { className: 'ck-head' },
            h('span', { className: 'ck-title' }, t('panel.title')),
            h('div', { className: 'ck-head-actions' },
              h('button', {
                className: `ck-iconbtn${force ? ' ck-iconbtn-spin' : ''}`,
                type: 'button',
                disabled: busy,
                onClick: () => void runForce(),
                title: t('panel.refresh'),
                'aria-label': t('panel.refresh'),
              }, h(IconRefresh)),
              h('button', {
                className: 'ck-btn ck-btn-ghost',
                type: 'button',
                disabled: busy,
                onClick: () => void fixPins(),
                title: t('panel.fixPinsHint'),
              }, t('panel.fixPins')),
            ),
          ),
          h('div', { className: 'ck-stats' },
            pending > 0
              ? h(Chip, { text: t('panel.pending', { count: pending }), tone: 'warn' })
              : h(Chip, { text: t('panel.pendingNone'), tone: 'ok' }),
            unpinned > 0 ? h(Chip, { text: t('panel.unverified', { count: unpinned }), tone: 'warn' }) : null,
            h(Chip, { text: t('panel.coverage', { value: `${coverage}%` }) }),
          ),
          data?.truncated === true ? h('div', { className: 'ck-note' }, t('panel.truncated')) : null,
          h('div', { className: 'ck-list' }, body()),
          h(OnboardingCard, { sessionId }),
          h(ToastNode, { toast }),
        );
      }

      /**
       * 「怎么用」卡片：第一次打开面板的人看到的就是这张。
       *
       * 关掉后记在 localStorage（按会话），不打扰老用户；不放进 canon 存储，
       * 因为它只是界面状态，不该污染口径数据。
       */
      function OnboardingCard({ sessionId }) {
        const storageKey = `canon-keeper:onboard:${sessionId}`;
        const [dismissed, setDismissed] = useState(() => {
          try {
            return window.localStorage.getItem(storageKey) === '1';
          } catch {
            return false;
          }
        });
        if (dismissed) return null;

        const dismiss = () => {
          setDismissed(true);
          try {
            window.localStorage.setItem(storageKey, '1');
          } catch {
            // 隐私模式下写不进去，本会话内仍然隐藏即可。
          }
        };

        return h('div', { className: 'ck-onboard' },
          h('div', { className: 'ck-onboard-head' },
            h('span', { className: 'ck-onboard-title' }, t('onboard.title')),
            h('button', {
              className: 'ck-iconbtn',
              type: 'button',
              onClick: dismiss,
              title: t('onboard.dismiss'),
              'aria-label': t('onboard.dismiss'),
            }, h(IconX)),
          ),
          h('ol', { className: 'ck-onboard-steps' },
            h('li', null, t('onboard.step1')),
            h('li', null, t('onboard.step2')),
            h('li', null, t('onboard.step3')),
          ),
          h('div', { className: 'ck-onboard-foot' }, t('onboard.foot')),
        );
      }

      // ------------------------------------------------------------------
      // 标签页入口
      // ------------------------------------------------------------------

      function CanonTab(props) {
        const sessionId = props?.sessionId;
        const [openId, setOpenId] = useState(undefined);

        if (typeof sessionId !== 'string' || sessionId === '') {
          return h('div', { className: 'ck-root' }, h('div', { className: 'ck-empty' }, t('panel.noSession')));
        }

        if (openId !== undefined) {
          return h(DetailView, {
            ctx: props?.ctx,
            sessionId,
            entryId: openId,
            onBack: () => setOpenId(undefined),
            onChanged: () => {},
          });
        }
        return h(ListView, { ctx: props?.ctx, sessionId, onOpen: (id) => setOpenId(id) });
      }

      /**
       * 标签页标题。
       *
       * 宿主的标题槽位只认 `key`，没有 icon 字段；注册了本组件就整体替换掉
       * 默认的纯文本 chip，所以图标必须在这里自己画——否则标签栏只剩文字。
       */
      function CanonTabTitle() {
        return h('span', { className: 'ck-tabtitle' },
          h(CanonIcon, { size: 14 }),
          h('span', null, t('tab.title')),
        );
      }

      /** 标签页图标。 */
      function CanonIcon(props) {
        const size = props?.size ?? 16;
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
          h('path', {
            d: 'M3.5 2.5h6l3 3v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M5.5 8.5l1.5 1.5 3-3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        );
      }

      // ------------------------------------------------------------------
      // 插件体
      // ------------------------------------------------------------------

      function apply(ctx) {
        bindLocale(ctx);
        installStyles(ctx);

        const slots = ctx.get('slots');
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[dsh-canon-keeper] slots 服务缺失，面板未启用');
          return;
        }

        const register = (slot, options, component, label) => {
          try {
            ctx.effect(
              () => slots.inject(slot, () => slots.register({ name: slot, ...options }, component)),
              label,
            );
          } catch (error) {
            console.warn(`[dsh-canon-keeper] 注册 ${slot} 失败:`, error?.message ?? error);
          }
        };

        // 右侧边栏标签页类型。sidebarRightTabs 由其它插件提供，可能晚于本插件
        // apply，所以必须用 ctx.inject 等它就绪 —— 一次性 ctx.get 拿到 undefined
        // 不会重试，表现为「插件启用着但标签页永远不出现」。
        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.get('sidebarRightTabs');
          if (tabs === undefined || typeof tabs.register !== 'function') {
            console.warn('[dsh-canon-keeper] sidebarRightTabs 服务缺失，标签页未注册');
            return;
          }
          scope.effect(() => tabs.register({
            id: MODULE_ID,
            kind: PANEL_ID,
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [{
              id: 'open',
              order: 46,
              title: () => t('tab.title'),
              description: () => t('tab.guide'),
            }],
          }), 'dsh-canon-keeper: right sidebar tab type');
        });

        // 正文槽位按「生效类型的 id」分派，不是按 kind：
        // 类型的 id 是 MODULE_ID，所以正文/标题的 key 必须是 MODULE_ID。
        // 写成 kind 会让标签页出现在栏里、但正文位置报「这类内容还没有可用的查看方式」。
        register('sidebar.right.pane.tab', { key: MODULE_ID, locale: NS }, CanonTab, 'dsh-canon-keeper: tab body');
        register('sidebar.right.pane.tab.title', { key: MODULE_ID, locale: NS }, CanonTabTitle, 'dsh-canon-keeper: tab title');
      }

      return {
        inject: ['slots'],
        apply,
        // 仅供冒烟测试；宿主不会读取。
        __test: { DICT, CanonTab, CanonTabTitle, CanonIcon, toneOf, statusTextOf, fallbackTranslate },
      };
    },
  });
})();
