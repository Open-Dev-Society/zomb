#!/usr/bin/env node
// zomb Cloud: a GitHub App. Install it and every pull request gets a zomb check and comment (no workflow file),
// every push to the default branch feeds the trends dashboard, and each repo gets a weekly clean-up issue
// handed to the agent the team already uses. Self-host it, or use ours.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { github, verify } from './github.js';
import { jobs } from './jobs.js';

export function config(env = process.env) {
  const data = env.DATA_DIR || path.join(import.meta.dirname, 'data');
  // written by /setup when the app was created from its manifest; env vars win
  const saved = existsSync(path.join(data, 'app.json')) ? JSON.parse(readFileSync(path.join(data, 'app.json'), 'utf8')) : {};
  const key = env.GITHUB_PRIVATE_KEY || saved.pem || '';
  return {
    data,
    url: (env.ZOMB_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    port: Number(env.PORT || 3000),
    appId: env.GITHUB_APP_ID || saved.id,
    slug: env.GITHUB_APP_SLUG || saved.slug,
    privateKey: key.includes('BEGIN') ? key : Buffer.from(key, 'base64').toString(),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || saved.webhook_secret,
    clientId: env.GITHUB_CLIENT_ID || saved.client_id,
    clientSecret: env.GITHUB_CLIENT_SECRET || saved.client_secret,
    api: env.GITHUB_API || 'https://api.github.com',
    web: env.GITHUB_WEB || 'https://github.com',
  };
}

export function start(cfg = config(), { log = console.error } = {}) {
  mkdirSync(cfg.data, { recursive: true });
  const db = new DatabaseSync(path.join(cfg.data, 'zomb.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY, installation INTEGER NOT NULL, name TEXT NOT NULL, weekly_at TEXT);
    CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY AUTOINCREMENT, repo INTEGER NOT NULL, sha TEXT, kind TEXT, at TEXT, summary TEXT, failing INTEGER, tasks INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, login TEXT, token TEXT, installations TEXT, expires INTEGER);`);
  const ready = Boolean(cfg.appId && cfg.privateKey && cfg.webhookSecret);
  const gh = ready && github(cfg);
  const work = ready && jobs({ gh, db, appId: cfg.appId, log });

  // ponytail: in-memory queue, two jobs at a time; a restart drops queued jobs (the next push or week redoes them)
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < 2 && queue.length) {
      const [label, fn] = queue.shift();
      active++;
      fn()
        .catch((e) => log(`${label}: ${e.message}`))
        .finally(() => (active--, pump()));
    }
  };
  const enqueue = (label, fn) => (queue.push([label, fn]), pump());

  const addRepos = (installation, repos) => {
    for (const r of repos) db.prepare('INSERT INTO repos (id, installation, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET installation = excluded.installation, name = excluded.name').run(r.id, installation, r.full_name);
  };
  function onEvent(event, p) {
    if (event === 'installation' && p.action === 'deleted') db.prepare('DELETE FROM repos WHERE installation = ?').run(p.installation.id);
    else if (event === 'installation' && p.repositories) addRepos(p.installation.id, p.repositories);
    else if (event === 'installation_repositories') {
      addRepos(p.installation.id, p.repositories_added || []);
      for (const r of p.repositories_removed || []) db.prepare('DELETE FROM repos WHERE id = ?').run(r.id);
    } else if (event === 'pull_request' && ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(p.action)) enqueue(`${p.repository.full_name}#${p.number}`, () => work.pullRequest(p));
    else if (event === 'push') enqueue(`${p.repository.full_name} push`, () => work.push(p));
  }

  // every hour: repos whose weekly clean-up is due
  const weeklyDue = () => {
    const due = db.prepare("SELECT * FROM repos WHERE weekly_at IS NULL OR datetime(weekly_at) < datetime('now', '-7 days')").all();
    for (const repo of due) enqueue(`${repo.name} weekly`, () => work.weekly(repo));
  };
  const timer = ready && setInterval(weeklyDue, 3600_000);

  // ---------- sessions: GitHub sign-in, so people see only the repos their installations cover
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
  const secure = cfg.url.startsWith('https') ? '; Secure' : '';
  const session = (req) => {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').get(cookies(req).zomb || '', Date.now());
    return s && { ...s, installations: JSON.parse(s.installations) };
  };

  const send = (res, status, body, headers = {}) => (res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }), res.end(body));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, cfg.url);
    try {
      if (req.method === 'POST' && url.pathname === '/webhook') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (!ready || !verify(cfg.webhookSecret, body, req.headers['x-hub-signature-256'])) return send(res, 401, 'bad signature');
        send(res, 202, 'queued');
        return onEvent(req.headers['x-github-event'], JSON.parse(body));
      }
      if (url.pathname === '/health') return send(res, 200, 'ok', { 'content-type': 'text/plain' });
      if (url.pathname === '/setup') return send(res, 200, setupPage(cfg, ready));
      if (url.pathname === '/setup/done') {
        if (ready) return send(res, 400, 'Already set up.');
        const app = await fetch(`${cfg.api}/app-manifests/${encodeURIComponent(url.searchParams.get('code'))}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } }).then((r) => r.json());
        if (!app.id) return send(res, 400, `GitHub said: ${app.message || 'no app'}`);
        writeFileSync(path.join(cfg.data, 'app.json'), JSON.stringify(app), { mode: 0o600 });
        return send(res, 200, page('Set up', `<h1>${esc(app.name)} is ready</h1><p>Restart the server to load it, then <a href="${esc(app.html_url)}/installations/new">install it on your repos</a>.</p>`));
      }
      if (!ready) return send(res, 302, '', { location: '/setup' });
      if (url.pathname === '/login') {
        const state = randomBytes(16).toString('hex');
        return send(res, 302, '', { location: gh.loginUrl(state, `${cfg.url}/callback`), 'set-cookie': `zomb_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}` });
      }
      if (url.pathname === '/callback') {
        if (!url.searchParams.get('state') || url.searchParams.get('state') !== cookies(req).zomb_state) return send(res, 400, 'Sign-in expired. <a href="/login">Try again</a>.');
        const token = await gh.signIn(url.searchParams.get('code'));
        const user = gh.user(token);
        const me = await user('GET', '/user');
        const { installations } = await user('GET', '/user/installations?per_page=100');
        const id = randomBytes(24).toString('hex');
        db.prepare('INSERT INTO sessions (id, login, token, installations, expires) VALUES (?, ?, ?, ?, ?)').run(id, me.login, token, JSON.stringify(installations.map((i) => i.id)), Date.now() + 8 * 3600_000);
        return send(res, 302, '', { location: '/', 'set-cookie': `zomb=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}` });
      }
      if (url.pathname === '/logout') {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(cookies(req).zomb || '');
        return send(res, 302, '', { location: '/', 'set-cookie': 'zomb=; Path=/; Max-Age=0' });
      }
      const me = session(req);
      if (url.pathname === '/') return send(res, 200, me ? dashboard(db, me, cfg) : landing(cfg));
      // hand the weekly issue to Copilot: Copilot only takes assignments from a person's token, so this is a click, not a cron
      const copilot = url.pathname.match(/^\/repos\/(\d+)\/copilot$/);
      if (copilot && req.method === 'POST' && me && req.headers.origin === new URL(cfg.url).origin) {
        const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(Number(copilot[1]));
        if (!repo || !me.installations.includes(repo.installation)) return send(res, 404, 'Not found');
        const issue = (await gh.as(repo.installation)('GET', `/repos/${repo.name}/issues?state=open&per_page=100`)).find((i) => i.body?.startsWith('<!-- zomb-weekly -->'));
        if (!issue) return send(res, 404, page('No issue', '<p>No open weekly clean-up issue yet. It is created on the next weekly run.</p>'));
        await gh.user(me.token)('POST', `/repos/${repo.name}/issues/${issue.number}/assignees`, { assignees: ['copilot-swe-agent[bot]'], agent_assignment: { target_repo: repo.name } });
        return send(res, 302, '', { location: '/' });
      }
      send(res, 404, page('Not found', '<p>Not found.</p>'));
    } catch (e) {
      log(`${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) send(res, 500, page('Error', '<p>Something went wrong.</p>'));
    }
  });
  return new Promise((resolve) =>
    server.listen(cfg.port, () =>
      resolve({
        port: server.address().port,
        db,
        weekly: (id) => work.weekly(db.prepare('SELECT * FROM repos WHERE id = ?').get(id)),
        idle: () => new Promise((r) => { const t = setInterval(() => !active && !queue.length && (clearInterval(t), r()), 50); }),
        close: () => (clearInterval(timer), db.close(), new Promise((r) => server.close(r))),
      }),
    ),
  );
}

// ---------- pages: server-rendered, no JavaScript
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · zomb</title><style>
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#77726b;--line:#e6e2dc;--bad:#d4442e;--good:#3f9b62;--accent:#1c1b19}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe8;--muted:#9a958d;--line:#2c2b28;--bad:#ff6b55;--good:#5cc185;--accent:#ecebe8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:48px 16px 80px}h1{font-size:32px;letter-spacing:-.02em;margin:0 0 4px}a{color:inherit}.muted{color:var(--muted)}
.btn{display:inline-block;background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.ghost{background:none;color:var(--fg);border:1px solid var(--line);padding:4px 10px;font-size:13px;font-weight:500;white-space:nowrap}
table{width:100%;border-collapse:collapse;margin-top:32px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
td b{font-variant-numeric:tabular-nums}.bad{color:var(--bad)}.good{color:var(--good)}svg{display:block}.wrap{overflow-x:auto}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
</style></head><body><main>${body}</main></body></html>`;

function landing(cfg) {
  return page('zomb', `<h1>zomb</h1><p class="muted">A health check on every pull request, trends across your repos, and a weekly clean-up your agent does.</p>
<p><a class="btn" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on GitHub</a> &nbsp; <a href="/login">Sign in</a></p>`);
}

// a tiny line chart of one number over the last scans; higher is worse for everything shown
function spark(values) {
  if (values.length < 2) return '<span class="muted">–</span>';
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 96 + 2},${22 - (v / max) * 20}`).join(' ');
  const tone = values.at(-1) > values[0] ? 'var(--bad)' : values.at(-1) < values[0] ? 'var(--good)' : 'var(--muted)';
  return `<svg width="100" height="24" viewBox="0 0 100 24" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${tone}" stroke-width="1.5"/></svg>`;
}

function dashboard(db, me, cfg) {
  const repos = db.prepare(`SELECT * FROM repos WHERE installation IN (${me.installations.map(() => '?').join(',') || 'NULL'}) ORDER BY name`).all(...me.installations);
  const rows = repos.map((r) => {
    const scans = db.prepare("SELECT * FROM scans WHERE repo = ? AND kind != 'pr' ORDER BY id DESC LIMIT 12").all(r.id).reverse().map((s) => ({ ...s, summary: JSON.parse(s.summary) }));
    const last = scans.at(-1)?.summary;
    const cell = (pick) => (last ? `<td><b class="${pick(last) ? 'bad' : ''}">${(pick(last) || 0).toLocaleString('en-US')}</b>${spark(scans.map((s) => pick(s.summary) || 0))}</td>` : '<td class="muted">–</td>');
    return `<tr><td><a href="${esc(cfg.web)}/${esc(r.name)}">${esc(r.name)}</a><br><span class="muted">${scans.length ? `scanned ${esc(scans.at(-1).at.slice(0, 10))}` : 'waiting for the first push'}</span></td>
${cell((s) => s.security.high)}${cell((s) => s.zombie.lines)}${cell((s) => s.zombie.packages)}${cell((s) => s.architecture.cycles + s.architecture.bigFiles)}${cell((s) => s.blueprint || 0)}
<td><form method="post" action="/repos/${r.id}/copilot"><button class="btn ghost">Hand to Copilot</button></form></td></tr>`;
  });
  return page('Dashboard', `<header><div><h1>Your repos</h1><p class="muted">Signed in as ${esc(me.login)} · <a href="/logout">sign out</a></p></div><a class="btn" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Add repos</a></header>
<div class="wrap"><table><thead><tr><th>Repo</th><th>High security</th><th>Zombie lines</th><th>Unused packages</th><th>Architecture</th><th>Blueprint breaks</th><th>Weekly clean-up</th></tr></thead><tbody>
${rows.join('') || '<tr><td colspan="7" class="muted">No repos yet. Install the app on a repo, then push to its default branch.</td></tr>'}</tbody></table></div>`);
}

// Create the GitHub App from a manifest: one click on GitHub, and the credentials come back here.
function setupPage(cfg, ready) {
  if (ready) return page('Set up', '<h1>Already set up</h1><p><a href="/">Go to the dashboard</a></p>');
  const manifest = {
    name: 'zomb',
    url: cfg.url,
    hook_attributes: { url: `${cfg.url}/webhook` },
    redirect_url: `${cfg.url}/setup/done`,
    callback_urls: [`${cfg.url}/callback`],
    public: true,
    default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'write', issues: 'write', checks: 'write' },
    default_events: ['pull_request', 'push'],
  };
  return page('Set up', `<h1>Create your zomb GitHub App</h1><p class="muted">GitHub creates the app from this manifest and sends its keys back to this server (saved in ${esc(cfg.data)}/app.json). Webhooks go to ${esc(cfg.url)}/webhook, so this URL must be reachable from GitHub.</p>
<form action="${esc(cfg.web)}/settings/apps/new" method="post"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button class="btn">Create the app on GitHub</button></form>`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const s = await start(cfg);
  console.error(`zomb cloud on ${cfg.url} (port ${s.port})${cfg.appId ? '' : `: open ${cfg.url}/setup to create the GitHub App`}`);
}
