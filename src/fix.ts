// zomb fix: do the safe clean-up for you, on a branch, proving every step with the project's own checks.
// No AI: deleting dead files, removing dead exports and uninstalling unused packages are mechanical.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { ui } from './terminal.ts';
import type { ScanData } from './types.ts';

type Check = { label: string; cmd: string; args: string[] };

const exec = promisify(execFile);
const CHECK_TIMEOUT = 15 * 60 * 1000;

// Which package manager the repo uses, from its lockfile.
export function packageManager(root: string) {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

// The project's own checks, from its package.json scripts, cheapest first.
export function findChecks(scripts: Record<string, string> = {}, pm = 'npm', { tsc = false }: { tsc?: boolean } = {}): Check[] {
  const has = (name: string) => scripts[name] && !/no test specified/.test(scripts[name]);
  const run = (name: string, label: string): Check => ({ label, cmd: pm, args: pm === 'npm' ? ['run', '--silent', name] : ['run', name] });
  const checks: Check[] = [];
  const type = ['typecheck', 'type-check', 'check-types', 'tsc'].find(has);
  if (type) checks.push(run(type, 'typecheck'));
  else if (tsc) checks.push({ label: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] });
  if (has('lint')) checks.push(run('lint', 'lint'));
  if (has('test')) checks.push(run('test', 'test'));
  if (has('build')) checks.push(run('build', 'build'));
  return checks;
}

// Tools load these from config files by name (compat.extends('next/core-web-vitals')), so "nothing imports it"
// proves nothing. Never uninstall them automatically; list them for a human.
export const isTooling = (name: string) =>
  /^(eslint|@eslint\/|eslint-(config|plugin)-|@typescript-eslint\/|typescript-eslint|prettier|@prettier\/|prettier-plugin-|stylelint|@commitlint\/|husky|lint-staged|@types\/|typescript$|postcss|autoprefixer|tailwindcss|@tailwindcss\/|babel-|@babel\/|@next\/eslint)/.test(name) || /(^|\/)(eslint|prettier|stylelint)-(config|plugin)/.test(name);

const chunk = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export async function fix({ root, data, dryRun = false, noChecks = false, color = true, width = 80, log = console.log }: { root: string; data: ScanData; dryRun?: boolean; noChecks?: boolean; color?: boolean; width?: number; log?: (s: string) => void }): Promise<number> {
  const { W, dim, red, yellow, green, faint, bold, underline, n, plural, clip, row, head, wrap, dots } = ui({ width, color });
  // a running step shows as ▣ on a terminal, then turns into ☒ with how long it took
  const live = Boolean(process.stdout.isTTY) && log === console.log;
  let began = 0;
  const start = (what: string) => ((began = Date.now()), live && process.stdout.write(`   ${bold('▣')}  ${what}…`));
  const finish = (what: string, box = dim('☒')) => log(`${live ? '\r\x1b[2K' : ''}${row(`${box}  ${what}`, faint(`${((Date.now() - began) / 1000).toFixed(1)}s`), 3)}`);
  const git = (...args: string[]) => exec('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());

  const z = data.zombie;
  const files = z.files.filter((f) => !f.script && f.committed);
  const exportCount = z.exports.reduce((s, e) => s + e.names.length, 0);
  const packages = z.packages.map((p) => p.name).filter((p) => !isTooling(p));
  const tooling = z.packages.map((p) => p.name).filter(isTooling);

  // ── the plan
  const lines = files.reduce((s, f) => s + f.lines, 0);
  log('');
  for (const l of head(`${green('⬢ zomb fix')}  ${bold(underline(data.repo))}`, dryRun ? yellow('dry run') : dim('the safe clean-up'))) log(l);
  const plan: [string, string][] = [];
  if (files.length) plan.push([`delete ${plural(files.length, 'dead file')}`, `${n(lines)} lines`]);
  if (exportCount) plan.push([`remove ${plural(exportCount, 'dead export')}`, '']);
  if (packages.length) plan.push([`uninstall ${plural(packages.length, 'unused package')}`, packages.join(' · ')]);
  for (const [what, detail] of plan) log(`   ${dim('☐')}  ${detail ? `${what.padEnd(30)}${dim(clip(detail, W - 36))}` : what}`);
  const scripts = z.files.filter((f) => f.script);
  const loose = z.files.filter((f) => !f.script && !f.committed);
  const left: [string, string[]][] = [
    [`${plural(scripts.length, 'script')} you may run by hand`, scripts.map((f) => f.path)],
    [`${plural(loose.length, 'dead file')} not committed yet`, loose.map((f) => f.path)],
    [`${plural(tooling.length, 'tooling package')} configs may load by name`, tooling],
  ].filter(([, items]) => items.length) as [string, string[]][];
  if (left.length) (log(''), log(dots(bold('left for you'), dim("zomb won't touch these"))));
  for (const [label, items] of left) {
    log(`   ${yellow('!')} ${label}`);
    for (const l of wrap('', items, 5)) log(l);
  }
  if (!files.length && !exportCount && !packages.length) return log(`\n ${green('✓')} Nothing to clean up.\n`), 0;
  if (dryRun) return log(`\n ${dim('Dry run: nothing changed. Run')} ${green('zomb fix')} ${dim('to do it.')}\n`), 0;

  // ── safety first: never mix our changes into uncommitted work
  if (await git('status', '--porcelain', '--untracked-files=no')) {
    log(`\n ${red('✗')} You have uncommitted changes. ${dim('Commit or stash them first: zomb fix commits its work on a new branch.')}\n`);
    return 1;
  }
  const pkg = existsSync(path.join(root, 'package.json')) ? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) : {};
  const pm = packageManager(root);
  const checks = findChecks(pkg.scripts, pm, { tsc: existsSync(path.join(root, 'tsconfig.json')) && existsSync(path.join(root, 'node_modules', '.bin', 'tsc')) });

  // CI=1 keeps test runners out of watch mode
  const runCheck = (c: Check): Promise<{ ok: boolean; tail?: string }> =>
    exec(c.cmd, c.args, { cwd: root, timeout: CHECK_TIMEOUT, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, tail: `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-6).join('\n') }),
    );
  log('');
  log(row(`${dim('⬢')} ${bold('Cleaning')} ${dim('one batch at a time, checking each')}`, '', 1));
  // the checks that pass now judge every change
  const gates: Check[] = [];
  const failing: string[] = [];
  start('running your checks');
  for (const c of checks) {
    if ((await runCheck(c)).ok) gates.push(c);
    else failing.push(c.label);
  }
  finish(`checks before   ${[...gates.map((c) => `${c.label} ${green('✓')}`), ...failing.map((l) => `${l} ${yellow('✗')}`)].join(dim(' · ')) || dim('none found')}`);
  if (failing.length) log(`        ${dim(`${failing.join(', ')} already failing, so ${failing.length === 1 ? 'it' : 'they'} won't judge the changes`)}`);
  if (!gates.length && !noChecks) {
    log(`\n ${red('✗')} No passing typecheck, lint, test or build script to prove the changes safe.`);
    log(`   ${dim('Add one to package.json, or run')} ${green('zomb fix --no-checks')} ${dim('and review the branch yourself.')}\n`);
    return 1;
  }
  const verify = async (): Promise<{ ok: boolean; label?: string; tail?: string }> => {
    for (const c of gates) {
      const r = await runCheck(c);
      if (!r.ok) return { ok: false, label: c.label, tail: r.tail };
    }
    return { ok: true };
  };

  const original = await git('rev-parse', '--abbrev-ref', 'HEAD');
  let branch = `zomb/fix-${new Date().toLocaleDateString('en-CA')}`;
  for (let i = 2; await git('rev-parse', '--verify', '--quiet', branch).then(() => true, () => false); i++) branch = `zomb/fix-${new Date().toLocaleDateString('en-CA')}-${i}`;
  await git('switch', '-q', '-c', branch);
  log(row(`${dim('☒')}  new branch      ${branch}`, '', 3));

  const undo = async (reinstall?: boolean) => {
    await git('reset', '-q', '--hard', 'HEAD'); // only our uncommitted batch: the tree was clean when we started
    if (reinstall) await exec(pm, ['install'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
  };
  const commit = (message: string) => git('commit', '-q', '-m', message, '-m', 'Made by zomb fix: every change passed the project checks before it was kept.');

  // Apply a batch, check it, keep it or undo it. On failure, retry the items one by one and keep the ones that pass.
  const done: { files: ScanData['zombie']['files']; lines: number; exports: boolean; packages: string[] } = { files: [], lines: 0, exports: false, packages: [] };
  const kept: { item: string; why: string }[] = [];
  async function batch<T>(items: T[], apply: (list: T[]) => Promise<unknown>, { reinstall = false, one = (x: T) => String(x) }: { reinstall?: boolean; one?: (x: T) => string } = {}): Promise<T[]> {
    await apply(items);
    let r = gates.length ? await verify() : { ok: true };
    if (r.ok) return items;
    await undo(reinstall);
    if (items.length === 1) return kept.push({ item: one(items[0]), why: `${r.label} failed` }), [];
    const passed: T[] = [];
    for (const item of items) {
      await apply([item]);
      r = await verify();
      if (r.ok) {
        passed.push(item);
        await git('add', '-A');
        await git('commit', '-q', '-m', 'zomb fix: wip');
      } else {
        await undo(reinstall);
        kept.push({ item: one(item), why: `${r.label} failed without it` });
      }
    }
    // fold the one-by-one commits back into one per batch
    if (passed.length) await git('reset', '-q', '--soft', `HEAD~${passed.length}`);
    return passed;
  }

  // ── 1. dead files
  for (const group of chunk(files, 10)) {
    start(`deleting ${plural(group.length, 'dead file')}`);
    const ok = await batch(group, (list) => git('rm', '-q', '--', ...list.map((f) => f.path)), { one: (f) => f.path });
    if (ok.length) {
      const lines = ok.reduce((s, f) => s + f.lines, 0);
      await commit(`zomb fix: delete ${plural(ok.length, 'unused file')} (${n(lines)} lines)`);
      done.files.push(...ok);
      done.lines += lines;
      finish(`deleted ${plural(ok.length, 'file')}  ${dim(`−${n(lines)} lines`)}`);
    } else finish(dim('deleted no files: the checks need them'), yellow('☒'));
  }

  // ── 2. dead exports: Knip's own fixer rewrites the export keywords (fresh, so exports freed by step 1 go too)
  if (exportCount || done.files.length) {
    start('removing dead exports');
    const knip = path.join(path.dirname(createRequire(import.meta.url).resolve('knip')), '..', 'bin', 'knip.js');
    const ok = await batch(['exports'], () => exec(process.execPath, [knip, '--fix', '--fix-type', 'exports,types', '--no-progress', '--no-exit-code'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(() => {}), { one: () => 'dead exports' });
    if (ok.length && (await git('status', '--porcelain', '--untracked-files=no'))) {
      await git('add', '-A');
      await commit('zomb fix: remove unused exports');
      done.exports = true;
      finish('removed dead exports');
    } else finish(dim('no dead exports to remove'));
  }

  // ── 3. unused packages
  if (packages.length) {
    const remove = { npm: ['uninstall'], pnpm: ['remove'], yarn: ['remove'], bun: ['remove'] }[pm];
    start(`uninstalling ${plural(packages.length, 'package')}`);
    const ok = await batch(packages, (list) => exec(pm, [...remove, ...list], { cwd: root, maxBuffer: 64 * 1024 * 1024 }), { reinstall: true });
    if (ok.length) {
      await git('add', '-A');
      await commit(`zomb fix: uninstall ${plural(ok.length, 'unused package')}\n\n${ok.join(', ')}`);
      done.packages = ok;
      finish(`uninstalled ${plural(ok.length, 'package')}  ${dim(clip(ok.join(' · '), W - 40))}`);
    } else finish(dim('uninstalled nothing: the checks need them'), yellow('☒'));
  }

  // ── summary
  log('');
  const kepts = kept.map((k) => row(`${yellow('kept')} ${k.item}`, dim(`${k.why}, so it isn't dead`), 3));
  if (!done.files.length && !done.exports && !done.packages.length) {
    await git('switch', '-q', original);
    await git('branch', '-q', '-D', branch);
    kepts.forEach((l) => log(l));
    log(` ${yellow('!')} ${dim('Nothing could be removed safely; deleted the empty branch.')}\n`);
    return 0;
  }
  log(row(`${green('✓')} ${bold('Cleaned')} ${dim('on')} ${branch}`, green(`−${n(done.lines)} lines`), 1));
  log(`   ${[plural(done.files.length, 'file'), ...(done.exports ? ['dead exports'] : []), plural(done.packages.length, 'package'), `${n(kept.length)} kept`].join(dim(' · '))}`);
  kepts.forEach((l) => log(l));
  log('');
  log(`   ${dim('review')}  ${green(`git diff ${original}...${branch}`)}`);
  log(`   ${dim('keep  ')}  ${green(`git switch ${original} && git merge ${branch}`)}`);
  log(`   ${dim('drop  ')}  ${green(`git switch ${original} && git branch -D ${branch}`)}\n`);
  return 0;
}
