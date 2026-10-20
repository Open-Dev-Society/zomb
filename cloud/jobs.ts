// The work behind each GitHub event: check the code out, run zomb on it, and report back on GitHub.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { toMarkdown } from '../src/tasks.ts';
import { packageManager } from '../src/fix.ts';
import type { Api } from './github.ts';
import type { Grants } from './grants.ts';
import type { Task } from '../src/types.ts';

type Result = { summary: Record<string, any>; failing: number; tasks: Task[]; baseline?: boolean };

/** Traffic younger than this says too little: a page visited once a month would look dead. */
export const TRAFFIC_MIN_DAYS = 14;
const COPILOT = /^copilot(-swe-agent)?(\[bot\])?$/i;

// Copilot takes the issue only from a person's token; the app's own token is refused.
export const assignCopilot = (user: Api, repo: string, issue: number) =>
  user('POST', `/repos/${repo}/issues/${issue}/assignees`, { assignees: ['copilot-swe-agent[bot]'], agent_assignment: { target_repo: repo } });

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const exec = promisify(execFile);
const MARK = '<!-- zomb -->';
const WEEKLY = '<!-- zomb-weekly -->';
const INSTALL = { npm: ['ci'], pnpm: ['install', '--frozen-lockfile'], yarn: ['install', '--frozen-lockfile'], bun: ['install', '--frozen-lockfile'] };

// Check out a repo into a fresh folder. The token is only ever in the fetch URL, never in .git/config,
// and nothing the repo runs sees the server's environment. Fetching stays here, so with the sandbox on
// the token never enters the container: only the checkout does.
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
    const install = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((f) => existsSync(path.join(dir, f))) ? [pm, ...INSTALL[pm], '--ignore-scripts'] : null;
    const file = path.join(dir, '.zomb', 'config.yml');
    const config = { 'fail-on': 'high', weekly: true, handoff: 'none', ...(existsSync(file) ? parse(readFileSync(file, 'utf8')) : {}) };
    return { root, dir, config, run, install, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    // execFile puts the command in its message, and the fetch URL carries the token: it would reach the log and the check run
    if (token) for (const k of ['message', 'cmd', 'stderr'] as const) if (typeof (e as any)[k] === 'string') (e as any)[k] = (e as any)[k].replaceAll(token, '***');
    throw e;
  }
}
type Checkout = Awaited<ReturnType<typeof checkout>>;

/** ZOMB_SANDBOX=docker: install and scan each checkout in a throwaway container instead of as the server's user. */
export type Sandbox = { image: string; network?: string } | null;
export const sandboxFrom = (env: Record<string, string | undefined>): Sandbox => (env.ZOMB_SANDBOX === 'docker' ? { image: env.ZOMB_SANDBOX_IMAGE || 'zomb-cloud', network: env.ZOMB_SANDBOX_NETWORK } : null);
const WORK = '/work';

// `docker run` for one job. The checkout arrives as a tar on stdin, so this works the same when the server
// itself runs in a container and talks to the host's Docker (a bind mount would name a path on the host).
// Arguments reach the script as "$@", never through the shell; only the install command, built from fixed words, is inlined.
export function sandboxArgs({ name, image, network, install, args }: { name: string; image: string; network?: string; install: string[] | null; args: string[] }) {
  // macOS tar adds extended-attribute headers the image's GNU tar would warn about on every scan
  const script = ['set -e', `tar -x --warning=no-unknown-keyword -C ${WORK}`, `cd ${WORK}/repo`, ...(install ? [`${install.join(' ')} >/dev/null 2>&1 || true`] : []), `exec node /app/src/cli.ts ${WORK}/repo --json "$@"`].join('; ');
  return [
    'run', '--rm', '-i', '--name', name,
    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
    ...(network ? ['--network', network] : []),
    '-e', `HOME=${WORK}/home`, '-e', 'CI=1', '-e', 'NO_COLOR=1',
    '--entrypoint', 'sh', image, '-c', script, 'zomb', ...args,
  ];
}

function inContainer(co: Checkout, args: string[], sandbox: NonNullable<Sandbox>, timeout = 600_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const name = `zomb-job-${randomBytes(6).toString('hex')}`;
  // files beside the checkout (the traffic file) have the same place under /work
  const inside = args.map((a) => (a.startsWith(`${co.root}/`) ? `${WORK}${a.slice(co.root.length)}` : a));
  return new Promise((resolve, reject) => {
    const docker = spawn('docker', sandboxArgs({ name, image: sandbox.image, network: sandbox.network, install: co.install, args: inside }), { stdio: ['pipe', 'pipe', 'pipe'] });
    // COPYFILE_DISABLE: macOS tar would add a ._ file per file for its extended attributes, and the scan would count them
    const tar = spawn('tar', ['-c', '-C', co.root, '.'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' } });
    let failed: Error | null = null;
    const fail = (e: Error) => ((failed ??= e), docker.kill());
    tar.on('error', fail);
    tar.on('close', (code) => code && fail(new Error(`could not pack the checkout (tar exited with ${code})`)));
    tar.stdout.pipe(docker.stdin);
    // the container may exit before it has read everything
    docker.stdin.on('error', () => {});
    let stdout = '';
    let stderr = '';
    docker.stdout.on('data', (c) => (stdout += c));
    docker.stderr.on('data', (c) => (stderr += c));
    // killing the docker CLI leaves the container running: remove it by name
    const timer = setTimeout(() => {
      failed ??= new Error(`the scan took longer than ${timeout / 60_000} minutes`);
      execFile('docker', ['rm', '-f', name], () => {});
    }, timeout);
    docker.on('error', (e) => (clearTimeout(timer), tar.kill(), reject(failed ?? e)));
    docker.on('close', (code) => (clearTimeout(timer), failed ? reject(failed) : resolve({ code, stdout, stderr })));
  });
}

// zomb --json on the checkout; --fail-on exits 1 but still prints the result
async function runScan(co: Checkout, args: string[], sandbox: Sandbox): Promise<Result> {
  let why = '';
  let out: string | undefined;
  if (sandbox) {
    const r = await inContainer(co, args, sandbox);
    out = r.stdout;
    why = r.stderr.trim().split('\n').at(-1) || `docker exited with ${r.code}`;
  } else {
    if (co.install) await co.run(co.install[0], co.install.slice(1)).catch(() => {});
    out = await co.run(process.execPath, [CLI, co.dir, '--json', ...args]).then((r) => r.stdout, (e: { stdout?: string; stderr?: string }) => ((why = e.stderr?.trim().split('\n').at(-1) || ''), e.stdout));
  }
  if (!out) throw new Error(why.replace(co.dir, 'the repo').replace(`${WORK}/repo`, 'the repo') || 'zomb produced no result');
  return JSON.parse(out);
}

export function jobs({ gh, db, appId, log = console.error, grants, sandbox = null }: { gh: any; db: any; appId?: string | number; log?: (s: string) => void; grants?: Grants; sandbox?: Sandbox }) {
  const scan = (co: Checkout, args: string[]) => runScan(co, args, sandbox);
  const record = (repo: number | string, sha: string | null, kind: string, result: Result) =>
    db.prepare('INSERT INTO scans (repo, sha, kind, at, summary, failing, tasks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(repo, sha, kind, new Date().toISOString(), JSON.stringify(result.summary), result.failing, result.tasks.length);

  // The last 30 days of the repo's log drain, as a file next to the checkout for --traffic. None until it covers 14 days.
  function traffic(repo: number | string, root: string): string[] {
    const first = (db.prepare('SELECT min(day) AS day FROM traffic WHERE repo = ? AND hits > 0').get(repo) as any)?.day;
    if (!first || Date.parse(first) > Date.now() - TRAFFIC_MIN_DAYS * 864e5) return [];
    const rows = db.prepare("SELECT path, day, hits FROM traffic WHERE repo = ? AND hits > 0 AND day >= date('now', '-30 days')").all(repo) as any[];
    if (!rows.length) return [];
    const file = path.join(root, 'traffic.ndjson');
    writeFileSync(file, `${rows.map((r) => JSON.stringify({ path: r.path, count: r.hits, timestamp: r.day })).join('\n')}\n`);
    return ['--traffic', file];
  }

  // Assign the weekly issue to Copilot with the grant someone turned on in the repo's settings.
  async function handOff(repo: any, issue: any) {
    if (issue.assignees?.some((a: any) => COPILOT.test(a.login))) return;
    try {
      await assignCopilot(gh.user(await grants!.token(repo.copilot_login)), repo.name, issue.number);
    } catch (e) {
      const err = e as { code?: string; status?: number; message: string };
      // a refused or revoked token stays refused: drop it and ask for a new sign-in
      const dead = err.code === 'bad_refresh_token' || err.code === 'no_grant' || err.status === 401;
      if (dead) grants!.drop(repo.copilot_login);
      db.prepare('UPDATE repos SET handoff_error = ? WHERE id = ?').run(dead ? `GitHub no longer accepts ${repo.copilot_login}'s sign-in` : `GitHub refused the assignment (${err.message.slice(0, 160)})`, repo.id);
      throw e;
    }
  }

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
      record(r.id, after, 'push', await scan(co, traffic(r.id, co.root)));
    } finally {
      await co.cleanup();
    }
  }

  // The first scan, as soon as the app is installed, so the dashboard has numbers before the next push.
  async function first(repo: any) {
    const info = await gh.as(repo.installation)('GET', `/repos/${repo.name}`);
    const co = await checkout(info.clone_url, await gh.installationToken(repo.installation), [`+refs/heads/${info.default_branch}:refs/remotes/origin/${info.default_branch}`], `origin/${info.default_branch}`);
    try {
      record(repo.id, null, 'install', await scan(co, traffic(repo.id, co.root)));
    } catch (e) {
      // HTML or Python only: nothing for zomb to read, so remember that instead of retrying on every start
      if (!/no JS\/TS files/.test((e as Error).message)) throw e;
      db.prepare('UPDATE repos SET note = ? WHERE id = ?').run('no JavaScript or TypeScript', repo.id);
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
      const result = await scan(co, traffic(repo.id, co.root));
      record(repo.id, null, 'weekly', result);
      const open = (await api('GET', `/repos/${repo.name}/issues?state=open&per_page=100`)).find((i: any) => i.body?.startsWith(WEEKLY) && !i.pull_request);
      if (!result.tasks.length) {
        if (open) await api('PATCH', `/repos/${repo.name}/issues/${open.number}`, { state: 'closed', body: `${WEEKLY}\nNothing left to clean up. 🎉` });
        return null;
      }
      const auto = co.config.handoff === 'copilot' && repo.copilot_login && !repo.handoff_error && grants?.has(repo.copilot_login) ? repo.copilot_login : null;
      const body = weeklyBody(result, co.config.handoff, !open, auto);
      const issue = open ? await api('PATCH', `/repos/${repo.name}/issues/${open.number}`, { body }) : await api('POST', `/repos/${repo.name}/issues`, { title: 'zomb: weekly clean-up', body });
      if (auto) {
        await handOff(repo, issue).catch(async (e) => {
          log(`${repo.name} weekly: Copilot hand-off failed: ${e.message}`);
          // the issue said it was handed over; say how to hand it over instead
          await api('PATCH', `/repos/${repo.name}/issues/${issue.number}`, { body: weeklyBody(result, co.config.handoff, !open, null) });
        });
      }
      return issue.number;
    } finally {
      await co.cleanup();
    }
  }

  return { pullRequest, push, first, weekly };
}

// The issue an agent (or a person) works from: the safe clean-up first, then what needs a decision.
function weeklyBody(result: Result, handoff: string, first: boolean, auto: string | null) {
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
    handoff === 'copilot' && (auto ? `_zomb assigns this issue to Copilot every week, on behalf of ${auto}._` : '_Assign this issue to Copilot from the zomb dashboard to hand it over._'),
  ];
  return parts.filter(Boolean).join('\n\n');
}
