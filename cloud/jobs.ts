// The work behind each GitHub event: check the code out, run zomb on it, and report back on GitHub.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { toMarkdown } from '../src/tasks.ts';
import { packageManager } from '../src/fix.ts';
import type { Api } from './github.ts';
import type { Task } from '../src/types.ts';

type Result = { summary: Record<string, any>; failing: number; tasks: Task[]; baseline?: boolean };

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const exec = promisify(execFile);
const MARK = '<!-- zomb -->';
const WEEKLY = '<!-- zomb-weekly -->';
const INSTALL = { npm: ['ci'], pnpm: ['install', '--frozen-lockfile'], yarn: ['install', '--frozen-lockfile'], bun: ['install', '--frozen-lockfile'] };

// Check out a repo into a fresh folder. The token is only ever in the fetch URL, never in .git/config,
// and nothing the repo runs sees the server's environment.
// ponytail: jobs are child processes of the server; give each its own container before scanning code you don't trust
async function checkout(cloneUrl: string, token: string, refspecs: string[], ref: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'zomb-cloud-')));
  const dir = path.join(root, 'repo');
  const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
  await mkdir(dir);
  await mkdir(env.HOME);
  const run = (cmd: string, args: string[], timeout = 300_000) => exec(cmd, args, { cwd: dir, env, timeout, maxBuffer: 256 * 1024 * 1024 });
  try {
    const url = token && cloneUrl.startsWith('https://') ? cloneUrl.replace('https://', `https://x-access-token:${token}@`) : cloneUrl;
    await run('git', ['init', '-q']);
    await run('git', ['fetch', '-q', '--no-tags', '--depth=200', url, ...refspecs], 180_000);
    await run('git', ['checkout', '-q', ref]);
    // Knip needs the dependencies; --ignore-scripts so installing never runs the repo's own code
    const pm = packageManager(dir);
    if (['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((f) => existsSync(path.join(dir, f)))) await run(pm, [...INSTALL[pm], '--ignore-scripts']).catch(() => {});
    const file = path.join(dir, '.zomb', 'config.yml');
    const config = { 'fail-on': 'high', weekly: true, handoff: 'none', ...(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {}) };
    return { dir, config, run, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
}

// zomb --json on the checkout; --fail-on exits 1 but still prints the result
async function scan(co: { dir: string; run: (cmd: string, args: string[], timeout?: number) => Promise<{ stdout: string }> }, args: string[]): Promise<Result> {
  const out = await co.run(process.execPath, [CLI, co.dir, '--json', ...args]).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout);
  if (!out) throw new Error('zomb produced no result');
  return JSON.parse(out);
}

export function jobs({ gh, db, appId, log = console.error }: { gh: any; db: any; appId?: string | number; log?: (s: string) => void }) {
  const record = (repo: number | string, sha: string | null, kind: string, result: Result) =>
    db.prepare('INSERT INTO scans (repo, sha, kind, at, summary, failing, tasks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(repo, sha, kind, new Date().toISOString(), JSON.stringify(result.summary), result.failing, result.tasks.length);

  async function pullRequest({ repository: r, pull_request: pr, installation }: any) {
    const api = gh.as(installation.id);
    const check = await api('POST', `/repos/${r.full_name}/check-runs`, { name: 'zomb', head_sha: pr.head.sha, status: 'in_progress' });
    const finish = (conclusion: string, title: string, summary: string) => api('PATCH', `/repos/${r.full_name}/check-runs/${check.id}`, { status: 'completed', conclusion, output: { title, summary: summary.slice(0, 60_000) } });
    let co: Awaited<ReturnType<typeof checkout>> | undefined;
    try {
      co = await checkout(r.clone_url, await gh.installationToken(installation.id), [`+refs/heads/${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`, `+refs/pull/${pr.number}/head:refs/remotes/origin/pr`], 'origin/pr');
      const result = await scan(co, ['--since', `origin/${pr.base.ref}`, '--fail-on', co.config['fail-on']]);
      const body = toMarkdown(result.tasks, { repo: r.name, since: pr.base.ref, baseline: result.baseline });
      // one comment per PR, updated on every push
      const comments = await api('GET', `/repos/${r.full_name}/issues/${pr.number}/comments?per_page=100`);
      const mine = comments.find((c: any) => c.body?.startsWith(MARK) && c.performed_via_github_app?.id === Number(appId));
      if (mine) await api('PATCH', `/repos/${r.full_name}/issues/comments/${mine.id}`, { body });
      else await api('POST', `/repos/${r.full_name}/issues/${pr.number}/comments`, { body });
      await finish(result.failing ? 'failure' : 'success', result.failing ? `${result.failing} new finding${result.failing === 1 ? '' : 's'} at or above ${co.config['fail-on']}` : 'Nothing new', body);
      record(r.id, pr.head.sha, 'pr', result);
    } catch (e) {
      await finish('neutral', 'zomb could not scan this change', (e as Error).message).catch(() => {});
      throw e;
    } finally {
      await co?.cleanup();
    }
  }

  // Pushes to the default branch feed the trends.
  async function push({ repository: r, installation, ref, after }: any) {
    if (ref !== `refs/heads/${r.default_branch}` || /^0+$/.test(after)) return;
    const co = await checkout(r.clone_url, await gh.installationToken(installation.id), [`+${ref}:refs/remotes/origin/${r.default_branch}`], `origin/${r.default_branch}`);
    try {
      record(r.id, after, 'push', await scan(co, []));
    } finally {
      await co.cleanup();
    }
  }

  // The weekly clean-up: one issue with zomb's task list, kept up to date, handed to the team's agent.
  async function weekly(repo: any) {
    const api = gh.as(repo.installation);
    const [owner, name] = repo.name.split('/');
    const info = await api('GET', `/repos/${owner}/${name}`);
    const co = await checkout(info.clone_url, await gh.installationToken(repo.installation), [`+refs/heads/${info.default_branch}:refs/remotes/origin/${info.default_branch}`], `origin/${info.default_branch}`);
    try {
      db.prepare('UPDATE repos SET weekly_at = ? WHERE id = ?').run(new Date().toISOString(), repo.id);
      if (co.config.weekly === false) return null;
      const result = await scan(co, []);
      record(repo.id, null, 'weekly', result);
      const open = (await api('GET', `/repos/${repo.name}/issues?state=open&per_page=100`)).find((i: any) => i.body?.startsWith(WEEKLY) && !i.pull_request);
      if (!result.tasks.length) {
        if (open) await api('PATCH', `/repos/${repo.name}/issues/${open.number}`, { state: 'closed', body: `${WEEKLY}\nNothing left to clean up. 🎉` });
        return null;
      }
      const body = weeklyBody(result, co.config.handoff, !open);
      if (open) return (await api('PATCH', `/repos/${repo.name}/issues/${open.number}`, { body })).number;
      return (await api('POST', `/repos/${repo.name}/issues`, { title: 'zomb: weekly clean-up', body })).number;
    } finally {
      await co.cleanup();
    }
  }

  return { pullRequest, push, weekly };
}

// The issue an agent (or a person) works from: the safe clean-up first, then what needs a decision.
function weeklyBody(result: Result, handoff: string, first: boolean) {
  const s = result.summary;
  const line = (t: Task) => `- [ ] **${t.title}**  \n  \`${t.where.replace(/`/g, "'")}\`: ${t.how}`;
  const safe = result.tasks.filter((t) => t.safe);
  const rest = result.tasks.filter((t) => !t.safe);
  const parts = [
    WEEKLY,
    `zomb found **${result.tasks.length} things to clean up** this week: ${s.security.high} high security, ${s.zombie.lines} lines of zombie code in ${s.zombie.files} files, ${s.zombie.packages} unused packages${s.blueprint ? `, ${s.blueprint} blueprint breaks` : ''}.`,
    safe.length && `### Safe to automate (${safe.length})\nRun \`npx zomb fix\`: it deletes these on a branch, checks your typecheck, lint, tests and build after every batch, and undoes anything that breaks.\n\n${safe.slice(0, 40).map(line).join('\n')}`,
    rest.length && `### Needs a look (${rest.length})\n${rest.slice(0, 40).map(line).join('\n')}`,
    `### How to work on this\nFollow [the zomb clean-up playbook](https://github.com/Open-Dev-Society/zomb/blob/main/skills/zomb-clean/SKILL.md): security first, then \`npx zomb fix\`, then one reviewed change at a time. Never print a secret; list keys that need rotating for a human.`,
    first && handoff === 'claude' && '@claude please work through this list, following the playbook above, and open a pull request.',
    handoff === 'copilot' && '_Assign this issue to Copilot from the zomb dashboard to hand it over._',
  ];
  return parts.filter(Boolean).join('\n\n');
}
