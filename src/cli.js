#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isAgent, parseBlame, testsOnly, isTest, growth, versionSprawl, overlaps, sameNames, cycles, sharedFolders, namingStyles } from './score.js';
import { parseAll, dependents, touches, clones, orphanRoutes } from './signals.js';
import { scanRepo, npmAudit, openRoute, hasAuthSignal, securityFindings } from './security.js';
import { renderReport } from './report.js';
import { toTasks, fingerprint, toMarkdown } from './tasks.js';
import { changesSince, scopeTo, shortcuts } from './diff.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'zomb-report.html' },
    json: { type: 'boolean', default: false },
    markdown: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    since: { type: 'string' },
    'fail-on': { type: 'string' },
    'save-baseline': { type: 'boolean', default: false },
  },
});
const LEVELS = { high: ['high'], medium: ['high', 'medium'], low: ['high', 'medium', 'low'] };
const exec = promisify(execFile);
const sh = (cmd, args, cwd) => exec(cmd, args, { cwd, maxBuffer: 512 * 1024 * 1024 }).then((r) => r.stdout);
const CODE = /\.[cm]?[jt]sx?$/;

const log = (msg) => process.stderr.write(`zomb: ${msg}\n`);
const target = path.resolve(positionals[0] || '.');
const fail = (msg) => (log(msg), process.exit(1));
if (!existsSync(target)) fail(`${target} does not exist`);
if (opts['fail-on'] && !LEVELS[opts['fail-on']]) fail(`--fail-on takes high, medium or low, not "${opts['fail-on']}"`);
const root = (await sh('git', ['rev-parse', '--show-toplevel'], target).catch(() => fail(`${target} is not inside a git repo`))).trim();

async function knip() {
  const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('knip')), '..', 'bin', 'knip.js');
  try {
    return JSON.parse(await sh(process.execPath, [bin, '--reporter', 'json', '--no-exit-code', '--no-progress'], root));
  } catch (e) {
    // A config Knip can't load (vitest.config.ts without vitest installed) hides entry points, so its partial output lies.
    const why = `${e.stderr || e.message}`.split('\n').find((l) => l.startsWith('ERROR')) || e.message.split('\n')[0];
    const hint = existsSync(path.join(root, 'node_modules')) ? '' : ' Run npm install in the repo first: Knip needs dependencies to read config files.';
    const error = `${why.replace(/^ERROR:\s*/, '')}.${hint}`;
    log(`Knip failed, so zombie detection is skipped: ${error}`);
    return { issues: [], error };
  }
}

// One pass over history -> agentOf: sha -> agent name (null = human), history: [{ sha, date, files:[{ path, added, deleted }] }]
async function commits() {
  const out = await sh('git', ['log', '--numstat', '--no-renames', '--format=%x1e%H%x00%aI%x00%an <%ae>%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)'], root);
  const agentOf = new Map();
  const history = [];
  for (const rec of out.split('\x1e')) {
    const [head, ...stat] = rec.split('\n');
    const [sha, date, author, trailers = ''] = head.split('\0');
    if (!sha) continue;
    const agent = [author, ...trailers.split('\x1f')].map((p) => p.trim()).find((p) => p && isAgent(p));
    agentOf.set(sha, agent ? agent.replace(/\s*(\(.*\))?\s*<.*$/, '') : null);
    const files = stat.map((l) => l.split('\t')).filter(([a, , p]) => p && CODE.test(p) && a !== '-').map(([a, d, p]) => ({ path: p, added: Number(a), deleted: Number(d) }));
    history.push({ sha, date, files });
  }
  return { agentOf, history };
}

// file -> { share, agents } of lines an agent last wrote (only for the few files we report as zombies)
async function authorship(files, agentOf) {
  const out = new Map();
  await Promise.all(
    files.map(async (file) => {
      const shas = parseBlame(await sh('git', ['blame', '--porcelain', '-w', '-M', '--', file], root).catch(() => ''));
      const agentLines = shas.filter((s) => agentOf.get(s));
      out.set(file, { share: shas.length ? agentLines.length / shas.length : 0, agents: [...new Set(agentLines.map((s) => agentOf.get(s)))] });
    }),
  );
  return out;
}

// Knip follows imports only; files started by path (action.yml, spawn(), package.json scripts) look unused to it.
async function referencedBy(file) {
  const needles = [path.basename(file), file.replace(/\.[^./]+$/, '').split('/').slice(-2).join('/')];
  const out = await sh('git', ['grep', '-l', '--untracked', '-F', ...needles.flatMap((n) => ['-e', n]), '--', '.', `:!${file}`], root).catch(() => '');
  return out.split('\n')[0] || null;
}

// what's on disk: committed files plus new ones that aren't gitignored (uncommitted work is still your code)
const all = [...new Set((await sh('git', ['ls-files', '--cached', '--others', '--exclude-standard'], root)).split('\n').filter(Boolean))];
const tracked = new Set((await sh('git', ['ls-files'], root)).split('\n').filter(Boolean));
const files = all.filter((f) => CODE.test(f) && !/\.d\.[cm]?ts$/.test(f));
if (!files.length) fail(`no JS/TS files tracked in ${root}`);
log(`scanning ${files.length} JS/TS files in ${root}`);

const middleware = files.find((f) => /(^|\/)middleware\.[cm]?[jt]s$/.test(f));
const [knipOut, { agentOf, history }, parsed, copies, orphans, scan, audit, middlewareSrc] = await Promise.all([
  knip(),
  commits(),
  parseAll(root, files),
  clones(root, files),
  orphanRoutes(root, files),
  scanRepo(root, all, tracked),
  npmAudit(root),
  middleware ? readFile(path.join(root, middleware), 'utf8') : '',
]);

// ---------- zombie code ----------
const knipOf = new Map(knipOut.issues.map((i) => [i.file, i]));
// Tools load dot-folders (.claude/, .github/), *.config.* files and test files by convention, so never call them unused.
const conventional = (f) => /(^|\/)\.[^/]+\/|\.config\.[cm]?[jt]s$/.test(f) || isTest(f);
const unused = new Set(files.filter((f) => knipOf.get(f)?.files?.length && !conventional(f)));
const refs = new Map(await Promise.all([...unused].map(async (f) => [f, await referencedBy(f)])));
// A file started by path (action.yml runs run.ts) is live, and so is everything it imports: settle that before calling anything test-only.
const live = new Set();
let onlyTests;
for (;;) {
  onlyTests = new Set([...testsOnly(parsed, live)].filter((f) => !unused.has(f) && !conventional(f)));
  for (const f of onlyTests) if (!refs.has(f)) refs.set(f, await referencedBy(f));
  const named = [...onlyTests].filter((f) => refs.get(f) && !live.has(f));
  if (!named.length) break;
  named.forEach((f) => live.add(f));
}
const zombieFiles = [...unused, ...onlyTests].filter((f) => !refs.get(f) && !live.has(f));
const byAgent = await authorship(zombieFiles, agentOf);
const zombies = zombieFiles
  .map((f) => ({ path: f, lines: parsed.get(f).lines, why: unused.has(f) ? 'Nothing imports or names it' : 'Only its own tests import it', ...byAgent.get(f) }))
  .sort((a, b) => b.lines - a.lines);
const unusedPackages = knipOut.issues.flatMap((i) => [...i.dependencies, ...i.devDependencies].map((d) => ({ name: d.name, file: i.file, dev: i.devDependencies.includes(d) })));
const deadExports = knipOut.issues
  .filter((i) => !unused.has(i.file) && i.exports.length + i.types.length)
  .map((i) => ({ file: i.file, names: [...i.exports, ...i.types].map((e) => e.name) }))
  .sort((a, b) => b.names.length - a.names.length);
const maybe = [...orphans].map(([file, url]) => ({ file, url, lines: parsed.get(file).lines }));

// ---------- security ----------
const touchesOf = touches(parsed);
// a middleware with an auth check may protect every route, so the per-route check would cry wolf
const middlewareAuth = middlewareSrc && hasAuthSignal(middlewareSrc);
const openRoutes = middlewareAuth ? [] : [...parsed].map(([file, p]) => ({ file, why: openRoute(p.route, touchesOf.get(file)) })).filter((r) => r.why && !isTest(r.file));
const dangerous = [...parsed].flatMap(([file, p]) => (isTest(file) ? [] : p.dangerous.map((d) => ({ file, ...d }))));
const security = securityFindings({ ...scan, dangerous, openRoutes, audit });

// ---------- sprawl ----------
const months = growth(history);
const recent = months.filter((m) => Date.now() - Date.parse(`${m.month}-01`) < 92 * 864e5);
const packages = new Map();
for (const [file, p] of parsed) if (!isTest(file)) for (const pkg of p.packages) packages.set(pkg, [...(packages.get(pkg) || []), file]);
const dupes = copies && copies.sort((x, y) => y.lines - x.lines);

// ---------- architecture ----------
const dependentsOf = dependents(parsed);
const loops = cycles(new Map([...parsed].map(([f, p]) => [f, p.runtime])));
const big = [...parsed]
  .filter(([f, p]) => p.lines >= 500 && !isTest(f))
  .map(([f, p]) => ({ file: f, lines: p.lines, dependents: dependentsOf.get(f) || 0 }))
  .sort((a, b) => b.lines - a.lines);
const deep = [...parsed].filter(([f, p]) => p.deep && !isTest(f)).map(([f, p]) => ({ file: f, count: p.deep })).sort((a, b) => b.count - a.count);

let data = {
  repo: path.basename(root),
  commit: (await sh('git', ['rev-parse', '--short', 'HEAD'], root)).trim(),
  date: new Date().toLocaleDateString('en-CA'),
  files: files.length,
  lines: [...parsed.values()].reduce((n, p) => n + p.lines, 0),
  knipError: knipOut.error,
  zombie: { files: zombies, packages: unusedPackages, exports: deadExports, maybe },
  security: { findings: security, audit, middlewareAuth: Boolean(middlewareAuth), middleware, inTests: scan.inTests },
  sprawl: { months, recent, dupes, names: sameNames(parsed), versions: versionSprawl(files), overlaps: overlaps(packages) },
  architecture: { cycles: loops, big, shared: sharedFolders(files), deep, naming: namingStyles(files) },
};
// --since: report only what this change touched, plus the shortcuts it took
if (opts.since) {
  const change = await changesSince(root, opts.since).catch((e) => fail(`can't diff against ${opts.since}: ${e.message.split('\n')[0]}`));
  data = { ...scopeTo(data, change), since: opts.since, shortcuts: shortcuts(change.diff, change.deleted) };
  log(`reporting only the ${change.changed.size} files changed since ${opts.since}`);
}
const tasks = toTasks(data);

// Baseline: the findings you already have. With one saved, only new findings fail --fail-on.
const baselinePath = path.join(root, '.zomb', 'baseline.json');
if (opts['save-baseline']) {
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify({ version: 1, commit: data.commit, saved: data.date, fingerprints: [...new Set(tasks.map(fingerprint))].sort() }, null, 2)}\n`);
  log(`saved ${tasks.length} current findings to .zomb/baseline.json: from now on only new ones fail --fail-on. Commit this file.`);
  process.exit(0);
}
const baseline = existsSync(baselinePath) ? new Set(JSON.parse(await readFile(baselinePath, 'utf8')).fingerprints) : null;
if (baseline) for (const t of tasks) t.new = !baseline.has(fingerprint(t));
const failing = opts['fail-on'] ? tasks.filter((t) => LEVELS[opts['fail-on']].includes(t.severity) && (!baseline || t.new)) : [];
const done = () => {
  if (failing.length) log(`${failing.length} ${baseline ? 'new ' : ''}finding${failing.length === 1 ? '' : 's'} at or above --fail-on ${opts['fail-on']}`);
  process.exit(failing.length ? 1 : 0);
};

// --json: the to-do list for an AI agent (or CI). No HTML, nothing else on stdout.
if (opts.json) {
  const z = data.zombie;
  const summary = {
    security: { high: tasks.filter((t) => t.area === 'security' && t.severity === 'high').length, medium: tasks.filter((t) => t.area === 'security' && t.severity === 'medium').length },
    shortcuts: data.shortcuts?.length || 0,
    zombie: { files: z.files.length, lines: z.files.reduce((s, f) => s + f.lines, 0), packages: z.packages.length, exports: z.exports.reduce((s, e) => s + e.names.length, 0) },
    architecture: { cycles: data.architecture.cycles.length, bigFiles: data.architecture.big.length },
  };
  console.log(JSON.stringify({ repo: data.repo, commit: data.commit, since: data.since || null, baseline: Boolean(baseline), failing: failing.length, summary, tasks }, null, 2));
  done();
}
// --markdown: a PR comment or CI summary
if (opts.markdown) {
  console.log(toMarkdown(tasks, { repo: data.repo, since: data.since, baseline }));
  done();
}

const out = path.resolve(opts.out);
await writeFile(out, renderReport(data));

// ---------- terminal summary ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, red, yellow, green] = [paint(1), paint(2), paint(31), paint(33), paint(32)];
const n = (x) => x.toLocaleString('en-US');
const plural = (k, word) => `${n(k)} ${word}${k === 1 ? '' : 's'}`;
const cap = opts.all ? Infinity : 5;
const rest = (list) => (list.length > cap ? [dim(`  …and ${n(list.length - cap)} more (see the report, or run with --all)`)] : []);
const section = (title, line) => console.log(`\n${bold(title)}  ${line}`);
const row = (s) => console.log(`  ${s}`);

const sec = data.security.findings;
const high = sec.filter((f) => f.severity === 'high').length;
section('SECURITY', sec.length ? `${red(`${high} high`)} · ${yellow(`${sec.length - high} medium`)}` : green('nothing found'));
for (const f of sec.slice(0, cap)) row(`${(f.severity === 'high' ? red : yellow)(f.severity.padEnd(6))}  ${f.title}  ${dim(f.where)}`);
for (const l of rest(sec)) console.log(l);
if (audit.skipped) row(dim(`vulnerable packages not checked: ${audit.skipped}`));

if (data.shortcuts) {
  const sc = data.shortcuts;
  const color = (sev) => (sev === 'high' ? red : sev === 'medium' ? yellow : dim);
  section('SHORTCUTS', sc.length ? `${plural(sc.length, 'place')} this change silences or skips a check` : green('none: no suppressions, skipped or deleted tests'));
  for (const c of sc.slice(0, cap)) row(`${color(c.severity)(c.severity.padEnd(6))}  ${c.kind}  ${dim(c.line ? `${c.file}:${c.line}` : c.file)}`);
  for (const l of rest(sc)) console.log(l);
}

const z = data.zombie;
const zLines = z.files.reduce((s, f) => s + f.lines, 0);
section('ZOMBIE CODE', knipOut.error ? yellow('skipped (Knip failed)') : `${bold(`${n(zLines)} lines`)} in ${plural(z.files.length, 'file')} · ${plural(z.packages.length, 'unused package')} · ${plural(z.exports.reduce((s, e) => s + e.names.length, 0), 'dead export')}`);
for (const f of z.files.slice(0, cap)) row(`${f.path}  ${dim(`${n(f.lines)} lines · ${f.why.toLowerCase()}${f.share >= 0.5 ? ` · ${Math.round(f.share * 100)}% by ${f.agents.join(', ')}` : ''}`)}`);
for (const l of rest(z.files)) console.log(l);
if (z.packages.length) row(`unused packages: ${z.packages.map((p) => p.name).join(', ')}`);
if (z.maybe.length) row(`maybe zombie: ${z.maybe.map((m) => m.url).join(', ')} ${dim('(nothing in the repo links to them)')}`);

const sp = data.sprawl;
const added = recent.reduce((s, m) => s + m.added, 0), deleted = recent.reduce((s, m) => s + m.deleted, 0);
section('SPRAWL', data.since ? dim(`in this change`) : added ? `last 3 months: ${n(added)} lines added, ${n(deleted)} deleted ${bold(`(${Math.round((deleted / added) * 100)} deleted per 100 added)`)}` : dim('no commits in the last 3 months'));
for (const o of sp.overlaps) row(`${o.libraries.length} ${o.job}: ${o.libraries.map((l) => `${l.name} ${dim(`(${l.files})`)}`).join(', ')}`);
for (const v of sp.versions.slice(0, cap)) row(`${v.path}  ${dim(v.original ? `next to ${v.original}` : v.files ? `versioned folder, ${plural(v.files, 'file')}` : 'versioned copy')}`);
for (const x of sp.names.slice(0, cap)) row(`${x.name}  ${dim(`defined in ${plural(x.files.length, 'file')}`)}`);
if (sp.dupes?.length) row(`${plural(sp.dupes.length, 'copy-pasted block')} ${dim(`(${n(sp.dupes.reduce((s, d) => s + d.lines, 0))} lines)`)}`);

const a = data.architecture;
section('ARCHITECTURE', [plural(a.cycles.length, 'import cycle'), `${plural(a.big.length, 'file')} over 500 lines`, a.shared.length > 1 && `shared code in ${a.shared.length} folders`, a.deep.length && `${plural(a.deep.length, 'file')} with ../../../ imports`].filter(Boolean).join(' · '));
for (const c of a.cycles.slice(0, cap)) row(`cycle: ${dim(c.slice(0, 4).join(' → '))}${c.length > 4 ? dim(` +${c.length - 4}`) : ''}`);
for (const b of a.big.slice(0, cap)) row(`${b.file}  ${dim(`${n(b.lines)} lines`)}`);

const safe = tasks.filter((t) => t.safe).length;
const fresh = baseline ? tasks.filter((t) => t.new).length : null;
console.log(`\n${bold(`${plural(tasks.length, 'task')}`)} ${dim(`(${n(safe)} safe to automate${fresh !== null ? `, ${n(fresh)} new since the baseline` : ''})`)} · report: ${out}`);
console.log(dim('Fix them with your agent: run /zomb-clean in Claude Code, or pipe `zomb --json` to any agent.'));
if (opts['fail-on']) console.log(failing.length ? red(`✗ ${plural(failing.length, 'finding')} at or above ${opts['fail-on']}${baseline ? ' (new since the baseline)' : ''}`) : green(`✓ nothing at or above ${opts['fail-on']}${baseline ? ' that is new since the baseline' : ''}`));
process.exit(failing.length ? 1 : 0);
