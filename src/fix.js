// zomb fix: do the safe clean-up for you, on a branch, proving every step with the project's own checks.
// No AI: deleting dead files, removing dead exports and uninstalling unused packages are mechanical.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CHECK_TIMEOUT = 15 * 60 * 1000;

// Which package manager the repo uses, from its lockfile.
export function packageManager(root) {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

// The project's own checks, from its package.json scripts, cheapest first.
export function findChecks(scripts = {}, pm = 'npm', { tsc = false } = {}) {
  const has = (name) => scripts[name] && !/no test specified/.test(scripts[name]);
  const run = (name, label) => ({ label, cmd: pm, args: pm === 'npm' ? ['run', '--silent', name] : ['run', name] });
  const checks = [];
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
export const isTooling = (name) =>
  /^(eslint|@eslint\/|eslint-(config|plugin)-|@typescript-eslint\/|typescript-eslint|prettier|@prettier\/|prettier-plugin-|stylelint|@commitlint\/|husky|lint-staged|@types\/|typescript$|postcss|autoprefixer|tailwindcss|@tailwindcss\/|babel-|@babel\/|@next\/eslint)/.test(name) || /(^|\/)(eslint|prettier|stylelint)-(config|plugin)/.test(name);

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export async function fix({ root, data, dryRun = false, noChecks = false, color = true, log = console.log }) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const [bold, dim, red, yellow, green, cyan] = [paint(1), paint(2), paint(31), paint(33), paint(32), paint(36)];
  const n = (x) => x.toLocaleString('en-US');
  const plural = (k, word) => `${n(k)} ${word}${k === 1 ? '' : 's'}`;
  const git = (...args) => exec('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());

  const z = data.zombie;
  const files = z.files.filter((f) => !f.script && f.committed);
  const exportCount = z.exports.reduce((s, e) => s + e.names.length, 0);
  const packages = z.packages.map((p) => p.name).filter((p) => !isTooling(p));
  const tooling = z.packages.map((p) => p.name).filter(isTooling);

  // ── the plan
  log(`\n${bold('zomb fix')}  ${dim(data.repo)}\n`);
  log(`  ${files.length ? '●' : dim('○')} delete ${plural(files.length, 'dead file')} ${dim(`(${n(files.reduce((s, f) => s + f.lines, 0))} lines)`)}`);
  log(`  ${exportCount ? '●' : dim('○')} remove ${plural(exportCount, 'dead export')}`);
  log(`  ${packages.length ? '●' : dim('○')} uninstall ${plural(packages.length, 'unused package')}${packages.length ? dim(`: ${packages.join(', ')}`) : ''}`);
  const scripts = z.files.filter((f) => f.script);
  const loose = z.files.filter((f) => !f.script && !f.committed);
  if (scripts.length) log(dim(`  left for you: ${plural(scripts.length, 'script')} you may run by hand (${scripts.map((f) => f.path).join(', ')})`));
  if (loose.length) log(dim(`  left for you: ${plural(loose.length, 'dead file')} not committed yet (${loose.map((f) => f.path).join(', ')})`));
  if (tooling.length) log(dim(`  left for you: ${plural(tooling.length, 'tooling package')} that configs may load by name (${tooling.join(', ')})`));
  if (!files.length && !exportCount && !packages.length) return log(green('\n  Nothing to clean up.\n')), 0;
  if (dryRun) return log(dim('\n  Dry run: nothing changed. Run without --dry-run to do it.\n')), 0;

  // ── safety first: never mix our changes into uncommitted work
  if (await git('status', '--porcelain', '--untracked-files=no')) {
    log(red('\n  You have uncommitted changes. Commit or stash them first: zomb fix commits its work on a new branch.\n'));
    return 1;
  }
  const pkg = existsSync(path.join(root, 'package.json')) ? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) : {};
  const pm = packageManager(root);
  const checks = findChecks(pkg.scripts, pm, { tsc: existsSync(path.join(root, 'tsconfig.json')) && existsSync(path.join(root, 'node_modules', '.bin', 'tsc')) });

  // CI=1 keeps test runners out of watch mode
  const runCheck = (c) =>
    exec(c.cmd, c.args, { cwd: root, timeout: CHECK_TIMEOUT, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, tail: `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-6).join('\n') }),
    );
  log(`\n${bold('Checks')} ${dim('(run once first; only ones that pass now are used to judge each change)')}`);
  const gates = [];
  for (const c of checks) {
    const r = await runCheck(c);
    log(`  ${r.ok ? green('✓') : yellow('✗')} ${c.label}${r.ok ? '' : dim('  already failing, ignored')}`);
    if (r.ok) gates.push(c);
  }
  if (!gates.length && !noChecks) {
    log(red(`\n  No passing typecheck, lint, test or build script to prove the changes safe.`));
    log(dim(`  Add one to package.json, or run zomb fix --no-checks and review the branch yourself.\n`));
    return 1;
  }
  const verify = async () => {
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
  log(`\n${bold('Working on')} ${cyan(branch)}`);

  const undo = async (reinstall) => {
    await git('reset', '-q', '--hard', 'HEAD'); // only our uncommitted batch: the tree was clean when we started
    if (reinstall) await exec(pm, ['install'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
  };
  const commit = (message) => git('commit', '-q', '-m', message, '-m', 'Made by zomb fix: every change passed the project checks before it was kept.');

  // Apply a batch, check it, keep it or undo it. On failure, retry the items one by one and keep the ones that pass.
  const done = { files: [], lines: 0, exports: false, packages: [] };
  const kept = [];
  async function batch(items, apply, { reinstall = false, one = (x) => x } = {}) {
    await apply(items);
    let r = gates.length ? await verify() : { ok: true };
    if (r.ok) return items;
    await undo(reinstall);
    if (items.length === 1) return kept.push({ item: one(items[0]), why: `${r.label} failed` }), [];
    const passed = [];
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
    const ok = await batch(group, (list) => git('rm', '-q', '--', ...list.map((f) => f.path)), { one: (f) => f.path });
    if (ok.length) {
      const lines = ok.reduce((s, f) => s + f.lines, 0);
      await commit(`zomb fix: delete ${plural(ok.length, 'unused file')} (${n(lines)} lines)`);
      done.files.push(...ok);
      done.lines += lines;
      log(`  ${green('✓')} deleted ${plural(ok.length, 'file')} ${dim(`(${n(lines)} lines)`)}`);
    }
  }

  // ── 2. dead exports: Knip's own fixer rewrites the export keywords (fresh, so exports freed by step 1 go too)
  if (exportCount || done.files.length) {
    const knip = path.join(path.dirname(createRequire(import.meta.url).resolve('knip')), '..', 'bin', 'knip.js');
    const ok = await batch(['exports'], () => exec(process.execPath, [knip, '--fix', '--fix-type', 'exports,types', '--no-progress', '--no-exit-code'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(() => {}), { one: () => 'dead exports' });
    if (ok.length && (await git('status', '--porcelain', '--untracked-files=no'))) {
      await git('add', '-A');
      await commit('zomb fix: remove unused exports');
      done.exports = true;
      log(`  ${green('✓')} removed dead exports`);
    }
  }

  // ── 3. unused packages
  if (packages.length) {
    const remove = { npm: ['uninstall'], pnpm: ['remove'], yarn: ['remove'], bun: ['remove'] }[pm];
    const ok = await batch(packages, (list) => exec(pm, [...remove, ...list], { cwd: root, maxBuffer: 64 * 1024 * 1024 }), { reinstall: true });
    if (ok.length) {
      await git('add', '-A');
      await commit(`zomb fix: uninstall ${plural(ok.length, 'unused package')}\n\n${ok.join(', ')}`);
      done.packages = ok;
      log(`  ${green('✓')} uninstalled ${ok.join(', ')}`);
    }
  }

  // ── summary
  log(`\n${bold('Done')}  ${green(`−${n(done.lines)} lines`)} · ${plural(done.files.length, 'file')} deleted · ${done.exports ? 'dead exports removed · ' : ''}${plural(done.packages.length, 'package')} uninstalled`);
  for (const k of kept) log(`  ${yellow('kept')} ${k.item} ${dim(`(${k.why}, so it isn't dead after all)`)}`);
  if (!done.files.length && !done.exports && !done.packages.length) {
    await git('switch', '-q', original);
    await git('branch', '-q', '-D', branch);
    log(dim(`  Nothing could be removed safely; deleted the empty branch.\n`));
    return 0;
  }
  log(`\n  Review:  ${cyan(`git diff ${original}...${branch}`)}`);
  log(`  Keep it: ${cyan(`git switch ${original} && git merge ${branch}`)}`);
  log(`  Drop it: ${cyan(`git switch ${original} && git branch -D ${branch}`)}\n`);
  return 0;
}
