// zomb Cloud end to end: a fake GitHub (API + a real git remote), signed webhooks in, checks, comments and issues out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify as verifySig } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
