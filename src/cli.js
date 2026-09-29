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
import { render, spinner, ui, renderBlueprint } from './terminal.js';
import { infer, toRules, breaks, toYaml, readBlueprint, FILE as BLUEPRINT } from './blueprint.js';
import { fix } from './fix.js';
import { changesSince, scopeTo, shortcuts } from './diff.js';

const paint = (tty) => ui({ width: process.stdout.columns || 80, color: Boolean(tty) && !process.env.NO_COLOR });
const { dim, red, yellow, green, cyan } = paint(process.stderr.isTTY);
const log = (msg) => process.stderr.write(`${dim('zomb')} ${msg}\n`);
const fail = (msg) => (process.stderr.write(`${red('✗')} ${msg}\n`), process.exit(1));

let args;
try {
  args = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    markdown: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    since: { type: 'string' },
    'fail-on': { type: 'string' },
    'save-baseline': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-checks': { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
  },
  });
} catch (e) {
  fail(`${e.message.split('. ')[0]}  ${dim('(zomb --help)')}`);
}
const { values: opts, positionals } = args;
if (opts.help) {
  const { bold, dim, cyan, rule } = paint(process.stdout.isTTY);
  const cmd = (c, what) => `  ${cyan(c.padEnd(26))}${what}`;
  console.log(`
${bold('zomb')}  ${dim('a health check for codebases written with AI')}

${rule('COMMANDS')}
${cmd('zomb [path]', 'scan: security, zombie code, sprawl, architecture')}
${cmd('zomb fix [path]', 'delete dead code on a branch, gated by your build')}
${cmd('zomb blueprint [path]', 'infer the rules this code follows; --write saves them')}
${cmd('zomb guard', 'Claude Code hook: blocks bad edits as they happen')}

${rule('SCAN')}
${cmd('--all', 'every finding, not just the top 5')}
${cmd('--since <ref>', 'only what changed since a branch or commit')}
${cmd('--json', 'an ordered to-do list for an agent or CI')}
${cmd('--markdown', 'a pull request comment')}
${cmd('--out <file>', 'where to write the HTML report')}
${cmd('--save-baseline', 'accept today\'s findings; only new ones fail')}
${cmd('--fail-on <level>', 'exit 1 on new high, medium or low findings')}

${rule('FIX')}
${cmd('--dry-run', 'show the plan, change nothing')}
${cmd('--no-checks', 'skip the typecheck, lint, test and build gate')}
`);
  process.exit(0);
}
// `zomb fix [path]` does the safe clean-up, `zomb blueprint [path]` proposes rules; plain `zomb [path]` reports
const command = ['fix', 'blueprint'].includes(positionals[0]) ? positionals.shift() : 'scan';
const LEVELS = { high: ['high'], medium: ['high', 'medium'], low: ['high', 'medium', 'low'] };
const exec = promisify(execFile);
const sh = (cmd, args, cwd) => exec(cmd, args, { cwd, maxBuffer: 512 * 1024 * 1024 }).then((r) => r.stdout);
const CODE = /\.[cm]?[jt]sx?$/;
const OWN = [':!.zomb', ':!*zomb-report*.html'];
// ignore everything in .zomb/ except the baseline and blueprint, which are meant to be committed
const ZOMB_IGNORE = '*\n!baseline.json\n!blueprint.yml\n';

const target = path.resolve(positionals[0] || '.');
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
    process.stderr.write(`${yellow('!')} Knip failed, so zombie detection is skipped: ${error}\n`);
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
  // never count zomb's own report or baseline as a mention: they list the very files being judged
  const out = await sh('git', ['grep', '-l', '--untracked', '-F', ...needles.flatMap((n) => ['-e', n]), '--', '.', `:!${file}`, ...OWN], root).catch(() => '');
  return out.split('\n')[0] || null;
}

// what's on disk: committed files plus new ones that aren't gitignored (uncommitted work is still your code)
const all = [...new Set((await sh('git', ['ls-files', '--cached', '--others', '--exclude-standard'], root)).split('\n').filter(Boolean))];
const tracked = new Set((await sh('git', ['ls-files'], root)).split('\n').filter(Boolean));
const files = all.filter((f) => CODE.test(f) && !/\.d\.[cm]?ts$/.test(f));
if (!files.length) fail(`no JS/TS files tracked in ${root}`);
const spin = opts.json || opts.markdown ? { step() {}, stop() {} } : spinner(`scanning ${files.length} files`);
if (!process.stderr.isTTY) log(`scanning ${files.length} JS/TS files in ${root}`);
const track = (name, p) => p.then((v) => (spin.step(name), v));

const middleware = files.find((f) => /(^|\/)middleware\.[cm]?[jt]s$/.test(f));
const [knipOut, { agentOf, history }, parsed, copies, orphans, scan, audit, middlewareSrc] = await Promise.all([
  track('imports', knip()),
  track('history', commits()),
  track('code', parseAll(root, files)),
  track('copy-paste', clones(root, files)),
  track('routes', orphanRoutes(root, files)),
  track('secrets', scanRepo(root, all, tracked)),
  track('packages', npmAudit(root)),
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
spin.stop();
const byAgent = await authorship(zombieFiles, agentOf);
const zombies = zombieFiles
  .map((f) => {
    // a standalone script nothing references is probably run by hand (node scripts/seed.mjs): ask, don't delete
    const script = /(^|\/)(scripts?|bin|tools)\//.test(f) || (!f.includes('/') && /\.[cm]?js$/.test(f));
    const why = script ? 'A standalone script nothing references: maybe you run it by hand' : unused.has(f) ? 'Nothing imports or names it' : 'Only its own tests import it';
    return { path: f, lines: parsed.get(f).lines, why, script, committed: tracked.has(f), ...byAgent.get(f) };
  })
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
// ---------- blueprint: the rules you approved. It takes over the file-size check when it sets one.
let rules = null;
try {
  rules = readBlueprint(root);
} catch (e) {
  fail(`${BLUEPRINT} isn't valid YAML: ${e.message.split('\n')[0]}`);
}
const broken = rules ? [...parsed].filter(([f]) => !isTest(f)).flatMap(([file, p]) => breaks(rules, { file, packages: p.packages, deep: p.deep, route: middlewareAuth ? null : p.route, lines: p.lines }).map((b) => ({ file, ...b }))) : [];
const big = [...parsed]
  .filter(([f, p]) => p.lines >= 500 && !isTest(f) && !rules?.files?.maxLines)
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
  blueprint: rules && { broken },
};
// --since: report only what this change touched, plus the shortcuts it took
if (opts.since) {
  const change = await changesSince(root, opts.since).catch((e) => fail(`can't diff against ${opts.since}: ${e.message.split('\n')[0]}`));
  data = { ...scopeTo(data, change), since: opts.since, shortcuts: shortcuts(change.diff, change.deleted) };
  log(`reporting only the ${change.changed.size} files changed since ${opts.since}`);
}
const tasks = toTasks(data);

if (command === 'blueprint') {
  const proposal = infer(parsed, { middlewareAuth });
  const today = [...parsed].filter(([f]) => !isTest(f)).flatMap(([file, p]) => breaks(toRules(proposal), { file, packages: p.packages, deep: p.deep, route: middlewareAuth ? null : p.route, lines: p.lines }).map((b) => ({ file, ...b })));
  const target = path.join(root, BLUEPRINT);
  const exists = existsSync(target);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log(renderBlueprint(proposal, today, { repo: data.repo, width: process.stdout.columns || 80, color, exists, write: opts.write }));
  if (!opts.write) process.exit(0);
  if (exists) fail(`${BLUEPRINT} already exists. Edit it, or delete it and run zomb blueprint --write again.`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, toYaml(proposal, data.repo));
  await writeFile(path.join(root, '.zomb', '.gitignore'), ZOMB_IGNORE);
  process.exit(0);
}
if (command === 'fix') process.exit(await fix({ root, data, dryRun: opts['dry-run'], noChecks: opts['no-checks'], color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, width: process.stdout.columns || 80 }));

// Baseline: the findings you already have. With one saved, only new findings fail --fail-on.
const baselinePath = path.join(root, '.zomb', 'baseline.json');
if (opts['save-baseline']) {
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify({ version: 1, commit: data.commit, saved: data.date, fingerprints: [...new Set(tasks.map(fingerprint))].sort() }, null, 2)}\n`);
  process.stderr.write(`${green('✓')} saved ${tasks.length} current findings to ${cyan('.zomb/baseline.json')}\n  ${dim('From now on only new ones fail --fail-on. Commit this file.')}\n`);
  process.exit(0);
}
const baseline = existsSync(baselinePath) ? new Set(JSON.parse(await readFile(baselinePath, 'utf8')).fingerprints) : null;
if (baseline) for (const t of tasks) t.new = !baseline.has(fingerprint(t));
const failing = opts['fail-on'] ? tasks.filter((t) => LEVELS[opts['fail-on']].includes(t.severity) && (!baseline || t.new)) : [];
const done = () => {
  if (failing.length) process.stderr.write(`${red('✗')} ${failing.length} ${baseline ? 'new ' : ''}finding${failing.length === 1 ? '' : 's'} at or above --fail-on ${opts['fail-on']}\n`);
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

// The report goes in .zomb/ (ignored by git) unless --out says otherwise; the baseline next to it is meant to be committed.
const out = opts.out ? path.resolve(opts.out) : path.join(root, '.zomb', 'report.html');
await mkdir(path.dirname(out), { recursive: true });
const ignore = path.join(root, '.zomb', '.gitignore');
if (!opts.out && (!existsSync(ignore) || (await readFile(ignore, 'utf8')) !== ZOMB_IGNORE)) await writeFile(ignore, ZOMB_IGNORE);
await writeFile(out, renderReport(data));

// ---------- terminal summary ----------
const lines = render(data, tasks, {
  width: process.stdout.columns || 80,
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  all: opts.all,
  audit,
  knipError: knipOut.error,
  recent,
  out: path.relative(process.cwd(), out) || out,
  failing,
  failOn: opts['fail-on'],
  baseline,
});
console.log(`\n${lines.join('\n')}\n`);
process.exit(failing.length ? 1 : 0);
