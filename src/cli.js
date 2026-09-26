#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isAgent, parseBlame, classifyPR, scoreFile, rollup, churn, timeline, readingPlan, sameNames } from './score.js';
import { parseAll, dependents, touches, clones } from './signals.js';
import { renderReport } from './report.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string', default: 'zomb-report.html' }, 'no-github': { type: 'boolean', default: false } },
});
const exec = promisify(execFile);
const sh = (cmd, args, cwd) => exec(cmd, args, { cwd, maxBuffer: 512 * 1024 * 1024 }).then((r) => r.stdout);
const CODE = /\.[cm]?[jt]sx?$/;

const root = (await sh('git', ['rev-parse', '--show-toplevel'], path.resolve(positionals[0] || '.'))).trim();
const log = (msg) => process.stderr.write(`zomb: ${msg}\n`);

async function knip() {
  const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('knip')), '..', 'bin', 'knip.js');
  try {
    return JSON.parse(await sh(process.execPath, [bin, '--reporter', 'json', '--no-exit-code', '--no-progress'], root));
  } catch (e) {
    // A config Knip can't load (vitest.config.ts without vitest installed) hides entry points, so its partial output lies.
    const why = `${e.stderr || e.message}`.split('\n').find((l) => l.startsWith('ERROR')) || e.message.split('\n')[0];
    const hint = existsSync(path.join(root, 'node_modules')) ? '' : ' Run npm install in the repo first: Knip needs dependencies to read config files.';
    const error = `${why.replace(/^ERROR:\s*/, '')}.${hint}`;
    log(`Knip failed, so the "used" axis is skipped: ${error}`);
    return { issues: [], error };
  }
}

// One pass over history -> agentOf: sha -> agent name (null = human), history: [{ sha, date, subject, files:[{ path, added }] }]
async function commits() {
  const out = await sh('git', ['log', '--numstat', '--no-renames', '--format=%x1e%H%x00%aI%x00%s%x00%an <%ae>%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)'], root);
  const agentOf = new Map();
  const history = [];
  for (const rec of out.split('\x1e')) {
    const [head, ...stat] = rec.split('\n');
    const [sha, date, subject, author, trailers = ''] = head.split('\0');
    if (!sha) continue;
    const agent = [author, ...trailers.split('\x1f')].map((p) => p.trim()).find((p) => p && isAgent(p));
    agentOf.set(sha, agent ? agent.replace(/\s*(\(.*\))?\s*<.*$/, '') : null);
    const files = stat.map((l) => l.split('\t')).filter(([a, , p]) => p && CODE.test(p) && a !== '-').map(([a, , p]) => ({ path: p, added: Number(a) }));
    history.push({ sha, date, subject, files });
  }
  return { agentOf, history };
}

// ponytail: one blame process per file, 8 at a time; incremental blame cache if big repos get slow
async function blameAll(files, agentOf) {
  const result = new Map();
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const shas = parseBlame(await sh('git', ['blame', '--porcelain', '-w', '-M', '--', file], root).catch(() => ''));
      const agents = new Set(shas.map((s) => agentOf.get(s)).filter(Boolean));
      result.set(file, { lines: shas.length, agentLines: shas.filter((s) => agentOf.get(s)).length, agents, shas });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return result;
}

// path -> { number, state, lines, seconds } for the latest merged PR that touched it.
// ponytail: last 100 merged PRs (4 pages of 25); add octokit throttling before backfilling a year
async function reviews() {
  if (opts['no-github']) return new Map();
  const remote = await sh('git', ['remote', 'get-url', 'origin'], root).catch(() => '');
  const m = remote.trim().match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (await sh('gh', ['auth', 'token'], root).catch(() => '')).trim();
  if (!m || !token) {
    log('no GitHub remote or token, so review signals are skipped');
    return new Map();
  }
  // 25 PRs a page: 100 PRs x 100 files in one query times out on GitHub's side
  const query = `query($o:String!,$n:String!,$after:String){repository(owner:$o,name:$n){pullRequests(states:MERGED,first:25,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor} nodes{number mergedAt additions deletions author{login} commits(last:1){nodes{commit{committedDate}}} reviewThreads{totalCount}
    reviews(first:20){nodes{state submittedAt body author{login __typename}}} files(first:100){nodes{path}}}}}}`;
  const prs = [];
  let after = null;
  for (let page = 0; page < 4; page++) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { o: m[1], n: m[2], after } }),
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
      if (res.errors || !res.data?.repository) throw new Error(res.errors?.[0]?.message || 'no repository');
      const { nodes, pageInfo } = res.data.repository.pullRequests;
      prs.push(...nodes);
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    } catch (e) {
      log(`GitHub query failed after ${prs.length} PRs, using what we have (${e.message})`);
      break;
    }
  }
  const byPath = new Map();
  prs.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  for (const pr of prs) {
    const review = classifyPR({
      author: pr.author?.login,
      additions: pr.additions,
      deletions: pr.deletions,
      lastCommitAt: pr.commits.nodes[0]?.commit.committedDate,
      threads: pr.reviewThreads.totalCount,
      reviews: pr.reviews.nodes.map((r) => ({ state: r.state, at: r.submittedAt, body: r.body || '', author: r.author?.login, bot: r.author?.__typename === 'Bot' })),
    });
    for (const f of pr.files.nodes) byPath.set(f.path, { number: pr.number, ...review }); // later PRs overwrite earlier ones
  }
  return byPath;
}

// Knip follows imports only; files started by path (action.yml, spawn(), package.json scripts) look unused to it.
async function referencedBy(file) {
  const needles = [path.basename(file), file.replace(/\.[^./]+$/, '').split('/').slice(-2).join('/')];
  const out = await sh('git', ['grep', '-l', '-F', ...needles.flatMap((n) => ['-e', n]), '--', '.', `:!${file}`], root).catch(() => '');
  return out.split('\n')[0] || null;
}

const files = (await sh('git', ['ls-files'], root)).split('\n').filter((f) => CODE.test(f) && !/\.d\.[cm]?ts$/.test(f));
if (!files.length) {
  log(`no JS/TS files tracked in ${root}`);
  process.exit(1);
}
log(`scanning ${files.length} JS/TS files in ${root}`);

const [knipOut, { agentOf, history }, prOf, parsed, copies] = await Promise.all([knip(), commits(), reviews(), parseAll(root, files), clones(root, files)]);
const blame = await blameAll(files, agentOf);
const knipOf = new Map(knipOut.issues.map((i) => [i.file, i]));
const dependentsOf = dependents(parsed);
const touchesOf = touches(parsed);
const churnOf = churn(history);
// Tools load dot-folders (.claude/, .github/) and *.config.* files by convention, so never call them unused.
const conventional = (f) => /(^|\/)\.[^/]+\/|\.config\.[cm]?[jt]s$/.test(f);
const unused = files.filter((f) => knipOf.get(f)?.files?.length && !conventional(f));
const refs = new Map(await Promise.all(unused.map(async (f) => [f, await referencedBy(f)])));

const scored = files
  .map((file) => {
    const k = knipOf.get(file);
    return scoreFile({
      path: file,
      ...blame.get(file),
      unusedFile: unused.includes(file),
      unusedExports: (k?.exports?.length || 0) + (k?.types?.length || 0),
      referencedBy: refs.get(file) || null,
      pr: prOf.get(file) || null,
      dependents: dependentsOf.get(file) || 0,
      touches: touchesOf.get(file) || [],
      churn: churnOf.get(file),
    });
  })
  .filter((f) => f.lines);

// Who wrote each side of a copy-pasted block, from the blame lines in its range.
const byWhom = ({ file, start, end }) => {
  const shas = blame.get(file)?.shas.slice(start - 1, end) || [];
  const agents = [...new Set(shas.map((s) => agentOf.get(s)).filter(Boolean))];
  return shas.length && agents.length && shas.filter((s) => agentOf.get(s)).length / shas.length >= 0.5 ? agents.join(', ') : 'a human';
};
const dupes = copies && copies.sort((x, y) => y.lines - x.lines).map((c) => ({ ...c, a: { ...c.a, by: byWhom(c.a) }, b: { ...c.b, by: byWhom(c.b) } }));

const commit = (await sh('git', ['rev-parse', '--short', 'HEAD'], root)).trim();
const plan = readingPlan(scored);
const months = timeline(history, agentOf);
const report = renderReport({
  repo: path.basename(root),
  commit,
  date: new Date().toLocaleDateString('en-CA'),
  files: scored,
  folders: rollup(scored),
  plan,
  months,
  dupes,
  names: sameNames(parsed),
  hasAgents: [...agentOf.values()].some(Boolean),
  hasReviews: prOf.size > 0,
  usedError: knipOut.error,
});
const out = path.resolve(opts.out);
await writeFile(out, report);

const count = (q) => scored.filter((f) => f.quadrant === q).length;
const used = scored.filter((f) => f.used).length;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
console.log(`${scored.length} files · ${count('delete-first')} delete first · ${count('danger')} zombie code · ${count('safe-delete')} safe to delete · ${count('healthy')} healthy`);
console.log(`${knipOut.error ? 'unused: skipped' : `${pct(scored.length - used, scored.length)}% unused`} · ${pct(count('danger'), used)}% zombie code (live, nobody has read it)`);
if (plan.files.length) {
  console.log(`\nRead ${plan.files.length > 1 ? `these ${plan.files.length} files` : 'this file'} first (~${plan.minutes} min, ${Math.round(plan.coverage * 100)}% of zombie risk):`);
  for (const f of plan.files.slice(0, 5)) console.log(`  ${f.path}  ${[f.dependents && `${f.dependents} file${f.dependents > 1 ? 's' : ''} depend on it`, f.touches.length && `touches ${f.touches.join(', ')}`, f.churn?.changes && `${f.churn.changes} change${f.churn.changes > 1 ? 's' : ''} in 90 days`].filter(Boolean).join(' · ')}`);
}
const recent = months.slice(-6);
if (recent.some((m) => m.agent)) console.log(`\nAgent share of new code: ${recent.map((m) => `${m.month.slice(2)} ${pct(m.agent, m.agent + m.human)}%`).join(' → ')}`);
if (dupes?.length) console.log(`Copy-paste: ${dupes.length} duplicated blocks, ${dupes.reduce((n, d) => n + d.lines, 0)} lines`);
console.log(`\nreport: ${out}`);
