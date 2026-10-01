#!/usr/bin/env node
// The State of AI Code: which coding agent leaves the most mess behind?
// Finds public JS/TS repos with agent-written commits, measures every commit in them (agents and the humans
// working in the same repos), and compares agents per 1,000 lines they added.
//
//   node research/state-of-ai-code.js find [--per-agent 60]   GitHub commit search -> research/data/repos.json
//   node research/state-of-ai-code.js measure [--jobs 4]      clone, measure, delete (resumable) -> research/data/repos/
//   node research/state-of-ai-code.js summary                 per-agent rates -> research/data/summary.json
//
// Secrets are only counted, never stored. Needs the gh CLI, logged in.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { isAgent, isTest, isEntry, originalOf, parseBlame } from '../src/score.ts';
import { lineShortcuts } from '../src/diff.ts';
import { findSecrets } from '../src/security.ts';
import { parseAll } from '../src/signals.ts';

const DATA = path.join(import.meta.dirname, 'data');
const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CODE = /\.[cm]?[jt]sx?$/;
// build output, vendored and generated code: nobody wrote it by hand
const SKIP = /(^|\/)(node_modules|dist|build|out|vendor|\.next|\.nuxt|coverage|generated|__generated__)\/|\.min\.[cm]?js$|\.d\.[cm]?ts$/;
const DEPTH = 400;
// every author is judged on the same 12 months: older code has had longer to go dead
const SINCE = '2025-10-01';

// ---------- who wrote a commit
const NAMES: [string, RegExp][] = [['Claude', /anthropic|claude/i], ['Cursor', /cursor/i], ['Copilot', /copilot/i], ['Codex', /openai|codex/i], ['Devin', /devin/i], ['Jules', /jules/i], ['Aider', /aider/i], ['Gemini', /gemini/i]];
export const agentOf = (people: (string | undefined)[]): string => {
  const p = people.find((x) => x && isAgent(x.trim()));
  return p ? NAMES.find(([, re]) => re.test(p))?.[0] || 'Other agent' : 'Human';
};

// ---------- find: repos per agent from GitHub commit search, paced to stay under its limits
const QUERIES: Record<string, string[]> = {
  Claude: ['"noreply@anthropic.com"'],
  Cursor: ['"cursoragent@cursor.com"'],
  Copilot: ['author:copilot-swe-agent[bot]'],
  Devin: ['author:devin-ai-integration[bot]'],
  Jules: ['author:google-labs-jules[bot]'],
  Codex: ['"noreply@openai.com"'],
};
async function gh(args: string[], { tries = 6 } = {}): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse((await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout);
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      if (i >= tries || !/rate limit|403|429|502|timeout/i.test(`${err.stderr}${err.message}`)) throw e;
      process.stderr.write(`  rate limited, waiting ${30 * (i + 1)}s\n`);
      await sleep(30_000 * (i + 1));
    }
  }
}
async function find(perAgent: number) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 8 - i, 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return `${d.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
  });
  const found: Record<string, string[]> = {};
  for (const [agent, queries] of Object.entries(QUERIES)) {
    const repos = new Set<string>();
    for (const q of queries)
      for (const month of months) {
        if (repos.size >= perAgent * 3) break;
        const res = await gh(['api', '-X', 'GET', 'search/commits', '-f', `q=${q} committer-date:${month}`, '-f', 'per_page=100']).catch((e) => (process.stderr.write(`  ${agent} ${month}: ${e.message.split('\n')[0]}\n`), { items: [] }));
        for (const item of res.items || []) if (!item.repository.fork && !item.repository.private) repos.add(item.repository.full_name);
        process.stderr.write(`${agent} ${month}: ${repos.size} repos\n`);
        await sleep(8000);
      }
    found[agent] = [...repos];
  }
  // keep JS/TS repos under 300 MB, the most-starred first; GraphQL checks 40 at a time
  const all = [...new Set(Object.values(found).flat())];
  const meta = new Map<string, { stars: number; kb: number; language?: string }>();
  for (let i = 0; i < all.length; i += 40) {
    const batch = all.slice(i, i + 40);
    const query = `{ ${batch.map((r, j) => { const [o, n] = r.split('/'); return `r${j}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { nameWithOwner stargazerCount diskUsage primaryLanguage { name } }`; }).join(' ')} }`;
    const res = await gh(['api', 'graphql', '-f', `query=${query}`]).catch((e) => e.stdout ? JSON.parse(e.stdout) : { data: {} });
    for (const r of Object.values((res.data || {}) as Record<string, any>)) if (r) meta.set(r.nameWithOwner.toLowerCase(), { stars: r.stargazerCount, kb: r.diskUsage, language: r.primaryLanguage?.name });
    await sleep(1000);
  }
  const keep = (r: string) => { const m = meta.get(r.toLowerCase()); return Boolean(m && ['TypeScript', 'JavaScript'].includes(m.language || '') && m.kb < 300_000); };
  const out: Record<string, { repo: string }[]> = {};
  for (const [agent, repos] of Object.entries(found)) out[agent] = repos.filter(keep).sort((a, b) => meta.get(b.toLowerCase())!.stars - meta.get(a.toLowerCase())!.stars).slice(0, perAgent).map((r) => ({ repo: r, ...meta.get(r.toLowerCase()) }));
  await mkdir(DATA, { recursive: true });
  await writeFile(path.join(DATA, 'repos.json'), `${JSON.stringify(out, null, 2)}\n`);
  for (const [agent, repos] of Object.entries(out)) console.log(`${agent.padEnd(8)} ${repos.length} repos (of ${found[agent].length} found)`);
}

// ---------- measure one repo
const bucket = () => ({ commits: 0, added: 0, deleted: 0, filesAdded: 0, filesDeleted: 0, testsDeleted: 0, shortcuts: {} as Record<string, number>, secrets: 0, versioned: 0, deadLines: 0 as number | null, sizes: [] as number[] });

// Every non-merge commit in the last DEPTH: lines added and deleted, and what the added lines do. Streams: some logs are big.
export async function history(dir: string, skip: Set<string> = new Set(), since = '') {
  const args = ['log', '--no-merges', '--no-renames', '-U0', '--no-color', '--no-ext-diff', '--format=%x1e%H%x00%P%x00%aI%x00%an <%ae>%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)', '-p', '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts'];
  const git = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  type File = { path: string | null; isNew: boolean; gone: boolean; hunk: boolean; added: number; deleted: number; shortcuts: Record<string, number>; secrets: number };
  const commits: { sha: string; date: string; agent: string; counted: boolean; files: File[] }[] = [];
  let c: (typeof commits)[number] | null = null;
  let f: File | null = null;
  for await (const line of readline.createInterface({ input: git.stdout, crlfDelay: Infinity })) {
    if (line.startsWith('\x1e')) {
      const [sha, parents, date, author, trailers = ''] = line.slice(1).split('\x00');
      // a root or shallow-boundary commit "adds" the whole repo: it isn't anyone's work in this window
      c = { sha, date, agent: agentOf([author, ...trailers.split('\x1f')]), counted: Boolean(parents) && !skip.has(sha) && date >= since, files: [] };
      commits.push(c);
      f = null;
    } else if (!c) continue;
    else if (line.startsWith('diff --git ')) c.files.push((f = { path: null, isNew: false, gone: false, hunk: false, added: 0, deleted: 0, shortcuts: {}, secrets: 0 }));
    else if (!f) continue;
    else if (!f.hunk && line.startsWith('--- ')) line === '--- /dev/null' ? (f.isNew = true) : (f.path = line.slice(6));
    else if (!f.hunk && line.startsWith('+++ ')) line === '+++ /dev/null' ? (f.gone = true) : (f.path = line.slice(6));
    else if (line.startsWith('@@')) f.hunk = true;
    else if (line.startsWith('+')) {
      f.added++;
      if (f.added > 3000 || !f.path) continue; // generated; dropped below
      const text = line.slice(1);
      if (text.length > 1000) continue; // minified
      for (const s of lineShortcuts(text, f.path)) f.shortcuts[s.kind] = (f.shortcuts[s.kind] || 0) + 1;
      if (!isTest(f.path)) f.secrets += findSecrets(text).length;
    } else if (line.startsWith('-')) f.deleted++;
  }
  for (const x of commits) x.files = x.files.filter((file) => file.path && file.added <= 3000 && !SKIP.test(file.path));
  return commits.reverse(); // oldest first
}

// Files nothing imports and nothing names: a conservative take on dead code (no framework or config knowledge).
// Folders frameworks and tools load by path or by a name built at runtime (templates, migrations, serverless functions, Nuxt auto-imports)
const LOADED_BY_PATH = /(^|\/)\.[^/]+\/|\.config\.[cm]?[jt]s$|(^|\/)(app|routes|pages|scripts?|bin|tools|examples?|docs?|e2e|stories|public|static|templates?|extras|fixtures?|__fixtures__|seeds?|migrations?|functions|theme|plugins?|composables|middleware)\/|^api\/|\.(stories|story|mock)\.[jt]sx?$/;
async function deadFiles(dir: string, files: string[]) {
  const parsed = await parseAll(dir, files);
  const importers = new Map<string, number>();
  for (const p of parsed.values()) for (const d of p.imports) importers.set(d, (importers.get(d) || 0) + 1);
  const dead: { file: string; lines: number }[] = [];
  for (const f of files) {
    if (importers.get(f) || isTest(f) || isEntry(f) || !f.includes('/') || LOADED_BY_PATH.test(f)) continue;
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    // its file name, its compiled name, or a path ending in it inside quotes (require('./x'), import(`../x`))
    const needles = [path.basename(f), `${stem}.js`, f.replace(/\.[^./]+$/, '').split('/').slice(-2).join('/'), ...['"', "'", '`'].map((q) => `/${stem}${q}`)];
    const named = await exec('git', ['grep', '-l', '-F', ...needles.flatMap((n) => ['-e', n]), '--', '.', `:!${f}`], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim(), () => '');
    if (!named) dead.push({ file: f, lines: parsed.get(f)!.lines });
  }
  return dead;
}

async function measure({ repo, stars }: { repo: string; stars?: number }) {
  // realpath: macOS's tmpdir is a symlink, and resolved imports must stay inside the repo path
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'soac-')));
  const git = (...args: string[]) => exec('git', args, { cwd: dir, maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);
  try {
    await exec('git', ['clone', '--quiet', '--single-branch', '--no-tags', `--depth=${DEPTH}`, `https://github.com/${repo}.git`, dir], { timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const shallow = new Set((existsSync(path.join(dir, '.git', 'shallow')) ? await readFile(path.join(dir, '.git', 'shallow'), 'utf8') : '').split('\n').filter(Boolean));
    const commits = await history(dir, shallow, SINCE);
    const agents: Record<string, ReturnType<typeof bucket>> = {};
    const of = (name: string) => (agents[name] ||= bucket());
    const agentBySha = new Map<string, string>();
    // files that existed before each commit, to spot new "V2" copies of them
    const oldest = commits[0]?.sha;
    const seen = new Set(oldest ? (await git('ls-tree', '-r', '--name-only', oldest).catch(() => '')).split('\n') : []);
    for (const c of commits) {
      const added = c.files.reduce((s, f) => s + f.added, 0);
      if (c.counted && added <= 20_000) {
        agentBySha.set(c.sha, c.agent);
        const b = of(c.agent);
        b.commits++;
        b.added += added;
        b.deleted += c.files.reduce((s, f) => s + f.deleted, 0);
        b.sizes.push(added);
        for (const f of c.files) {
          if (f.isNew) b.filesAdded++;
          if (f.gone) b.filesDeleted++;
          if (f.gone && isTest(f.path || '')) b.testsDeleted++;
          for (const [k, n] of Object.entries(f.shortcuts)) b.shortcuts[k] = (b.shortcuts[k] || 0) + n;
          b.secrets += f.secrets;
          const original = f.isNew && f.path && !isTest(f.path) && originalOf(f.path);
          if (original && seen.has(original)) b.versioned++;
        }
      }
      for (const f of c.files) if (f.path) seen.add(f.path);
    }
    // dead code today, and who wrote it (only lines from commits counted above)
    const files = (await git('ls-files')).split('\n').filter((f) => CODE.test(f) && !SKIP.test(f));
    // auto-import frameworks use files without importing them: dead code can't be judged there
    const pkg = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '');
    const judged = files.length <= 6000 && !/"(nuxt|unplugin-auto-import|@nuxt\/[^"]+)"\s*:/.test(pkg);
    const dead = judged ? await deadFiles(dir, files) : [];
    // files over 3,000 lines don't count as anyone's added lines (generated), so they don't count as dead lines either
    for (const d of dead.filter((x) => x.lines <= 3000)) for (const sha of parseBlame(await git('blame', '--porcelain', '-w', '--', d.file).catch(() => ''))) if (agentBySha.has(sha)) of(agentBySha.get(sha)!).deadLines!++;
    for (const b of Object.values(agents)) b.sizes = b.sizes.sort((x, y) => x - y);
    if (!judged) for (const b of Object.values(agents)) b.deadLines = null;
    return { repo, stars, files: files.length, deadFiles: judged ? dead.length : null, commits: commits.length, agents };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function measureAll(jobs: number) {
  const list = JSON.parse(await readFile(path.join(DATA, 'repos.json'), 'utf8'));
  const repos = [...new Map((Object.values(list).flat() as { repo: string }[]).map((r) => [r.repo.toLowerCase(), r])).values()];
  await mkdir(path.join(DATA, 'repos'), { recursive: true });
  const outOf = (r: { repo: string }) => path.join(DATA, 'repos', `${r.repo.replace('/', '__')}.json`);
  const todo = repos.filter((r) => !existsSync(outOf(r)));
  let done = repos.length - todo.length;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let r; (r = todo.shift()); ) {
        const t = Date.now();
        const result: any = await measure(r).catch((e: Error) => ({ repo: r.repo, error: e.message.split('\n')[0] }));
        await writeFile(outOf(r), `${JSON.stringify(result)}\n`);
        process.stderr.write(`[${++done}/${repos.length}] ${r.repo} ${result.error ? `failed: ${result.error}` : `${result.commits} commits, ${Object.keys(result.agents).join(' ')}`} (${Math.round((Date.now() - t) / 1000)}s)\n`);
      }
    }),
  );
}

// ---------- summary: rates per author, how sure we can be of them, and each agent against the humans in its own repos
const METRICS: Record<string, [(b: any) => number, (b: any) => number, number]> = {
  shortcutsPer1k: [(b) => Object.values(b.shortcuts as Record<string, number>).reduce((s, n) => s + n, 0), (b) => b.added, 1000],
  deletedPer100: [(b) => b.deleted, (b) => b.added, 100],
  deadPer1k: [(b) => b.deadLines ?? 0, (b) => (b.deadLines === null ? 0 : b.added), 1000],
  versionedPer100Commits: [(b) => b.versioned, (b) => b.commits, 100],
  secretsPer1M: [(b) => b.secrets, (b) => b.added, 1e6],
};
const round = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
// the rate over a set of repos, each repo's lines pooled
const rate = (repos: any[], name: string, [num, den, scale]: [(b: any) => number, (b: any) => number, number]) => {
  let n = 0, d = 0;
  for (const r of repos) if (r.agents[name]) (n += num(r.agents[name])), (d += den(r.agents[name]));
  return d ? (n / d) * scale : null;
};
// 90% bootstrap range over repos: which repos happened to be sampled matters more than any single commit
function bootstrap(repos: any[], stat: (rs: any[]) => number | null, runs = 1000) {
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const values: number[] = [];
  for (let i = 0; i < runs; i++) {
    const v = stat(repos.map(() => repos[Math.floor(random() * repos.length)]));
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  return values.length ? [round(values[Math.floor(values.length * 0.05)]), round(values[Math.floor(values.length * 0.95)])] : [null, null];
}

async function summary() {
  const dir = path.join(DATA, 'repos');
  const results = (await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))))).filter((r) => !r.error);
  const names = [...new Set(results.flatMap((r) => Object.keys(r.agents)))];
  const agents = names
    .map((name) => {
      const inRepos = results.filter((r) => r.agents[name]?.commits);
      const sum = (k) => inRepos.reduce((s, r) => s + r.agents[name][k], 0);
      // agent vs humans, only in repos where both wrote 300+ lines
      const paired = name === 'Human' ? [] : inRepos.filter((r) => r.agents[name].added >= 300 && r.agents.Human?.added >= 300);
      const metrics = Object.fromEntries(
        Object.entries(METRICS).map(([key, m]) => {
          const judged = key === 'deadPer1k' ? inRepos.filter((r) => r.agents[name].deadLines !== null) : inRepos;
          const pairedJudged = key === 'deadPer1k' ? paired.filter((r) => r.agents[name].deadLines !== null) : paired;
          const out: { value: number | null; range: (number | null)[]; vsHumans?: { repos: number; agent: number | null; human: number | null; ratioRange: (number | null)[] } } = { value: round(rate(judged, name, m)), range: bootstrap(judged, (rs) => rate(rs, name, m)) };
          if (pairedJudged.length >= 5)
            out.vsHumans = {
              repos: pairedJudged.length,
              agent: round(rate(pairedJudged, name, m)),
              human: round(rate(pairedJudged, 'Human', m)),
              ratioRange: bootstrap(pairedJudged, (rs) => rate(rs, name, m)! / rate(rs, 'Human', m)!),
            };
          return [key, out];
        }),
      );
      const kinds: Record<string, number> = {};
      for (const r of inRepos) for (const [k, n] of Object.entries(r.agents[name].shortcuts) as [string, number][]) kinds[k] = (kinds[k] || 0) + n;
      const sizes = inRepos.flatMap((r) => r.agents[name].sizes).sort((a, b) => a - b);
      return {
        name,
        repos: inRepos.length,
        commits: sum('commits'),
        added: sum('added'),
        deleted: sum('deleted'),
        medianCommit: sizes.length ? sizes[Math.floor(sizes.length / 2)] : null,
        secrets: sum('secrets'),
        metrics,
        shortcuts: Object.fromEntries((Object.entries(kinds) as [string, number][]).map(([k, n]): [string, number] => [k, round((n / sum('added')) * 1000) || 0]).sort((a, b) => b[1] - a[1])),
      };
    })
    .filter((a) => a.repos >= 5 && a.added >= 5000)
    .sort((a, b) => b.added - a.added);
  const out = { generated: new Date().toISOString(), since: SINCE, depth: DEPTH, repos: results.length, commits: agents.reduce((s, a) => s + a.commits, 0), lines: agents.reduce((s, a) => s + a.added, 0), agents };
  await writeFile(path.join(DATA, 'summary.json'), `${JSON.stringify(out, null, 2)}\n`);
  const show = (m: any) => (m.value === null ? '–' : `${m.value} [${m.range.join('–')}]`);
  const vs = (m: any) => (m.vsHumans ? `${m.vsHumans.agent} vs ${m.vsHumans.human} (${m.vsHumans.repos}) ×[${m.vsHumans.ratioRange.join('–')}]` : '');
  console.table(agents.map((a) => ({ name: a.name, repos: a.repos, commits: a.commits, added: a.added, median: a.medianCommit, shortcuts: show(a.metrics.shortcutsPer1k), 'shortcuts vs humans': vs(a.metrics.shortcutsPer1k), deleted: show(a.metrics.deletedPer100), 'deleted vs humans': vs(a.metrics.deletedPer100), dead: show(a.metrics.deadPer1k), 'dead vs humans': vs(a.metrics.deadPer1k) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'per-agent': { type: 'string', default: '60' }, jobs: { type: 'string', default: '4' } } });
  const step = positionals[0];
  if (step === 'find') await find(Number(values['per-agent']));
  else if (step === 'measure') await measureAll(Number(values.jobs));
  else if (step === 'summary') await summary();
  else console.log('usage: node research/state-of-ai-code.js find | measure | summary');
}
