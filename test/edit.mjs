/**
 * `ops.editText` / `ops.readParagraph` 的测试。
 *
 * 这两条是面板「直接改文档」的唯一写盘路径，所以重点不是顺利路径，
 * 而是三道保护是否真的拦得住：冲突、空备注、越界路径。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonOps } from '../lib/ops.js';

let passed = 0;
let failed = 0;

/**
 * 断言。
 * @param {string} name 名称。
 * @param {boolean} condition 条件。
 * @param {string} [detail] 细节。
 * @returns {void}
 */
function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/**
 * 建一个临时工作区并登记一条口径。
 * @param {string} docText 文档内容。
 * @returns {Promise<{dir: string, ops: object}>} 环境。
 */
async function setup(docText) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-edit-'));
  await fs.writeFile(path.join(dir, 'notes.md'), docText, 'utf8');
  const ops = new CanonOps({ cwd: dir, storeDir: path.join(dir, 'canon') });
  await ops.ensure();
  await ops.add({
    id: 'D-001',
    kind: 'decision',
    title: '网关超时',
    statement: '网关超时统一 30 秒。',
    aliases: ['网关超时'],
  }, { actor: { kind: 'user', name: 'test' } });
  // 先扫一遍建立基线。
  await ops.rescan({ force: true });
  return { dir, ops };
}

/**
 * 取段落哈希（模拟面板读到的值）。
 * @param {object} ops 操作层。
 * @returns {Promise<string>} 哈希。
 */
async function hashOf(ops) {
  const paragraph = await ops.readParagraph({ entryId: 'D-001', file: 'notes.md' });
  return paragraph.hash;
}

/** 段落读取。 */
{
  const { dir, ops } = await setup(
    '<!-- canon:D-001@r1 -->\n网关超时是 30 秒。\n',
  );
  const paragraph = await ops.readParagraph({ entryId: 'D-001', file: 'notes.md' });
  ok('readParagraph 返回段落原文', paragraph.text === '网关超时是 30 秒。', paragraph.text);
  ok('readParagraph 带回哈希', typeof paragraph.hash === 'string' && paragraph.hash.length > 0);
  ok('readParagraph 行号正确', paragraph.startLine === 2, String(paragraph.startLine));
  await fs.rm(dir, { recursive: true, force: true });
}

/** 正常改文：写盘 + 自动核验。 */
{
  const { dir, ops } = await setup(
    '<!-- canon:D-001@r1 -->\n网关超时是 30 秒。\n',
  );
  const hash = await hashOf(ops);
  const result = await ops.editText({
    entryId: 'D-001',
    file: 'notes.md',
    text: '网关超时是 60 秒，超过即重试。',
    expectedHash: hash,
    note: '按新口径改成 60 秒',
  }, { actor: { kind: 'user', name: 'test' } });

  const written = await fs.readFile(path.join(dir, 'notes.md'), 'utf8');
  ok('editText 写回了新文本', written.includes('60 秒'), written);
  ok('editText 保留了标记行', written.includes('canon:D-001@r1'), written);
  ok('editText 结果 ok', result.ok === true, JSON.stringify(result.resolved?.failed ?? []));
  await fs.rm(dir, { recursive: true, force: true });
}

/** 冲突：磁盘变了，拒绝写入。 */
{
  const { dir, ops } = await setup(
    '<!-- canon:D-001@r1 -->\n网关超时是 30 秒。\n',
  );
  const staleHash = await hashOf(ops);

  // 模拟别人在面板打开后改了文件。
  await fs.writeFile(
    path.join(dir, 'notes.md'),
    '<!-- canon:D-001@r1 -->\n网关超时是 45 秒（别人改的）。\n',
    'utf8',
  );

  let error = null;
  try {
    await ops.editText({
      entryId: 'D-001',
      file: 'notes.md',
      text: '网关超时是 60 秒。',
      expectedHash: staleHash,
      note: '我这边也改',
    }, { actor: { kind: 'user', name: 'test' } });
  } catch (failure) {
    error = failure;
  }

  const onDisk = await fs.readFile(path.join(dir, 'notes.md'), 'utf8');
  ok('冲突时报 FILE_CHANGED', error?.code === 'FILE_CHANGED', String(error?.code));
  ok('冲突时没有覆盖别人的改动', onDisk.includes('别人改的'), onDisk);
  await fs.rm(dir, { recursive: true, force: true });
}

/** 空备注：拒绝。 */
{
  const { dir, ops } = await setup(
    '<!-- canon:D-001@r1 -->\n网关超时是 30 秒。\n',
  );
  const hash = await hashOf(ops);
  let error = null;
  try {
    await ops.editText({
      entryId: 'D-001',
      file: 'notes.md',
      text: '网关超时是 60 秒。',
      expectedHash: hash,
      note: '   ',
    }, { actor: { kind: 'user', name: 'test' } });
  } catch (failure) {
    error = failure;
  }
  ok('空备注报 NOTE_REQUIRED', error?.code === 'NOTE_REQUIRED', String(error?.code));
  await fs.rm(dir, { recursive: true, force: true });
}

/** 越界路径：拒绝。 */
{
  const { dir, ops } = await setup(
    '<!-- canon:D-001@r1 -->\n网关超时是 30 秒。\n',
  );
  let error = null;
  try {
    await ops.editText({
      entryId: 'D-001',
      file: '../../etc/passwd',
      text: 'x',
      note: '越界尝试',
    }, { actor: { kind: 'user', name: 'test' } });
  } catch (failure) {
    error = failure;
  }
  ok('越界路径报 PATH_OUTSIDE', error?.code === 'PATH_OUTSIDE', String(error?.code));
  await fs.rm(dir, { recursive: true, force: true });
}

/** 绝对路径：拒绝。 */
{
  const { dir, ops } = await setup(
    '<!-- canon:D-001@r1 -->\n网关超时是 30 秒。\n',
  );
  let error = null;
  try {
    await ops.editText({
      entryId: 'D-001',
      file: path.join(dir, 'notes.md'),
      text: 'x',
      note: '绝对路径尝试',
    }, { actor: { kind: 'user', name: 'test' } });
  } catch (failure) {
    error = failure;
  }
  ok('绝对路径报 PATH_INVALID', error?.code === 'PATH_INVALID', String(error?.code));
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
