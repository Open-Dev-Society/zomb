#!/usr/bin/env node
// zomb Cloud: a GitHub App. Install it and every pull request gets a zomb check and comment (no workflow file),
// every push to the default branch feeds the trends dashboard, and each repo gets a weekly clean-up issue
// handed to the agent the team already uses. Self-host it, or use ours.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { github, verify } from './github.ts';
import { jobs } from './jobs.ts';

type Session = { id: string; login: string; token: string; installations: number[]; expires: number };

function config(env: Record<string, string | undefined> = process.env) {
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

export function start(cfg: ReturnType<typeof config> = config(), { log = console.error }: { log?: (s: string) => void } = {}) {
  mkdirSync(cfg.data, { recursive: true });
  const db = new DatabaseSync(path.join(cfg.data, 'zomb.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY, installation INTEGER NOT NULL, name TEXT NOT NULL, weekly_at TEXT);
    CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY AUTOINCREMENT, repo INTEGER NOT NULL, sha TEXT, kind TEXT, at TEXT, summary TEXT, failing INTEGER, tasks INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, login TEXT, token TEXT, installations TEXT, expires INTEGER);`);
  // built either way: they only make closures, and `ready` gates every call that needs real credentials
  const ready = Boolean(cfg.appId && cfg.privateKey && cfg.webhookSecret);
  const gh = github(cfg);
  const work = jobs({ gh, db, appId: cfg.appId, log });

  // ponytail: in-memory queue, two jobs at a time; a restart drops queued jobs (the next push or week redoes them)
  const queue: [string, () => Promise<unknown>][] = [];
  let active = 0;
  const pump = () => {
    while (active < 2 && queue.length) {
      const [label, fn] = queue.shift()!;
      active++;
      fn()
        .catch((e) => log(`${label}: ${e.message}`))
        .finally(() => (active--, pump()));
    }
  };
  const enqueue = (label: string, fn: () => Promise<unknown>) => (queue.push([label, fn]), pump());

  const addRepos = (installation: number, repos: { id: number; full_name: string }[]) => {
    for (const r of repos) db.prepare('INSERT INTO repos (id, installation, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET installation = excluded.installation, name = excluded.name').run(r.id, installation, r.full_name);
  };
  function onEvent(event: string | string[] | undefined, p: any) {
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
    const due = db.prepare("SELECT * FROM repos WHERE weekly_at IS NULL OR datetime(weekly_at) < datetime('now', '-7 days')").all() as any[];
    for (const repo of due) enqueue(`${repo.name} weekly`, () => work.weekly(repo));
  };
  const timer = ready ? setInterval(weeklyDue, 3600_000) : undefined;

  // ---------- sessions: GitHub sign-in, so people see only the repos their installations cover
  const cookies = (req: { headers: Record<string, any> }): Record<string, string> => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
  const secure = cfg.url.startsWith('https') ? '; Secure' : '';
  const session = (req: { headers: Record<string, any> }): Session | null => {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').get(cookies(req).zomb || '', Date.now()) as any;
    return s ? { ...s, installations: JSON.parse(s.installations) } : null;
  };

  const send = (res: any, status: number, body: string, headers: Record<string, string> = {}) => (res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }), res.end(body));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', cfg.url);
    try {
      if (req.method === 'POST' && url.pathname === '/webhook') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (!ready || !verify(cfg.webhookSecret, body, req.headers['x-hub-signature-256'])) return send(res, 401, 'bad signature');
        send(res, 202, 'queued');
        return onEvent(req.headers['x-github-event'], JSON.parse(body.toString()));
      }
      if (url.pathname === '/health') return send(res, 200, 'ok', { 'content-type': 'text/plain' });
      if (url.pathname === '/setup') return send(res, 200, setupPage(cfg, ready));
      if (url.pathname === '/setup/done') {
        if (ready) return send(res, 400, 'Already set up.');
        const app = (await fetch(`${cfg.api}/app-manifests/${encodeURIComponent(url.searchParams.get('code') || '')}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } }).then((r) => r.json())) as any;
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
        const token = await gh.signIn(url.searchParams.get('code') || '');
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
      if (url.pathname === '/') return send(res, 200, me ? dashboard(db, me, cfg, url.searchParams.get('view') || 'all') : landing(cfg));
      // hand the weekly issue to Copilot: Copilot only takes assignments from a person's token, so this is a click, not a cron
      const copilot = url.pathname.match(/^\/repos\/(\d+)\/copilot$/);
      if (copilot && req.method === 'POST' && me && req.headers.origin === new URL(cfg.url).origin) {
        const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(Number(copilot[1])) as any;
        if (!repo || !me.installations.includes(repo.installation)) return send(res, 404, 'Not found');
        const issue = (await gh.as(repo.installation)('GET', `/repos/${repo.name}/issues?state=open&per_page=100`)).find((i: any) => i.body?.startsWith('<!-- zomb-weekly -->'));
        if (!issue) return send(res, 404, page('No issue', '<p>No open weekly clean-up issue yet. It is created on the next weekly run.</p>'));
        await gh.user(me.token)('POST', `/repos/${repo.name}/issues/${issue.number}/assignees`, { assignees: ['copilot-swe-agent[bot]'], agent_assignment: { target_repo: repo.name } });
        return send(res, 302, '', { location: '/' });
      }
      send(res, 404, page('Not found', '<p>Not found.</p>'));
    } catch (e) {
      log(`${req.method} ${url.pathname}: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, page('Error', '<p>Something went wrong.</p>'));
    }
  });
  return new Promise<any>((resolve) =>
    server.listen(cfg.port, () =>
      resolve({
        port: (server.address() as { port: number }).port,
        db,
        weekly: (id: number) => work.weekly(db.prepare('SELECT * FROM repos WHERE id = ?').get(id)),
        idle: () => new Promise<void>((r) => { const t = setInterval(() => !active && !queue.length && (clearInterval(t), r()), 50); }),
        close: () => (clearInterval(timer), db.close(), new Promise<void>((r) => server.close(() => r()))),
      }),
    ),
  );
}

// ---------- pages: server-rendered, no JavaScript
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (x: number) => x.toLocaleString('en-US');
const study: { study: { repos: number; url: string }; authors: Record<string, { deletedPer100: number }> } = createRequire(import.meta.url)('../src/baseline.json');

// One warm neutral hue (118, the hue of zomb's paper) for every grey, one green accent, and
// danger/warn kept to single hues so no series shouts louder than another.
const TOKENS = `
:root{
  --page:oklch(0.145 0.008 118);--side:oklch(0.195 0.009 118);--sidebar:oklch(0.175 0.008 118);
  --canvas:oklch(0.968 0.005 118);--bg:oklch(0.995 0.003 118);--shell:oklch(0.943 0.008 118);
  --line:oklch(0.915 0.008 118);--line-strong:oklch(0.86 0.01 118);
  --text:oklch(0.225 0.012 118);--muted:oklch(0.52 0.014 118);--faint:oklch(0.67 0.012 118);
  --hover:oklch(0.955 0.006 118);
  --accent:oklch(0.56 0.12 158);--accent-strong:oklch(0.49 0.11 158);--accent-ink:oklch(0.33 0.08 158);--accent-soft:oklch(0.94 0.035 158);
  --bad:oklch(0.551 0.168 32);--bad-ink:oklch(0.44 0.15 32);--bad-soft:oklch(0.94 0.045 32);
  --warn:oklch(0.562 0.117 78);--warn-soft:oklch(0.945 0.05 78);
  --ui-ease:cubic-bezier(0.2,0,0,1);--tab-ease:cubic-bezier(0.32,0.72,0,1);
  --display:'Bricolage Grotesque','Helvetica Neue',Arial,sans-serif;
  --ui:'IBM Plex Sans',ui-sans-serif,sans-serif;--mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
}
*{box-sizing:border-box;min-width:0}
html,body{height:100%}
body{margin:0;background:var(--page);color:var(--text);font:14px/1.45 var(--ui);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,h3{font-family:var(--display);margin:0;letter-spacing:-.03em;text-wrap:balance}
.mono{font-family:var(--mono)}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.faint{color:var(--faint)}
.kick{font:600 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
svg{display:block}
.btn{display:inline-flex;align-items:center;gap:7px;border:0;border-radius:10px;padding:9px 13px;font:600 13.5px/1 var(--ui);cursor:pointer;transition:background-color .16s var(--ui-ease),transform .16s var(--ui-ease),color .16s var(--ui-ease)}
.btn:active{transform:scale(.96)}
.btn.primary{background:var(--accent);color:oklch(0.99 0.01 158);box-shadow:inset 0 1px 0 oklch(1 0 0/.22),0 6px 18px oklch(0.56 0.12 158/.25)}
.btn.primary:hover{background:var(--accent-strong)}
.btn.ghost{background:transparent;color:var(--text);box-shadow:inset 0 0 0 1px var(--line-strong);font-weight:500;padding:7px 11px;font-size:13px;white-space:nowrap}
.btn.ghost:hover{background:var(--hover)}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}
`;

// The simple document: setup, sign-in, errors. A single floated card on the near-black page.
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · zomb</title>${FONTS}<style>${TOKENS}
.solo{min-height:100%;display:grid;place-items:center;padding:24px}
.solo-card{width:min(34rem,100%);background:var(--bg);border-radius:16px;padding:32px;box-shadow:0 1px 0 oklch(1 0 0/.05),0 12px 40px oklch(0 0 0/.35)}
.solo-card h1{font-size:34px;font-weight:800;margin-bottom:6px}
.solo-card p{margin:0 0 14px;color:var(--muted);max-width:46ch}
.solo-card a:not(.btn){text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-strong)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:20px}
</style></head><body><div class="solo"><div class="solo-card">${body}</div></div></body></html>`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@0,400;0,500;0,600&display=swap">`;

function landing(cfg: ReturnType<typeof config>) {
  return page('zomb', `<h1>zomb</h1><p>A health check on every pull request, trends across your repos, and a weekly clean-up handed to the agent your team already pays for.</p>
<div class="row"><a class="btn primary" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on GitHub</a><a href="/login">Sign in</a></div>`);
}

// ---------- the app shell: dark chrome around a light workspace
const MARK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V9a8 8 0 0 1 16 0v11l-2.7-2-2.6 2-2.7-2-2.6 2L4 20Z"/><path d="M9 10.5h.01M15 10.5h.01"/></svg>`;
const ICON: Record<string, string> = {
  shield: `<path d="M12 3.5 5 6v5.5c0 4 3 7.3 7 8.5 4-1.2 7-4.5 7-8.5V6l-7-2.5Z"/>`,
  box: `<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z"/><path d="M4 8.5 12 13l8-4.5M12 13v7"/>`,
  layers: `<path d="M12 4 4 8l8 4 8-4-8-4Z"/><path d="m4 13 8 4 8-4"/>`,
  scissors: `<path d="M7.5 7.5 20 20M20 4 9.5 14.5"/><circle cx="6" cy="18" r="2.3"/><circle cx="6" cy="6" r="2.3"/>`,
};
const ico = (name: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

const SHELL_CSS = `
.shell{display:grid;grid-template-columns:256px minmax(0,1fr);height:100%;max-height:100dvh;overflow:hidden}
.sidebar{background:var(--sidebar);color:oklch(0.97 0.006 118);display:flex;flex-direction:column;gap:22px;padding:18px 16px;overflow:hidden}
.brand{display:flex;align-items:center;gap:9px}
.brand span{font:800 20px/1 var(--display);letter-spacing:-.04em}
.brand small{font:500 10.5px/1 var(--mono);color:oklch(1 0 0/.4);letter-spacing:.06em;align-self:flex-end;padding-bottom:1px}
.nav{display:flex;flex-direction:column;gap:2px;margin-top:-6px}
.nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;border-radius:9px;padding:8px 10px;font-size:13.5px;color:oklch(1 0 0/.62);transition:background-color .16s var(--ui-ease),color .16s var(--ui-ease)}
.nav a:hover{background:oklch(1 0 0/.06);color:oklch(0.98 0.006 118)}
.nav a.on{background:oklch(1 0 0/.1);color:oklch(0.98 0.006 118);font-weight:600}
.nav a b{font:500 11.5px/1 var(--mono);color:oklch(1 0 0/.45)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:10px;font:11.5px/1.5 var(--mono);color:oklch(1 0 0/.4)}
.side-foot a{color:oklch(1 0 0/.6);text-decoration:underline;text-underline-offset:3px;text-decoration-color:oklch(1 0 0/.2)}
.container{height:100%;padding:10px;overflow:hidden}
.app{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;overflow:hidden;border-radius:16px;background:var(--side);box-shadow:0 1px 0 oklch(1 0 0/.05),0 12px 40px oklch(0 0 0/.35)}

.tabbar{display:flex;align-items:flex-end;gap:4px;padding:6px 10px 0 8px;background:var(--side);user-select:none;overflow:hidden}
.tab{position:relative;display:flex;align-items:center;gap:7px;height:36px;min-width:112px;max-width:240px;flex:0 1 auto;padding:0 13px;border-radius:12px 12px 0 0;font-size:13px;color:oklch(1 0 0/.55);white-space:nowrap;transition:color .16s var(--tab-ease)}
.tab b{font:500 11.5px/1 var(--mono);color:oklch(1 0 0/.38)}
.tab:not(.on)::before{content:'';position:absolute;inset:4px 4px 6px;border-radius:8px;background:transparent;transition:background-color .16s var(--tab-ease)}
.tab:not(.on):hover{color:oklch(0.97 0.006 118)}
.tab:not(.on):hover::before{background:oklch(1 0 0/.1)}
.tab.on{background:var(--canvas);color:var(--text);font-weight:600}
.tab.on b{color:var(--muted)}
/* the two inverse corners that tie the active tab into the workspace below it */
.tab.on::before,.tab.on::after{content:'';position:absolute;bottom:0;width:11px;height:11px}
.tab.on::before{left:-11px;background:radial-gradient(circle at 0 0,transparent 11px,var(--canvas) 11px)}
.tab.on::after{right:-11px;background:radial-gradient(circle at 100% 0,transparent 11px,var(--canvas) 11px)}
.chrome-spacer{flex:1 1 auto;min-width:10px}

.canvas{background:var(--canvas);border-radius:0 0 16px 16px;overflow:hidden;min-height:0}
.panes{--pane-inset:12px;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,352px);gap:var(--pane-inset);padding:var(--pane-inset);height:100%;overflow-y:auto}
.workspace,.side-pane{display:flex;flex-direction:column;gap:12px;min-width:0}

/* concentric hatch shell: hatched frame, 3px pad, inner card */
.hatch{--shell-pad:3px;--inner-r:14px;display:flex;flex-direction:column;padding:var(--shell-pad);border-radius:calc(var(--inner-r) + var(--shell-pad));
  background:repeating-linear-gradient(-45deg,oklch(0.78 0.012 118/.35) 0 1px,transparent 1px 5px),var(--shell);
  box-shadow:0 0 0 1px oklch(0 0 0/.05),0 1px 2px oklch(0 0 0/.03),0 6px 18px oklch(0 0 0/.06)}
.card{border-radius:var(--inner-r);background:var(--bg);box-shadow:inset 0 0 0 1px oklch(0 0 0/.05),inset 0 1px 2px oklch(0 0 0/.03),0 1px 0 oklch(1 0 0/.8);min-width:0}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px 10px}
.card-head h2{font-size:16.5px;font-weight:700}
.card-head p{margin:2px 0 0;font-size:12.5px;color:var(--muted)}

/* bento */
.bento{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;padding:6px}
.tile{grid-column:span 3;display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px 10px;border-radius:20px;overflow:hidden;background:var(--canvas)}
.tile-head{display:flex;align-items:center;gap:8px;min-width:0}
.tile-well{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:999px;background:var(--bg);color:var(--muted);box-shadow:inset 0 0 0 1px oklch(0 0 0/.05)}
.tile-head span{font-size:13.5px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-value{margin:0;font:700 28px/1 var(--ui);letter-spacing:-.04em;font-variant-numeric:tabular-nums;text-wrap:balance}
.tile-value small{font-size:.62em;font-weight:600;letter-spacing:-.02em;color:var(--muted)}
.tile-foot{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:3px;flex:none;border-radius:999px;padding:2px 7px;font:600 11.5px/1.3 var(--mono);font-variant-numeric:tabular-nums}
.pill.up{background:var(--accent-soft);color:var(--accent-ink)}
.pill.down{background:var(--bad-soft);color:var(--bad-ink)}
.pill.flat{background:var(--hover);color:var(--muted)}
.tile-foot em{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* table */
.table-wrap{overflow:auto;max-height:min(58vh,520px);border-radius:0 0 var(--inner-r) var(--inner-r)}
table{width:100%;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
thead th{position:sticky;top:0;z-index:1;background:var(--bg);font:600 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:right;padding:10px 12px;box-shadow:inset 0 -1px 0 var(--line)}
thead th:first-child{text-align:left}
tbody td{padding:12px;border-bottom:1px solid var(--line);text-align:right;font-size:13.5px;height:58px}
tbody tr:nth-child(odd) td{background:oklch(0.968 0.005 118/.55)}
tbody tr:last-child td{border-bottom:0}
tbody td:first-child{text-align:left;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.repo{font-weight:600;color:var(--text)}
.repo:hover{text-decoration:underline;text-underline-offset:3px}
.when{display:block;font:11.5px/1.5 var(--mono);color:var(--faint)}
td b{font-weight:600}
td b.bad{color:var(--bad-ink)}
td b.zero{color:var(--faint);font-weight:500}
.trend{display:inline-block;margin-left:10px;vertical-align:middle}

/* side pane */
.rows{display:flex;flex-direction:column;list-style:none;margin:0;padding:0}
.rows li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);min-width:0}
.rows li:last-child{border-bottom:0}
.rows div{min-width:0}
.rows strong{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rows span{font:11.5px/1.5 var(--mono);color:var(--faint)}
.bars{display:flex;flex-direction:column;gap:9px;padding:6px 14px 14px}
.bars div{display:grid;grid-template-columns:4.6rem 1fr 2rem;align-items:center;gap:9px;font-size:12.5px}
.bars i{height:7px;border-radius:3.5px;background:var(--line-strong);display:block}
.bars .you i{background:var(--accent)}
.bars .you{font-weight:600}
.bars b{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:34px 24px 36px}
.empty h2{font-size:19px;font-weight:700}
.empty p{margin:0;max-width:40ch;color:var(--muted);font-size:13.5px}
@media (max-width:1080px){.shell{grid-template-columns:minmax(0,1fr)}.sidebar{display:none}.panes{grid-template-columns:minmax(0,1fr)}.tile{grid-column:span 6}}
`;

const VIEWS: [string, string, (s: any) => boolean][] = [
  ['all', 'All repos', () => true],
  ['attention', 'Needs attention', (s) => Boolean(s && (s.security.high || s.blueprint)) ],
  ['clean', 'Clean', (s) => Boolean(s && !s.security.high && !s.blueprint)],
];

// A 12-point trend line. Higher is worse for everything shown here, so a rising line is red.
function spark(values: number[]) {
  if (values.length < 2 || !values.some(Boolean)) return '';
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 54 + 1},${15 - (v / max) * 12}`).join(' ');
  const [first, last] = [values[0], values.at(-1)!];
  const tone = last > first ? 'var(--bad)' : last < first ? 'var(--accent)' : 'var(--line-strong)';
  return `<svg class="trend" width="56" height="16" viewBox="0 0 56 16" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function dashboard(db: any, me: Session, cfg: ReturnType<typeof config>, view = 'all') {
  const repos = (db.prepare(`SELECT * FROM repos WHERE installation IN (${me.installations.map(() => '?').join(',') || 'NULL'}) ORDER BY name`).all(...me.installations) as any[]).map((r) => {
    const scans = (db.prepare("SELECT * FROM scans WHERE repo = ? AND kind != 'pr' ORDER BY id DESC LIMIT 12").all(r.id) as any[]).reverse().map((s) => ({ ...s, summary: JSON.parse(s.summary) }));
    return { ...r, scans, last: scans.at(-1)?.summary, prev: scans.at(-2)?.summary, at: scans.at(-1)?.at };
  });
  const scanned = repos.filter((r) => r.last);
  const counts = Object.fromEntries(VIEWS.map(([key, , match]) => [key, repos.filter((r) => match(r.last)).length]));
  const shown = (VIEWS.find(([k]) => k === view) || VIEWS[0])[2];

  // ---- bento: shares where there is a denominator, counts where a share would be invented
  const sum = (list: any[], pick: (s: any) => number) => list.reduce((n, r) => n + (pick(r) || 0), 0);
  // a share can never exceed its denominator, whatever a scan reports
  const share = (n: number, d: number) => (d ? Math.min(100, Math.round((n / d) * 100)) : 0);
  const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const highNow = sum(scanned, (r) => r.last.security.high);
  const highWas = sum(scanned.filter((r) => r.prev), (r) => r.prev.security.high);
  const cleanNow = share(scanned.filter((r) => !r.last.security.high).length, scanned.length);
  const withPrev = scanned.filter((r) => r.prev);
  const cleanWas = share(withPrev.filter((r) => !r.prev.security.high).length, withPrev.length);
  const deadNow = share(sum(scanned, (r) => r.last.zombie.lines), sum(scanned, (r) => r.last.lines));
  const deadWas = share(sum(withPrev, (r) => r.prev.zombie.lines), sum(withPrev, (r) => r.prev.lines));
  const deletes = median(scanned.map((r) => r.last.deletedPer100).filter((x: number | null) => x !== null));
  const humans = Math.round(study.authors.Human.deletedPer100);

  // a pill only appears once there is an earlier scan to compare with
  const pill = (now: number, was: number, higherIsBetter: boolean, unit = '') => {
    if (!withPrev.length) return '';
    const d = now - was;
    if (!d) return `<span class="pill flat">no change</span>`;
    const good = higherIsBetter ? d > 0 : d < 0;
    return `<span class="pill ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${num(Math.abs(d))}${unit}</span>`;
  };
  const tile = (icon: string, label: string, value: string, foot: string) =>
    `<div class="tile"><div class="tile-head"><span class="tile-well">${ico(icon)}</span><span>${esc(label)}</span></div>
      <p class="tile-value">${value}</p><div class="tile-foot">${foot}</div></div>`;
  const bento = scanned.length
    ? `<section class="hatch"><div class="card"><div class="bento">
${tile('shield', 'Repos clean', `${cleanNow}<small>%</small>`, `${pill(cleanNow, cleanWas, true, 'pts')}<em>${scanned.filter((r) => !r.last.security.high).length} of ${scanned.length} with no high findings</em>`)}
${tile('scissors', 'High security', num(highNow), `${pill(highNow, highWas, false)}<em>in ${num(scanned.filter((r) => r.last.security.high).length)} repos</em>`)}
${tile('box', 'Dead code', `${deadNow}<small>%</small>`, `${pill(deadNow, deadWas, false, 'pts')}<em>of ${num(sum(scanned, (r) => r.last.lines))} lines scanned</em>`)}
${tile('layers', 'Deleted per 100 added', deletes === null ? '–' : num(deletes), `<em>${deletes === null ? 'needs a year of history' : `humans in the study delete ${humans}`}</em>`)}
      </div></div></section>`
    : '';

  // ---- table, built for 100 rows: sticky head, long names truncate, numbers never do
  const figure = (r: any, pick: (s: any) => number, trend = true) => {
    if (!r.last) return '<td class="faint">–</td>';
    const v = pick(r.last) || 0;
    return `<td><b class="${v ? 'bad' : 'zero'}">${num(v)}</b>${trend ? spark(r.scans.map((s: any) => pick(s.summary) || 0)) : ''}</td>`;
  };
  const list = repos.filter((r) => shown(r.last));
  const rows = list
    .map(
      (r) => `<tr><td title="${esc(r.name)}"><a class="repo" href="${esc(cfg.web)}/${esc(r.name)}">${esc(r.name)}</a>
<span class="when">${r.at ? `scanned ${esc(String(r.at).slice(0, 10))}` : 'waiting for the first push'}</span></td>
${figure(r, (s) => s.security.high)}${figure(r, (s) => s.zombie.lines)}${figure(r, (s) => s.zombie.packages, false)}${figure(r, (s) => s.architecture.cycles + s.architecture.bigFiles, false)}${figure(r, (s) => s.blueprint || 0, false)}</tr>`,
    )
    .join('');
  const table = repos.length
    ? `<section class="hatch"><div class="card">
<div class="card-head"><div><h2>${esc((VIEWS.find(([k]) => k === view) || VIEWS[0])[1])}</h2><p>${num(list.length)} of ${num(repos.length)} repos. Figures are from the last scan of the default branch.</p></div></div>
${list.length ? `<div class="table-wrap"><table><thead><tr><th>Repo</th><th>High</th><th>Zombie lines</th><th>Packages</th><th>Architecture</th><th>Blueprint</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><h2>Nothing here</h2><p>No repo matches this view right now.</p><a class="btn ghost" href="/">Show all repos</a></div>`}
</div></section>`
    : `<section class="hatch"><div class="card"><div class="empty"><h2>No repos yet</h2>
<p>Install the app on a repository, then push to its default branch. The first scan lands within a minute and the trends build from there.</p>
<a class="btn primary" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on a repo</a></div></div></section>`;

  // ---- side pane: the weekly clean-up, and where these repos sit against the study
  const weekly = repos.length
    ? `<section class="hatch"><div class="card"><div class="card-head"><div><h2>Weekly clean-up</h2><p>One issue per repo, handed to your agent.</p></div></div>
<ul class="rows">${repos
        .slice(0, 8)
        .map(
          (r) => `<li><div><strong title="${esc(r.name)}">${esc(r.name.split('/')[1] || r.name)}</strong>
<span>${r.weekly_at ? `ran ${esc(String(r.weekly_at).slice(0, 10))}` : 'runs within the week'}</span></div>
<form method="post" action="/repos/${r.id}/copilot"><button class="btn ghost">Hand to Copilot</button></form></li>`,
        )
        .join('')}</ul></div></section>`
    : '';
  const bars = [{ name: 'your repos', v: deletes, you: true }, ...Object.entries(study.authors).map(([name, a]) => ({ name: name === 'Human' ? 'humans' : name.toLowerCase(), v: Math.round(a.deletedPer100), you: false }))]
    .filter((b) => b.v !== null)
    .sort((a, b) => (b.v as number) - (a.v as number));
  const max = Math.max(...bars.map((b) => b.v as number), 1);
  const studyShell = `<section class="hatch"><div class="card"><div class="card-head"><div><h2>Deleted per 100 added</h2><p>Against ${num(study.study.repos)} public repos measured the same way.</p></div></div>
<div class="bars">${bars.map((b) => `<div class="${b.you ? 'you' : ''}"><span>${esc(b.name)}</span><i style="width:${Math.round(((b.v as number) / max) * 100)}%"></i><b>${b.v}</b></div>`).join('')}</div></div></section>`;

  const tabs = VIEWS.map(([key, label]) => `<a class="tab${key === view ? ' on' : ''}" href="${key === 'all' ? '/' : `/?view=${key}`}">${esc(label)} <b>${num(counts[key])}</b></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repos · zomb</title>${FONTS}<style>${TOKENS}${SHELL_CSS}</style></head><body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">${MARK}<span>zomb</span><small>CLOUD</small></div>
    <nav class="nav">
      <a class="on" href="/">Repos <b>${num(repos.length)}</b></a>
      <a href="/?view=attention">Needs attention <b>${num(counts.attention)}</b></a>
    </nav>
    <a class="btn primary" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Add repos</a>
    <div class="side-foot"><span>${esc(me.login)} · <a href="/logout">sign out</a></span><span><a href="${esc(study.study.url)}">the study</a></span></div>
  </aside>
  <div class="container"><div class="app">
    <div class="tabbar">${tabs}<span class="chrome-spacer"></span></div>
    <div class="canvas"><div class="panes">
      <main class="workspace">${bento}${table}</main>
      <aside class="side-pane">${weekly}${studyShell}</aside>
    </div></div>
  </div></div>
</div></body></html>`;
}

// Create the GitHub App from a manifest: one click on GitHub, and the credentials come back here.
function setupPage(cfg: ReturnType<typeof config>, ready: boolean) {
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
