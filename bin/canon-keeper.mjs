#!/usr/bin/env node
/**
 * canon-keeper CLI —— 薄壳，全部逻辑走 lib/ops.js，与 Agent 工具共用同一套实现。
 *
 * 退出码：0 = 干净；1 = 有 error；2 = 只有 warn（含未验证的 UNPINNED）。
 *
 * 用法：
 *   canon-keeper check [--force] [--fix-pins] [--json]
 *   canon-keeper list [--kind K] [--status S] [--json]
 *   canon-keeper get <ID> [--json]
 *   canon-keeper stats [--json]
 *   canon-keeper repoint <from> <to> --paths <a.md,b.md> [--apply]
 *   canon-keeper resolve <ID> --file <path> --outcome updated|confirmed --note "…"
 *   canon-keeper ignore <ID> --file <path> --alias "…"
 *
 * @module dsh-canon-keeper/cli
 */

import path from 'node:path';
import process from 'node:process';
import { CanonOps } from '../lib/ops.js';
import { StoreError } from '../lib/store.js';

/** 退出码。 */
const EXIT = { clean: 0, error: 1, warn: 2 };

/**
 * 极简参数解析：`--key value` / `--flag` / 位置参数。
 * @param {string[]} argv 参数。
 * @returns {{_: string[], flags: Record<string, string|boolean>}} 解析结果。
 */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === '') continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { _: positionals, flags };
}

/**
 * 输出帮助。
 * @returns {void}
 */
function usage() {
  process.stdout.write([
    'canon-keeper — 口径守护 CLI',
    '',
    '  canon-keeper check   [--force] [--fix-pins] [--json]',
    '  canon-keeper list    [--kind K] [--status all|problem|stale|orphan] [--query Q] [--json]',
    '  canon-keeper get     <ID> [--json]',
    '  canon-keeper stats   [--json]',
    '  canon-keeper repoint <from> <to> --paths <a.md,b.md> [--apply]',
    '  canon-keeper resolve <ID> --file <path> --outcome updated|confirmed --note "说明"',
    '  canon-keeper ignore  <ID> --file <path> --alias "说法"',
    '',
    '退出码：0 干净 / 1 有 error / 2 只有 warn',
    '',
  ].join('\n'));
}

/**
 * 把逗号分隔的 --paths 拆开。
 * @param {unknown} value 参数值。
 * @returns {string[]} 路径列表。
 */
function splitPaths(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * 主流程。
 * @param {string[]} argv 参数。
 * @returns {Promise<number>} 退出码。
 */
async function main(argv) {
  const { _, flags } = parseArgs(argv);
  const command = _[0] ?? 'check';
  if (command === 'help' || command === '--help' || flags.help === true) {
    usage();
    return EXIT.clean;
  }

  const cwd = process.cwd();
  const ops = new CanonOps({
    cwd,
    storeDir: path.resolve(cwd, typeof flags.store === 'string' ? flags.store : 'canon'),
    lockTimeoutMs: 30_000,
  });
  await ops.ensure();
  const asJson = flags.json === true;

  if (command === 'check') {
    const report = await ops.check({ force: flags.force === true, pinNew: flags['fix-pins'] === true });
    if (asJson) {
      process.stdout.write(`${JSON.stringify({
        stats: report.stats,
        counts: report.counts,
        byCode: report.byCode,
        issues: report.issues,
        pinned: report.pinned,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${ops.renderReport(report)}\n`);
    }
    if ((report.counts?.error ?? 0) > 0) return EXIT.error;
    if ((report.counts?.warn ?? 0) > 0) return EXIT.warn;
    return EXIT.clean;
  }

  if (command === 'list') {
    const result = await ops.list({
      kind: typeof flags.kind === 'string' ? flags.kind : undefined,
      status: typeof flags.status === 'string' ? flags.status : undefined,
      query: typeof flags.query === 'string' ? flags.query : undefined,
      tag: typeof flags.tag === 'string' ? flags.tag : undefined,
      includeArchived: flags.archived === true,
    });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return EXIT.clean;
    }
    const lines = [];
    for (const entry of result.entries) {
      const marks = [];
      if (entry.supersededBy) marks.push(`已被 ${entry.supersededBy} 取代`);
      if ((entry.counts?.error ?? 0) > 0) marks.push(`${entry.counts.error} error`);
      if ((entry.counts?.warn ?? 0) > 0) marks.push(`${entry.counts.warn} warn`);
      lines.push(`${entry.id}  r${entry.rev}  ${entry.kind.padEnd(8)} ${entry.title}${marks.length === 0 ? '' : `  [${marks.join('、')}]`}`);
    }
    process.stdout.write(`${lines.length === 0 ? '（没有条目）' : lines.join('\n')}\n`);
    return EXIT.clean;
  }

  if (command === 'get') {
    const id = _[1];
    if (id === undefined) {
      process.stderr.write('缺少 id：canon-keeper get <ID>\n');
      return EXIT.error;
    }
    const detail = await ops.get(id);
    if (detail === null) {
      process.stderr.write(`没有找到口径 ${id}\n`);
      return EXIT.error;
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      return EXIT.clean;
    }
    const entry = detail.entry;
    const lines = [
      `${entry.id} (${entry.kind}) ${entry.title}`,
      `版本 r${entry.rev}${entry.supersededBy ? `（已被 ${entry.supersededBy} 取代）` : ''}`,
      '',
      entry.statement,
      '',
      `引用 ${detail.refs.length} 处：`,
    ];
    for (const ref of detail.refs) {
      const pin = ref.pinRev === null || ref.pinRev === undefined ? '未钉版本' : `r${ref.pinRev}`;
      lines.push(`  ${ref.file}:${ref.line}  ${pin}`);
      lines.push(`    ${ref.snippet ?? ''}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.clean;
  }

  if (command === 'stats') {
    const stats = await ops.stats();
    if (asJson) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return EXIT.clean;
    }
    process.stdout.write([
      `口径        ${stats.entries}`,
      `引用        ${stats.refs}（已对齐 ${stats.aligned} / 过期 ${stats.stale} / 未验证 ${stats.unpinned} / 悬空 ${stats.dangling}）`,
      `标记覆盖率  ${(Number(stats.coverage) * 100).toFixed(1)}%`,
      `遗漏命中    ${stats.unmarkedHits}`,
      `废弃复活    ${stats.resurrectedHits}`,
      `无引用      ${stats.orphan}`,
      `盖章率      ${(Number(stats.confirmedRatio) * 100).toFixed(1)}%（confirmed ${stats.confirmed} / updated ${stats.updated}）`,
      '',
    ].join('\n'));
    return EXIT.clean;
  }

  if (command === 'repoint') {
    const from = _[1];
    const to = _[2];
    if (from === undefined || to === undefined) {
      process.stderr.write('用法：canon-keeper repoint <from> <to> --paths <a.md,b.md> [--apply]\n');
      return EXIT.error;
    }
    const result = await ops.repoint(from, to, {
      paths: splitPaths(flags.paths),
      apply: flags.apply === true,
      actor: { kind: 'cli', pid: process.pid },
    });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return EXIT.clean;
    }
    const lines = [`repoint ${result.from} → ${result.to}（${result.apply ? '已写入' : '预览，加 --apply 才写'}）`];
    for (const change of result.changes) {
      if (change.skipped === true) {
        lines.push(`  ${change.file}  跳过：${change.reason}`);
        continue;
      }
      lines.push(`  ${change.file}  ${change.hits.length} 处`);
      for (const hit of change.hits) lines.push(`    ${hit.line}: ${hit.after}`);
    }
    if (result.markers === 0) lines.push('  没有命中任何标记。');
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.clean;
  }

  if (command === 'resolve') {
    const id = _[1];
    const file = typeof flags.file === 'string' ? flags.file : '';
    const outcome = flags.outcome === 'updated' ? 'updated' : 'confirmed';
    const note = typeof flags.note === 'string' ? flags.note : '';
    if (id === undefined || file === '' || note === '') {
      process.stderr.write('用法：canon-keeper resolve <ID> --file <path> --outcome updated|confirmed --note "说明"\n');
      return EXIT.error;
    }
    const result = await ops.resolve([{ entryId: id, file, outcome, note }], {
      actor: { kind: 'cli', pid: process.pid },
    });
    for (const item of result.results) process.stdout.write(`${item.ok ? '✓' : '✗'} ${item.message}\n`);
    return result.ok ? EXIT.clean : EXIT.error;
  }

  if (command === 'ignore') {
    const id = _[1];
    const file = typeof flags.file === 'string' ? flags.file : '';
    const alias = typeof flags.alias === 'string' ? flags.alias : '';
    if (id === undefined || file === '' || alias === '') {
      process.stderr.write('用法：canon-keeper ignore <ID> --file <path> --alias "说法"\n');
      return EXIT.error;
    }
    await ops.store.appendAudit({
      op: 'ignore-mention',
      entryId: id,
      file,
      alias,
      actor: { kind: 'cli', pid: process.pid },
      note: typeof flags.note === 'string' ? flags.note : '',
    });
    process.stdout.write(`已忽略：${file} 里 ${id} 的「${alias}」不再报未标记命中。\n`);
    return EXIT.clean;
  }

  process.stderr.write(`未知命令：${command}\n`);
  usage();
  return EXIT.error;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof StoreError) {
      process.stderr.write(`[${error.code}] ${error.message}\n`);
    } else {
      process.stderr.write(`${error?.stack ?? String(error)}\n`);
    }
    process.exitCode = EXIT.error;
  });
