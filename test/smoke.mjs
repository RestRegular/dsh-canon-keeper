/**
 * M1 冒烟测试：不依赖宿主，纯 Node 跑。
 *
 * 覆盖设计里每一条「容易被做错」的机制，而不只是 CRUD 能跑：
 *   - rev 与 change 解耦（wording 不涨 rev）
 *   - 标记解析跳过代码块、行内代码
 *   - UNPINNED 计为未验证，且不计入覆盖率
 *   - --fix-pins 只补 rev == 1
 *   - resolve 是验证不是盖章（段落没变就不许记 updated）
 *   - repoint 默认 dry-run 且不钉版本
 *   - 坏档拒绝写入（不静默从空库起）
 *   - 同 id 两文件 → DUPLICATE_ID
 *
 * 用法：node test/smoke.mjs
 *
 * @module dsh-canon-keeper/test/smoke
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonOps } from '../lib/ops.js';
import { StoreError, defaultStoreDir } from '../lib/store.js';
import {
  extractMarkers,
  maskInlineCode,
  renderMarker,
  styleFor,
} from '../lib/marker.js';
import { parseDocument } from '../lib/scan.js';
import { globToRegExp, matchesAny, similarity } from '../lib/util.js';

let passed = 0;
let failed = 0;
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
    failed += 1;
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error?.message ?? error}\n`);
  }
}

/**
 * 建一个临时工作区。
 * @returns {Promise<string>} 目录。
 */
async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-keeper-'));
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

/**
 * 建 ops。
 * @param {string} dir 工作区。
 * @returns {Promise<CanonOps>} ops。
 */
async function makeOps(dir) {
  const ops = new CanonOps({ cwd: dir, storeDir: path.join(dir, 'canon') });
  await ops.ensure();
  return ops;
}

/**
 * 写文件。
 * @param {string} dir 工作区。
 * @param {string} rel 相对路径。
 * @param {string} text 内容。
 * @returns {Promise<void>} 完成。
 */
async function writeDoc(dir, rel, text) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

/**
 * 读文件。
 * @param {string} dir 工作区。
 * @param {string} rel 相对路径。
 * @returns {Promise<string>} 内容。
 */
async function readDoc(dir, rel) {
  return fs.readFile(path.join(dir, rel), 'utf8');
}

process.stdout.write('canon-keeper M1 smoke\n\n');

// ---------------------------------------------------------------------------
process.stdout.write('util / marker\n');

await test('glob 匹配：** 跨目录、目录名匹配整棵子树', () => {
  assert.equal(matchesAny('docs/handover/a.md', ['docs/handover/**']), true);
  assert.equal(matchesAny('node_modules/x/y.md', ['node_modules']), true);
  assert.equal(matchesAny('src/index.md', ['node_modules']), false);
  assert.equal(globToRegExp('**/CHANGELOG.md').test('a/b/CHANGELOG.md'), true);
  assert.equal(globToRegExp('**/CHANGELOG.md').test('CHANGELOG.md'), true);
});

await test('相似度：同一句话高、无关话低', () => {
  const high = similarity('所有对外接口超时默认 8 秒', '所有对外接口的超时默认是 8 秒');
  const low = similarity('所有对外接口超时默认 8 秒', '前端使用 React 19 与 Vite 构建');
  assert.ok(high > low, `high=${high} low=${low}`);
});

await test('标记生成：按扩展名选样式', () => {
  assert.equal(styleFor('a.md'), 'html');
  assert.equal(styleFor('a.mdx'), 'mdx');
  assert.equal(styleFor('a.rst'), 'rst');
  assert.equal(styleFor('a.adoc'), 'adoc');
  assert.equal(styleFor('a.txt'), 'plain');
  assert.equal(renderMarker('D-001', 3, 'html'), '<!-- canon:D-001@r3 -->');
  assert.equal(renderMarker('D-001', 3, 'mdx'), '{/* canon:D-001@r3 */}');
  assert.equal(renderMarker('D-001', null, 'html'), '<!-- canon:D-001 -->');
});

await test('标记抽取：多种样式都能识别', () => {
  const cases = [
    '<!-- canon:D-001@r3 -->',
    '{/* canon:R-002 */}',
    '.. canon:V-007@r12',
    '// canon:T-1',
    '[[canon:F-0001@r2]]',
  ];
  const got = cases.map((line) => extractMarkers(line)[0]);
  assert.equal(got[0].id, 'D-001');
  assert.equal(got[0].rev, 3);
  assert.equal(got[1].id, 'R-002');
  assert.equal(got[1].rev, null);
  assert.equal(got[2].id, 'V-007');
  assert.equal(got[2].rev, 12);
  assert.equal(got[3].id, 'T-1');
  assert.equal(got[4].id, 'F-0001');
  assert.equal(got[4].rev, 2);
});

await test('行内代码里的标记被抹掉', () => {
  const line = '写 `<!-- canon:D-001@r1 -->` 这样的标记';
  assert.equal(maskInlineCode(line).includes('canon:D-001'), false);
  assert.equal(maskInlineCode(line).length, line.length, '抹成等长空白，列位置不变');
});

await test('围栏代码块里的标记不算引用', () => {
  const text = [
    '# 标题',
    '',
    '```md',
    '<!-- canon:D-001@r1 -->',
    '```',
    '',
    '正文 <!-- canon:R-002@r1 --> 结束',
  ].join('\n');
  const { lines } = parseDocument(text);
  const found = [];
  for (const line of lines) found.push(...extractMarkers(line));
  assert.equal(found.length, 1, '只应识别正文里的那一个');
  assert.equal(found[0].id, 'R-002');
});

await test('段落哈希：标记不影响哈希，空白不影响哈希', () => {
  const a = parseDocument('正文内容 <!-- canon:D-001@r1 --> 结束');
  const b = parseDocument('正文内容 <!-- canon:D-001@r9 -->   结束');
  assert.equal(a.paragraphs[0].hash, b.paragraphs[0].hash);
  const c = parseDocument('正文内容改了 <!-- canon:D-001@r1 --> 结束');
  assert.notEqual(a.paragraphs[0].hash, c.paragraphs[0].hash);
});

await test('标记独占一行时归属其后段落', () => {
  const text = ['<!-- canon:D-001@r1 -->', '', '这是被约束的段落。'].join('\n');
  const { paragraphs } = parseDocument(text);
  const target = paragraphs.find((item) => item.text.includes('被约束'));
  assert.ok(target !== undefined);
  assert.ok(target.hash.length === 8);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nstore\n');

await test('新增条目：id 按前缀递增并补零', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const a = await ops.store.add({ kind: 'decision', statement: '第一条决策' });
  const b = await ops.store.add({ kind: 'decision', statement: '第二条决策' });
  const c = await ops.store.add({ kind: 'rule', statement: '第一条规则' });
  assert.equal(a.id, 'D-001');
  assert.equal(b.id, 'D-002');
  assert.equal(c.id, 'R-001');
  assert.equal(a.rev, 1);
});

await test('wording 不涨 rev，semantic 涨 rev', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  const w = await ops.store.update(entry.id, { statement: '超时默认 8 秒（口径）' }, { change: 'wording' });
  assert.equal(w.entry.rev, 1, 'wording 不该涨版本');
  assert.equal(w.revChanged, false);
  const s = await ops.store.update(entry.id, { statement: '超时默认 5 秒' }, { change: 'semantic' });
  assert.equal(s.entry.rev, 2, 'semantic 必须涨版本');
  assert.equal(s.revChanged, true);
  assert.equal(s.entry.history.length, 3, 'history 只追加 seq');
  assert.deepEqual(s.entry.history.map((item) => item.seq), [1, 2, 3]);
});

await test('语义改动自动累积废弃说法', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({
    kind: 'decision',
    statement: '网关超时 8 秒',
    aliases: ['网关超时八秒', '8 秒超时'],
  });
  const result = await ops.store.update(entry.id, { aliases: ['网关超时五秒'] }, { change: 'semantic' });
  assert.ok(result.deprecatedAdded.includes('网关超时八秒'), '被换掉的定位词要记为废弃');
  assert.ok(result.deprecatedAdded.includes('8 秒超时'));
  const after = await ops.store.get(entry.id);
  assert.equal(after.deprecatedPhrases.length, 2);
  assert.equal(after.deprecatedPhrases[0].retiredAtRev, 2);
});

await test('坏档拒绝写入，且不从空库起', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await ops.store.add({ kind: 'decision', statement: '会被保留的决策' });
  await fs.writeFile(path.join(dir, 'canon', 'entries', 'D-999.json'), '{ 坏掉的 JSON', 'utf8');
  await ops.store.reload();
  assert.equal(ops.store.writable().ok, false);
  await assert.rejects(
    () => ops.store.add({ kind: 'decision', statement: '不该写进去' }),
    (error) => error instanceof StoreError && error.code === 'STORE_UNREADABLE',
  );
  const ids = ops.store.list().map((entry) => entry.id);
  assert.ok(ids.includes('D-001'), '已有条目必须还在');
});

await test('同一 id 两个文件 → DUPLICATE_ID', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '原始决策' });
  const copy = { ...entry, statement: '另一个分支的决策' };
  await fs.writeFile(
    path.join(dir, 'canon', 'entries', `${entry.id}.copy.json`),
    `${JSON.stringify(copy, null, 2)}\n`,
    'utf8',
  );
  await ops.store.reload();
  const report = await ops.check();
  const codes = report.issues.map((item) => item.code);
  assert.ok(codes.includes('DUPLICATE_ID'), `应报 DUPLICATE_ID，实际：${codes.join(',')}`);
});

await test('take ours 解冲突后只剩一个文件，靠审计指纹报 ID_COLLISION', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '我们这侧的决策' });
  // 模拟 merge=union 之后的审计：另一个分支也用 D-001 登记了不同的事实，
  // 但解冲突时 take ours 把它的条目文件丢掉了，只剩审计里那条 add。
  const { fingerprintOf } = await import('../lib/util.js');
  await ops.store.appendAudit({
    op: 'add',
    entryId: entry.id,
    fingerprint: fingerprintOf({ id: entry.id, statement: '他们那侧的决策' }),
    actor: { kind: 'agent', name: 'other-branch' },
    note: '另一分支的登记',
  });
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.DUPLICATE_ID ?? 0, 0, '文件只剩一个，DUPLICATE_ID 抓不到');
  assert.equal(report.byCode.ID_COLLISION, 1, '必须由审计指纹兜住');
  assert.equal(report.byCode.ID_COLLISION === undefined ? 0 : 1, 1);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nscan / rules\n');

await test('已对齐的标记不报问题，未对齐报 STALE', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒', aliases: ['超时默认'] });
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 8 秒。${renderMarker(entry.id, 1)}\n`);
  let report = await ops.check({ force: true });
  assert.equal(report.byCode.STALE ?? 0, 0);
  assert.equal(report.byCode.UNPINNED ?? 0, 0);

  await ops.store.update(entry.id, { statement: '超时默认 5 秒' }, { change: 'semantic' });
  report = await ops.check({ force: true });
  assert.equal(report.byCode.STALE, 1, 'r1 的标记在口径到 r2 后必须报 STALE');
  assert.equal(report.stats.stale, 1);
});

await test('UNPINNED 计为未验证且不进覆盖率分子', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 8 秒。${renderMarker(entry.id, null)}\n`);
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.UNPINNED, 1);
  assert.equal(report.stats.unpinned, 1);
  assert.equal(report.stats.aligned, 0);
  assert.equal(report.stats.coverage, 0, 'UNPINNED 不能算覆盖');
});

await test('--fix-pins 只补 rev == 1', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const fresh = await ops.store.add({ kind: 'decision', statement: '新决策' });
  const aged = await ops.store.add({ kind: 'decision', statement: '老决策 v1' });
  await ops.store.update(aged.id, { statement: '老决策 v2' }, { change: 'semantic' });
  await writeDoc(dir, 'docs/a.md', [
    '# A',
    '',
    `新决策。${renderMarker(fresh.id, null)}`,
    '',
    `老决策。${renderMarker(aged.id, null)}`,
    '',
  ].join('\n'));
  const before = await ops.check({ force: true });
  assert.equal(before.byCode.UNPINNED, 2);

  const pinned = await ops.fixPins();
  assert.equal(pinned.markers, 1, '只补 rev==1 的那一个');
  assert.equal(pinned.skipped, 1, 'rev>1 的必须留给人核验');

  const text = await readDoc(dir, 'docs/a.md');
  assert.ok(text.includes(`canon:${fresh.id}@r1`), '新条目应被补成 @r1');
  assert.ok(!text.includes(`canon:${aged.id}@r`), 'rev>1 的不能被猜着补版本');
});

await test('repoint 默认 dry-run 且不钉版本', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const from = await ops.store.add({ kind: 'decision', statement: '旧说法' });
  const to = await ops.store.add({ kind: 'decision', statement: '新说法' });
  await ops.store.update(to.id, { statement: '新说法 v2' }, { change: 'semantic' });
  const original = `# A\n\n旧说法。${renderMarker(from.id, 2)}\n`;
  await writeDoc(dir, 'docs/a.md', original);

  const preview = await ops.repoint(from.id, to.id, { paths: ['docs/a.md'] });
  assert.equal(preview.apply, false);
  assert.equal(preview.markers, 1);
  assert.equal(await readDoc(dir, 'docs/a.md'), original, 'dry-run 不能改文件');

  const applied = await ops.repoint(from.id, to.id, { paths: ['docs/a.md'], apply: true });
  assert.equal(applied.apply, true);
  const text = await readDoc(dir, 'docs/a.md');
  assert.ok(text.includes(`canon:${to.id} `), '应改成目标 id');
  assert.ok(!text.includes(`@r`), 'repoint 不钉版本，必须留 UNPINNED');
  assert.ok(text.includes('旧说法。'), '正文不能被改动');
});

await test('resolve：段落没变不许记 updated，变了才行', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 8 秒。${renderMarker(entry.id, 1)}\n`);
  await ops.check({ force: true });

  // 段落没改，记 updated 应被拒
  const bad = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'updated', note: '我以为改了' }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.results[0].error, 'TEXT_UNCHANGED');

  // 记 confirmed 可以
  const ok = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'confirmed', note: '这处只提概念，不需要改' }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.results[0].outcome, 'confirmed');

  // 段落改了，记 updated 可以
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 5 秒。${renderMarker(entry.id, 1)}\n`);
  const updated = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'updated', note: '改成 5 秒' }]);
  assert.equal(updated.ok, true);
  assert.equal(updated.results[0].outcome, 'updated');
  assert.equal(updated.results[0].verified, true);
});

await test('resolve：标记没钉到当前版本一律拒绝', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: 'v1' });
  await writeDoc(dir, 'docs/a.md', `# A\n\nv1 正文。${renderMarker(entry.id, null)}\n`);
  await ops.check({ force: true });
  const result = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'confirmed', note: '没问题' }]);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].error, 'MARKER_NOT_REPINNED');

  await ops.store.update(entry.id, { statement: 'v2' }, { change: 'semantic' });
  await writeDoc(dir, 'docs/a.md', `# A\n\nv2 正文。${renderMarker(entry.id, 1)}\n`);
  const stale = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'confirmed', note: '没问题' }]);
  assert.equal(stale.ok, false, '钉在 r1 而口径是 r2 时必须拒绝');
});

await test('resolve 空 note 一律拒绝', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: 'x' });
  await assert.rejects(
    () => ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'confirmed', note: '  ' }]),
    (error) => error.code === 'MISSING_NOTE',
  );
});

await test('DANGLING：标记指向不存在的口径', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await ops.store.add({ kind: 'decision', statement: '存在的决策' });
  await writeDoc(dir, 'docs/a.md', '# A\n\n一段话 <!-- canon:D-777@r1 -->\n');
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.DANGLING, 1);
  assert.equal(report.counts.error, 1);
});

await test('RESURRECTED：废弃说法复活', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({
    kind: 'decision',
    statement: '网关超时 8 秒',
    aliases: ['网关超时八秒'],
  });
  await ops.store.update(entry.id, { aliases: ['网关超时五秒'] }, { change: 'semantic' });
  await writeDoc(dir, 'docs/a.md', '# A\n\n老文档里还写着网关超时八秒。\n');
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.RESURRECTED, 1);
});

await test('UNMARKED_MENTION：命中定位词但没标记', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒', aliases: ['超时默认'] });
  await writeDoc(dir, 'docs/a.md', '# A\n\n这里提到超时默认但没标记。\n');
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.UNMARKED_MENTION, 1);
});

await test('ORPHAN：没有引用的口径', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await ops.store.add({ kind: 'decision', statement: '没人引用的决策' });
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.ORPHAN, 1);
});

await test('历史类文档的告警降级为 info', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await ops.store.update(entry.id, { statement: '超时默认 5 秒' }, { change: 'semantic' });
  await writeDoc(dir, 'docs/handover/old.md', `# 交接\n\n超时默认 8 秒。${renderMarker(entry.id, 1)}\n`);
  const report = await ops.check({ force: true });
  const stale = report.issues.find((item) => item.code === 'STALE');
  assert.ok(stale !== undefined, '仍要报出来');
  assert.equal(stale.level, 'info', '历史文档只作提示');
  assert.equal(stale.demoted, true);
});

await test('SUPERSEDED_REF：指向已归档的口径', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const old = await ops.store.add({ kind: 'decision', statement: '旧决策' });
  const fresh = await ops.store.add({ kind: 'decision', statement: '新决策' });
  await ops.store.archive(old.id, { supersededBy: fresh.id, note: '被取代' });
  await writeDoc(dir, 'docs/a.md', `# A\n\n旧决策正文。${renderMarker(old.id, 1)}\n`);
  const report = await ops.check({ force: true });
  assert.equal(report.byCode.SUPERSEDED_REF, 1);
});

await test('canon_add 返回相似条目用于查重', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await ops.add({ kind: 'decision', statement: '所有对外接口的超时默认 8 秒' });
  const second = await ops.add({ kind: 'decision', statement: '所有对外接口的超时默认 8 秒整' });
  assert.ok(second.similar.length >= 1, '应提示已有相似条目');
  assert.equal(second.similar[0].id, 'D-001');
});

await test('canon_update 返回影响清单与新旧对照', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 8 秒。${renderMarker(entry.id, 1)}\n`);
  await writeDoc(dir, 'docs/b.md', `# B\n\n另处也提。${renderMarker(entry.id, 1)}\n`);
  const result = await ops.update(entry.id, { statement: '超时默认 5 秒' }, { change: 'semantic' });
  assert.equal(result.impact.length, 2, '两处引用都要列出来');
  assert.ok(result.impact.every((item) => item.stale === true));
  assert.ok(result.impact.every((item) => item.before !== item.after));
});

await test('增量扫描：未改动文件走缓存', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await ops.store.add({ kind: 'decision', statement: 'x' });
  await writeDoc(dir, 'docs/a.md', '# A\n\n内容一 <!-- canon:D-001@r1 -->\n');
  await writeDoc(dir, 'docs/b.md', '# B\n\n内容二 <!-- canon:D-001@r1 -->\n');
  const first = await ops.check({ force: true });
  assert.equal(first.scan.scanned, 2);
  const second = await ops.check();
  assert.equal(second.scan.scanned, 0, '第二次应全部命中缓存');
  assert.equal(second.scan.refs.length, 2, '缓存里也要有引用');
});

await test('局部重扫（resolve）不会把索引裁成只剩一个文件', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const a = await ops.store.add({ kind: 'decision', statement: '决策 A' });
  const b = await ops.store.add({ kind: 'decision', statement: '决策 B' });
  await writeDoc(dir, 'docs/a.md', `# A\n\n决策 A 正文。${renderMarker(a.id, 1)}\n`);
  await writeDoc(dir, 'docs/b.md', `# B\n\n决策 B 正文。${renderMarker(b.id, 1)}\n`);
  await ops.check({ force: true });
  assert.equal(ops.lastScan.refs.length, 2);

  // resolve 只重扫 docs/a.md，但 docs/b.md 的引用必须还在索引里。
  await ops.resolve([{ entryId: a.id, file: 'docs/a.md', outcome: 'confirmed', note: '确认无影响' }]);
  assert.equal(ops.lastScan.refs.length, 2, '局部重扫不能丢掉未触及文件的引用');
  const files = Object.keys(ops.lastScan.fileCache);
  assert.equal(files.length, 2, '索引缓存里两个文件都要在');

  // 再跑一次普通 check，仍应全部命中缓存。
  const again = await ops.check();
  assert.equal(again.scan.refs.length, 2);
});

await test('代码块里的标记不产生引用（端到端）', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await writeDoc(dir, 'docs/guide.md', [
    '# 标记语法',
    '',
    '在正文里这样写：',
    '',
    '```md',
    `超时默认 8 秒。${renderMarker(entry.id, 1)}`,
    '```',
    '',
    '行内示例 `<!-- canon:D-001@r1 -->` 也不算。',
    '',
  ].join('\n'));
  const report = await ops.check({ force: true });
  assert.equal(report.scan.refs.length, 0, '文档里讲语法的示例不能被当成真引用');
  assert.equal(report.byCode.ORPHAN, 1);
});

await test('登记新口径后，老文件里的命中必须立刻被看见（缓存不能只看 mtime）', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  await writeDoc(dir, 'docs/a.md', '# A\n\n这里提到网关超时但当时还没登记口径。\n');
  const before = await ops.check({ force: true });
  assert.equal(before.byCode.UNMARKED_MENTION ?? 0, 0, '还没登记时无从命中');

  // 文件没动过，只新增了一条带该定位词的口径。
  await ops.store.add({ kind: 'decision', statement: '网关超时 8 秒', aliases: ['网关超时'] });
  const after = await ops.check();
  assert.equal(after.byCode.UNMARKED_MENTION, 1, '登记后必须立刻报出来，不能等文件改动');
});

await test('resolve：同一文件多处引用要逐处核验，不能只看第一处', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await writeDoc(dir, 'docs/a.md', [
    '# A',
    '',
    `第一处：超时默认 8 秒。${renderMarker(entry.id, 1)}`,
    '',
    `第二处：超时默认 8 秒。${renderMarker(entry.id, 1)}`,
    '',
  ].join('\n'));
  await ops.check({ force: true });
  assert.equal(ops.lastScan.refs.length, 2, '两处都要被扫到');

  const result = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'confirmed', note: '两处都确认' }]);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].lines.length, 2, '两处都要记账，不能只记第一处');

  // 只改第二处：第一处没变，第二处变了，两处基线必须各自独立。
  await writeDoc(dir, 'docs/a.md', [
    '# A',
    '',
    `第一处：超时默认 8 秒。${renderMarker(entry.id, 1)}`,
    '',
    `第二处：超时默认 5 秒。${renderMarker(entry.id, 1)}`,
    '',
  ].join('\n'));
  const partial = await ops.resolve([{ entryId: entry.id, file: 'docs/a.md', outcome: 'updated', note: '改了第二处' }]);
  assert.equal(partial.ok, false, '第一处没改，整体不能算 updated 通过');
  assert.equal(partial.results[0].error, 'TEXT_UNCHANGED');
  assert.equal(partial.results[0].done.length, 1, '改过的第二处应已记账');
});

await test('扫描不会悄悄把改动过的段落认成基线', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const entry = await ops.store.add({ kind: 'decision', statement: '超时默认 8 秒' });
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 8 秒。${renderMarker(entry.id, 1)}\n`);
  await ops.check({ force: true });

  // 段落被改（但标记版本没动）→ 必须报 TEXT_CHANGED，且重复扫描不能自愈。
  await writeDoc(dir, 'docs/a.md', `# A\n\n超时默认 9 秒了。${renderMarker(entry.id, 1)}\n`);
  const first = await ops.check({ force: true });
  assert.equal(first.byCode.TEXT_CHANGED, 1, '第一次扫描必须报漂移');
  const second = await ops.check({ force: true });
  assert.equal(second.byCode.TEXT_CHANGED, 1, '再扫一次也不能自己消失');
});

await test('stats 的三个试跑指标可算', async () => {
  const dir = await makeWorkspace();
  const ops = await makeOps(dir);
  const a = await ops.store.add({ kind: 'decision', statement: '决策 A' });
  const b = await ops.store.add({ kind: 'decision', statement: '决策 B' });
  await writeDoc(dir, 'docs/a.md', [
    '# A',
    '',
    `决策 A 正文。${renderMarker(a.id, 1)}`,
    '',
    `决策 B 正文。${renderMarker(b.id, null)}`,
    '',
  ].join('\n'));
  await ops.check({ force: true });
  await ops.resolve([{ entryId: a.id, file: 'docs/a.md', outcome: 'confirmed', note: '确认无影响' }]);
  const stats = await ops.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.aligned, 1);
  assert.equal(stats.unpinned, 1);
  assert.equal(stats.confirmed, 1);
  assert.ok(stats.coverage > 0 && stats.coverage < 1, `coverage=${stats.coverage}`);
});

await test('旧 canon/ 数据自动迁移到默认目录（复制，不删旧目录）', async () => {
  const dir = await makeWorkspace();
  // 在旧默认目录 canon/ 造一条真实条目 + 审计，再用默认 storeDir 建 ops。
  const legacyEntries = path.join(dir, 'canon', 'entries');
  await fs.mkdir(legacyEntries, { recursive: true });
  const legacyEntry = {
    id: 'D-001', kind: 'decision', title: '旧库决策', statement: '超时默认 8 秒',
    aliases: ['8 秒超时'], deprecatedPhrases: [], tags: [], rev: 1,
    supersededBy: null, createdAt: 1, updatedAt: 1,
    history: [{ seq: 1, rev: 1, change: 'add', at: 1, actor: 'test', note: '旧库登记', statement: '超时默认 8 秒', aliases: ['8 秒超时'] }],
  };
  await fs.writeFile(path.join(legacyEntries, 'D-001.json'), `${JSON.stringify(legacyEntry, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'canon', 'audit.jsonl'), `${JSON.stringify({ at: 1, op: 'add', entryId: 'D-001' })}\n`, 'utf8');

  const ops = new CanonOps({ cwd: dir, storeDir: defaultStoreDir(dir) });
  await ops.ensure();

  // 新库能读到迁移过来的条目。
  assert.equal(ops.store.list().length, 1, '新库应读到迁移过来的条目');
  assert.equal(ops.store.get('D-001').statement, '超时默认 8 秒');
  // 旧目录原样保留作备份。
  const oldStillThere = await fs.readFile(path.join(legacyEntries, 'D-001.json'), 'utf8');
  assert.ok(oldStillThere.includes('旧库决策'), '旧目录必须保留');
  // 审计里有一条迁移记录。
  const audit = await ops.store.readAudit();
  assert.ok(audit.some((e) => e.op === 'migrate-store'), '应记录一次迁移');
});

await test('迁移是幂等的：重复初始化不会覆盖已迁入的新库', async () => {
  const dir = await makeWorkspace();
  const legacyEntries = path.join(dir, 'canon', 'entries');
  await fs.mkdir(legacyEntries, { recursive: true });
  const mk = (statement) => ({
    id: 'D-001', kind: 'decision', title: statement, statement,
    aliases: [], deprecatedPhrases: [], tags: [], rev: 1,
    supersededBy: null, createdAt: 1, updatedAt: 1,
    history: [{ seq: 1, rev: 1, change: 'add', at: 1, actor: 'test', note: statement, statement, aliases: [] }],
  });
  await fs.writeFile(path.join(legacyEntries, 'D-001.json'), `${JSON.stringify(mk('旧库的值'), null, 2)}\n`, 'utf8');

  const ops1 = new CanonOps({ cwd: dir, storeDir: defaultStoreDir(dir) });
  await ops1.ensure();
  // 用户在新库里把 D-001 的 statement 直接改掉（模拟已迁入后又在用）。
  const migrated = ops1.store.get('D-001');
  await ops1.store.persist({ ...migrated, statement: '新库改过的值' }, migrated.file);
  await ops1.store.reload();

  // 再来一次初始化，旧目录还在，但新库已有条目，不应被旧库覆盖。
  const ops2 = new CanonOps({ cwd: dir, storeDir: defaultStoreDir(dir) });
  await ops2.ensure();
  assert.equal(ops2.store.get('D-001').statement, '新库改过的值', '新库数据不能被旧库覆盖');
  const audit = await ops2.store.readAudit();
  assert.equal(audit.filter((e) => e.op === 'migrate-store').length, 1, '迁移只应发生一次');
});

await test('自定义 storeDir 不触发迁移', async () => {
  const dir = await makeWorkspace();
  const custom = path.join(dir, 'my-canon');
  const ops = new CanonOps({ cwd: dir, storeDir: custom });
  const result = await ops.migrateLegacyStore();
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'custom-store-dir');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nsummary\n');
process.stdout.write(`  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write('\nfailures:\n');
  for (const item of failures) {
    process.stdout.write(`\n  ${item.name}\n  ${item.error?.stack ?? item.error}\n`);
  }
  process.exitCode = 1;
}
