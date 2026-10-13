// zomb Cloud end to end: a fake GitHub (API + a real git remote), signed webhooks in, checks, comments and issues out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify as verifySig } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { start } from '../cloud/server.ts';

const stripeKey = ['sk', 'live', 'Q7mZp2Lx9Rt4Vb8Nc1Hs6Kd3'].join('_');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

// GitHub's API, as far as the app uses it. Every call is recorded.
function fakeGitHub(): Promise<{ server: any; calls: any[]; url: string }> {
  const calls: any[] = [];
  const server: any = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const call = { method: req.method, path: req.url || '', body: body && JSON.parse(body), auth: req.headers.authorization || '' };
    calls.push(call);
    const reply = (status: number, data: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(data)));
    if (call.path === '/app/installations/1/access_tokens') {
      const [h, p, sig] = call.auth.slice(7).split('.');
      if (!verifySig('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))) return reply(401, { message: 'bad jwt' });
      return reply(201, { token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (req.method === 'POST' && call.path.endsWith('/check-runs')) return reply(201, { id: 7 });
    if (req.method === 'PATCH' && call.path.includes('/check-runs/')) return reply(200, {});
    if (req.method === 'GET' && /\/issues\/\d+\/comments/.test(call.path)) return reply(200, []);
    if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(call.path)) return reply(201, { id: 9 });
    if (req.method === 'GET' && call.path.startsWith('/repos/o/r/issues?')) return reply(200, []);
    if (req.method === 'POST' && call.path === '/repos/o/r/issues') return reply(201, { number: 5 });
    if (req.method === 'GET' && call.path === '/repos/o/r') return reply(200, { clone_url: server.cloneUrl, default_branch: 'main' });
    if (req.method === 'GET' && call.path === '/repos/o/site') return reply(200, { clone_url: server.siteUrl, default_branch: 'main' });
    if (req.method === 'GET' && call.path === '/repos/o/gone') return reply(200, { clone_url: 'https://gone.invalid/o/gone.git', default_branch: 'main' });
    // a Next.js site whose weekly issue goes to Copilot
    if (req.method === 'GET' && call.path === '/repos/o/web') return reply(200, { clone_url: server.webUrl, default_branch: 'main' });
    if (req.method === 'GET' && call.path.startsWith('/repos/o/web/issues?')) return reply(200, []);
    if (req.method === 'POST' && call.path === '/repos/o/web/issues') return reply(201, { number: 8, assignees: [] });
    if (req.method === 'PATCH' && call.path === '/repos/o/web/issues/8') return reply(200, { number: 8, assignees: [] });
    if (req.method === 'POST' && call.path === '/repos/o/web/issues/8/assignees') return reply(201, { number: 8 });
    // sign-in: a code, then refresh tokens that work once each
    if (req.method === 'POST' && call.path === '/login/oauth/access_token') {
      if (call.body.code) return reply(200, { access_token: 'user-1', expires_in: 60, refresh_token: 'refresh-1', refresh_token_expires_in: 15897600 });
      if (call.body.grant_type === 'refresh_token' && call.body.refresh_token === 'refresh-1') return reply(200, { access_token: 'user-2', expires_in: 28800, refresh_token: 'refresh-2', refresh_token_expires_in: 15897600 });
      return reply(200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
    }
    if (req.method === 'GET' && call.path === '/user') return reply(200, { login: 'dev' });
    if (req.method === 'GET' && call.path.startsWith('/user/installations')) return reply(200, { installations: [{ id: 1 }] });
    reply(404, { message: `unexpected ${req.method} ${call.path}` });
  });
  return new Promise((r) => server.listen(0, () => r({ server, calls, url: `http://localhost:${server.address().port}` })));
}

test('pull requests get a check and a comment; the weekly clean-up opens an issue for the agent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-cloud-test-'));
  const gh = await fakeGitHub();
  let app: any;
  try {
    // a repo with a remote: main has a dead file, the PR adds a live key
    const work = path.join(dir, 'work');
    const files = {
      'package.json': JSON.stringify({ name: 'r', private: true }),
      'src/index.ts': 'export const hello = 1;\n',
      'src/old.ts': 'export const unused = 2;\n',
      '.zomb/config.yml': 'handoff: claude\n',
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      writeFileSync(path.join(work, f), body);
    }
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'switch', '-q', '-c', 'feature');
    writeFileSync(path.join(work, 'src/pay.ts'), `import { hello } from './index';\nexport const stripe = "${stripeKey}" + hello;\n`);
    writeFileSync(path.join(work, 'src/index.ts'), "export const hello = 1;\nexport { stripe } from './pay';\n");
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'add payments');
    const head = git(work, 'rev-parse', 'HEAD');
    const bare = path.join(dir, 'r.git');
    git(dir, 'clone', '-q', '--bare', work, bare);
    git(bare, 'update-ref', 'refs/pull/1/head', head);
    gh.server.cloneUrl = `file://${bare}`;
    // a site with no JS/TS at all
    const site = path.join(dir, 'site');
    mkdirSync(site);
    writeFileSync(path.join(site, 'index.html'), '<h1>hi</h1>\n');
    git(site, 'init', '-q', '-b', 'main');
    git(site, 'add', '-A');
    git(site, 'commit', '-q', '-m', 'init');
    gh.server.siteUrl = `file://${site}`;

    const secret = 'shh';
    const logs: string[] = [];
    app = await start({ data: path.join(dir, 'data'), url: 'http://localhost', port: 0, appId: '123', slug: 'zomb', privateKey, webhookSecret: secret, clientId: 'c', clientSecret: 's', api: gh.url, web: 'https://github.com' }, { log: (s) => logs.push(s) });
    const hook = (event, payload, sign = secret) => {
      const body = JSON.stringify(payload);
      return fetch(`http://localhost:${app.port}/webhook`, { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', sign).update(body).digest('hex')}` } });
    };

    assert.equal((await hook('push', {}, 'wrong')).status, 401, 'unsigned webhooks are refused');
    assert.equal((await hook('installation', { action: 'created', installation: { id: 1 }, repositories: [{ id: 42, full_name: 'o/r' }] })).status, 202);
    assert.equal(app.db.prepare('SELECT name FROM repos WHERE id = 42').get().name, 'o/r');
    await hook('installation_repositories', { action: 'added', installation: { id: 1 }, repositories_added: [{ id: 43, full_name: 'o/site' }, { id: 44, full_name: 'o/gone' }] });
    await app.idle();
    assert.equal(app.db.prepare('SELECT note FROM repos WHERE id = 43').get().note, 'no JavaScript or TypeScript', 'a repo with nothing to read is marked, not retried');
    assert.ok(logs.some((l) => l.startsWith('o/gone')), `a failed clone is logged: ${logs}`);
    assert.ok(!logs.join('\n').includes('inst-token'), `the token never reaches the log: ${logs}`);

    const repository = { id: 42, name: 'r', full_name: 'o/r', clone_url: `file://${bare}`, default_branch: 'main' };
    await hook('pull_request', { action: 'opened', number: 1, installation: { id: 1 }, repository, pull_request: { number: 1, head: { sha: head }, base: { ref: 'main' } } });
    await app.idle();
    const comment = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/1/comments');
    assert.ok(comment, `a PR comment: ${JSON.stringify(gh.calls.map((c) => `${c.method} ${c.path}`))}`);
    assert.match(comment.body.body, /^<!-- zomb -->/);
    assert.match(comment.body.body, /Stripe live key in the code/);
    assert.ok(!JSON.stringify(gh.calls).includes(stripeKey.slice(8)), 'the key never leaves the server');
    assert.equal(comment.auth, 'Bearer inst-token', 'acts as the installation, not the app');
    const done = gh.calls.find((c) => c.method === 'PATCH' && c.path === '/repos/o/r/check-runs/7');
    assert.equal(done.body.conclusion, 'failure', 'a new high finding fails the check');
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM scans WHERE kind = 'pr'").get().n, 1);
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM scans WHERE kind = 'install'").get().n, 1, 'installing scans the default branch straight away');

    // the weekly clean-up: an issue with the task list, handed to Claude by mention
    assert.equal(await app.weekly(42), 5);
    const issue = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues');
    assert.match(issue.body.body, /^<!-- zomb-weekly -->/);
    assert.match(issue.body.body, /Delete src\/old\.ts/);
    assert.match(issue.body.body, /@claude please work through this list/);
    assert.ok(app.db.prepare('SELECT weekly_at FROM repos WHERE id = 42').get().weekly_at);

    assert.match(await (await fetch(`http://localhost:${app.port}/`)).text(), /Install on GitHub/, 'signed-out visitors see the landing page');
  } finally {
    await app?.close();
    gh.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log drain feeds the weekly scan, and the weekly issue goes to Copilot by itself', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-cloud-traffic-'));
  const gh = await fakeGitHub();
  let app: any;
  try {
    const work = path.join(dir, 'web');
    const files = {
      'package.json': JSON.stringify({ name: 'web', private: true, dependencies: { next: '15.0.0', react: '19.0.0' } }),
      'app/page.tsx': 'export default function Home() { return <a href="/about">About</a>; }\n',
      'app/about/page.tsx': 'export default function About() { return <p>about</p>; }\n',
      'app/promo/page.tsx': 'export default function Promo() { return <p>promo</p>; }\n',
      'app/old/page.tsx': 'export default function Old() { return <p>old</p>; }\n',
      'app/blog/[slug]/page.tsx': 'export default function Post() { return <p>post</p>; }\n',
      '.zomb/config.yml': 'handoff: copilot\n',
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      writeFileSync(path.join(work, f), body);
    }
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'init');
    gh.server.webUrl = `file://${work}`;

    const secret = 'shh';
    app = await start({ data: path.join(dir, 'data'), url: 'http://localhost', port: 0, appId: '123', slug: 'zomb', privateKey, webhookSecret: secret, clientId: 'c', clientSecret: 's', api: gh.url, web: gh.url }, { log: () => {} });
    const base = `http://localhost:${app.port}`;
    const hook = (event, payload) => {
      const body = JSON.stringify(payload);
      return fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
    };
    await hook('installation', { action: 'created', installation: { id: 1 }, repositories: [{ id: 50, full_name: 'o/web' }] });
    await app.idle();
    app.db.prepare('INSERT INTO sessions (id, login, token, installations, expires) VALUES (?, ?, ?, ?, ?)').run('sess', 'dev', 'session-token', '[1]', Date.now() + 3600_000);
    const as = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: 'manual', ...init, headers: { cookie: 'zomb=sess', origin: 'http://localhost', ...(init.headers || {}) } });

    // the settings page hands out the drain's endpoint and token
    const settings = await (await as('/repos/50')).text();
    assert.match(settings, /http:\/\/localhost\/drain\/50/);
    const token = settings.match(/Bearer ([\w-]+)/)![1];
    assert.equal((await fetch(`${base}/repos/50`, { redirect: 'manual' })).status, 302, 'signed-out visitors are sent to sign in');

    // Vercel signs a JSON array; anything else sends the token, gzipped or not
    const day = (ago: number) => Date.now() - ago * 864e5;
    const vercel = Buffer.from(JSON.stringify([{ source: 'lambda', path: '/blog/hello', timestamp: day(20) }, { proxy: { path: '/_next/static/chunk.js' }, timestamp: day(20) }]));
    const drain = (body: Buffer, headers: Record<string, string>) => fetch(`${base}/drain/50`, { method: 'POST', body, headers });
    assert.equal((await drain(vercel, { 'x-vercel-signature': 'nope' })).status, 401, 'unsigned drains are refused');
    const signed = await drain(vercel, { 'x-vercel-signature': createHmac('sha1', token).update(vercel).digest('hex') });
    assert.deepEqual(await signed.json(), { requests: 1, dropped: 0 }, 'the static file is not a request for a route');
    const lines = gzipSync(`${JSON.stringify({ path: '/about?ref=home', timestamp: day(3) })}\n${JSON.stringify({ path: '/promo', timestamp: day(1) })}\n`);
    assert.equal((await drain(lines, { authorization: `Bearer ${token}`, 'content-encoding': 'gzip' })).status, 200);
    const rows = app.db.prepare('SELECT path, hits FROM traffic WHERE repo = 50 ORDER BY path').all().map((r) => `${r.path} ${r.hits}`);
    assert.deepEqual(rows, ['/about 1', '/blog/hello 1', '/promo 1'], 'paths and counts only, static files skipped');
    assert.equal((await drain(Buffer.from('/x'), { authorization: 'Bearer x' })).status, 401);
    assert.equal((await fetch(`${base}/drain/999`, { method: 'POST', body: '/x', headers: { authorization: `Bearer ${token}` } })).status, 404);

    // turning on automatic hand-off signs in again, and keeps that token sealed
    const on = await as('/repos/50/copilot/auto', { method: 'POST', body: 'on=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(on.status, 302);
    assert.match(on.headers.get('location')!, /\/login\/oauth\/authorize\?client_id=c/);
    const jar = on.headers.getSetCookie().map((c) => c.split(';')[0]);
    const state = jar.find((c) => c.startsWith('zomb_state='))!.split('=')[1];
    const back = await fetch(`${base}/callback?code=abc&state=${state}`, { redirect: 'manual', headers: { cookie: jar.join('; ') } });
    assert.equal(back.headers.get('location'), '/repos/50');
    assert.equal(app.db.prepare('SELECT copilot_login FROM repos WHERE id = 50').get().copilot_login, 'dev');
    const grant = JSON.stringify(app.db.prepare('SELECT * FROM grants').all());
    assert.ok(grant.includes('"dev"') && !grant.includes('user-1') && !grant.includes('refresh-1'), `tokens are sealed at rest: ${grant}`);
    assert.match(await (await as('/')).text(), /Copilot, automatic/);

    // the weekly issue: routes no request reached, then assigned to Copilot with a refreshed token
    assert.equal(await app.weekly(50), 8);
    const issue = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/o/web/issues');
    assert.match(issue.body.body, /Delete \/old: no links and no traffic/);
    assert.doesNotMatch(issue.body.body, /\/promo|\/about|\/blog/, 'routes with requests are in use, linked or not');
    assert.match(issue.body.body, /assigns this issue to Copilot every week, on behalf of dev/);
    const refresh = gh.calls.find((c) => c.path === '/login/oauth/access_token' && c.body.grant_type === 'refresh_token');
    assert.equal(refresh?.body.refresh_token, 'refresh-1', 'the short-lived token is refreshed before use');
    const assign = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/o/web/issues/8/assignees');
    assert.equal(assign.auth, 'Bearer user-2', 'assigned as the person, with the fresh token');
    assert.deepEqual(assign.body.assignees, ['copilot-swe-agent[bot]']);

    // revoking zomb on GitHub stops the hand-off and says so
    await hook('github_app_authorization', { action: 'revoked', sender: { login: 'dev' } });
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
    assert.match(await (await as('/')).text(), /Copilot stopped/);
    assert.match(await (await as('/repos/50')).text(), /Stopped: dev revoked/);
  } finally {
    await app?.close();
    gh.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-off GitHub refuses puts the manual line back and asks for a new sign-in', async () => {
  const { jobs } = await import('../cloud/jobs.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, installation INTEGER, name TEXT, weekly_at TEXT, note TEXT, drain_secret TEXT, copilot_login TEXT, handoff_error TEXT); CREATE TABLE scans (id INTEGER PRIMARY KEY AUTOINCREMENT, repo INTEGER, sha TEXT, kind TEXT, at TEXT, summary TEXT, failing INTEGER, tasks INTEGER); CREATE TABLE traffic (repo INTEGER, day TEXT, path TEXT, hits INTEGER)");
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-cloud-refused-'));
  try {
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), '{"name":"r","private":true}');
    writeFileSync(path.join(dir, 'src/index.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(dir, 'src/old.ts'), 'export const b = 2;\n');
    mkdirSync(path.join(dir, '.zomb'));
    writeFileSync(path.join(dir, '.zomb/config.yml'), 'handoff: copilot\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=D', '-c', 'user.email=d@e.com', 'commit', '-q', '-m', 'i'], { cwd: dir });
    db.prepare("INSERT INTO repos (id, installation, name, copilot_login) VALUES (1, 1, 'o/r', 'dev')").run();
    const calls: any[] = [];
    const api = async (method: string, url: string, body?: any) => {
      calls.push({ method, url, body });
      if (url === '/repos/o/r') return { clone_url: `file://${dir}`, default_branch: 'main' };
      if (url.startsWith('/repos/o/r/issues?')) return [];
      return { number: 3, assignees: [] };
    };
    let dropped = '';
    const grants: any = { has: () => true, drop: (l: string) => (dropped = l), token: async () => Promise.reject(Object.assign(new Error('bad'), { code: 'bad_refresh_token' })) };
    const work = jobs({ gh: { as: () => api, user: () => api, installationToken: async () => '' }, db, grants, log: () => {} });
    assert.equal(await work.weekly(db.prepare('SELECT * FROM repos').get()), 3);
    const bodies = calls.filter((c) => c.body?.body).map((c) => c.body.body);
    assert.match(bodies[0], /on behalf of dev/);
    assert.match(bodies.at(-1), /Assign this issue to Copilot from the zomb dashboard/, 'the issue no longer claims it was handed over');
    assert.equal(dropped, 'dev');
    assert.match((db.prepare('SELECT handoff_error FROM repos').get() as any).handoff_error, /no longer accepts dev/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the field places your repos among the study authors, biggest first', async () => {
  const { field } = await import('../cloud/server.ts');
  const authors = { Human: { deletedPer100: 33.07 }, Claude: { deletedPer100: 20.77 }, Devin: { deletedPer100: 36.6 } };
  const html = field(24, authors);
  const rows = [...html.matchAll(/<tr class="(me)?"><td>([^<]+)<\/td><td><span class="bar" style="width:(\d+)px"><\/span>(\d+)/g)].map(([, me, name, w, v]) => [name, Number(v), Number(w), Boolean(me)]);
  assert.deepEqual(rows.map(([n]) => n), ['Devin', 'Humans', 'Your repos', 'Claude'], 'ranked, with yours in place');
  assert.deepEqual(rows.find(([n]) => n === 'Your repos'), ['Your repos', 24, 78, true]);
  assert.equal(rows[0][2], 120, 'the longest bar sets the scale');
  assert.equal(field(null, authors).includes('Your repos'), false, 'no row for a fleet with too little history');
});
