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
//
// ZOMB SPEC SHEET — the design rules this dashboard follows
//
//   1. LIGHT GROUND. The same warm paper as the HTML report and the site, so the three
//      surfaces read as one product rather than three.
//   2. COLOUR IS SEVERITY, NEVER DECORATION. Ink is the only brand fill; red, amber and
//      green mean exactly what they mean in the CLI. Nothing is saturated to look nice.
//   3. RULES ARE THE STRUCTURE. zomb's own output draws a section as a rule with a label
//      on the left and a count on the right. That device is promoted from the terminal and
//      carries the whole layout: hairlines, never shadows; one radius; no cards, no frames.
//
// Display sits at 500–600, not 700, and running text recedes from headings.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (x: number) => x.toLocaleString('en-US');
const study: { study: { repos: number; url: string }; authors: Record<string, { deletedPer100: number }> } = createRequire(import.meta.url)('../src/baseline.json');

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">`;

// The house system, shared with the landing page: paper ground, one saturated accent used
// structurally, hairline panels at 14px with registration marks, mono chapter headers that
// state their position, and one surface with ruled rows instead of a grid of cards.
const TOKENS = `
:root{
  --paper:#F4F4F2; --surface:#FFF; --sunk:#EEEEE9;
  --line:#E4E4DE; --line-2:#CBCBC3;
  --ink:#111110; --body:#55554F; --mute:#6C6C66;
  --accent:#0F8F55; --accent-fill:#0C7A48; --accent-ink:#0A6B3F; --accent-sub:#E4F3EA;
  --night:#131311; --night-2:#1C1C19; --night-line:#302F2B; --night-ink:#F3F3ED; --night-mute:#8B8B81;
  --high:#C3223D; --high-sub:#FBE7EA; --warn:#9A6400; --warn-sub:#FFF8E8;
  --sans:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-sm:10px; --r:14px;
  --pad:clamp(18px,4vw,52px);
  --lift-sm:0 1px 2px rgba(17,17,16,.05),0 2px 8px rgba(17,17,16,.04);
  --ease:cubic-bezier(.4,0,.2,1);
}
*{box-sizing:border-box;min-width:0}
body{margin:0;background:var(--paper);color:var(--body);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
h1,h2,h3{margin:0;color:var(--ink);font-weight:500;letter-spacing:-.03em;line-height:1.1;text-wrap:balance}
h1{font-size:clamp(2.2rem,5vw,3.2rem);letter-spacing:-.04em}
h3{font-size:1.0625rem;font-weight:600;letter-spacing:-.015em}
p{margin:0;text-wrap:pretty}
a{color:inherit;text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding:0 var(--pad)}
.eyebrow{font:500 10.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.num{font-variant-numeric:tabular-nums}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;font:600 14px/1 var(--sans);
  padding:12px 20px;min-height:44px;border:1px solid transparent;cursor:pointer;
  transition:transform .15s var(--ease),box-shadow .15s var(--ease),background-color .15s var(--ease),border-color .15s var(--ease)}
.btn-p{background:var(--accent-fill);color:#fff;box-shadow:0 2px 10px rgba(15,143,85,.26)}
.btn-p:hover{background:var(--accent-ink);transform:translateY(-1px)}
.btn-g{background:var(--surface);color:var(--ink);border-color:var(--line-2);min-height:36px;padding:8px 14px;font-size:13px;white-space:nowrap}
.btn-g:hover{border-color:var(--ink)}
/* panel: hairline, 14px, registration marks drawn without extra DOM */
.panel{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:22px 24px}
.marked::before{content:"";position:absolute;inset:9px;pointer-events:none;background-size:5px 5px;background-repeat:no-repeat;
  background-position:0 0,100% 0,0 100%,100% 100%;
  background-image:linear-gradient(var(--line-2),var(--line-2)),linear-gradient(var(--line-2),var(--line-2)),linear-gradient(var(--line-2),var(--line-2)),linear-gradient(var(--line-2),var(--line-2))}
.panel>*{position:relative}
/* chapter header: mark, name, a rule to the edge, the count */
.chap{display:flex;align-items:center;gap:11px;margin:40px 0 16px;font:500 11px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase}
.chap-mark{width:12px;height:12px;flex:none;color:var(--accent)}
.chap-label{color:var(--ink);white-space:nowrap}
.chap-rule{flex:1 1 auto;min-width:20px;height:1px;background:var(--line-2)}
.chap-n{flex:none;color:var(--mute);letter-spacing:.1em;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
`;

const MARK = `<svg class="chap-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="7" height="7"/><rect x="17" y="0" width="7" height="7"/><rect x="0" y="17" width="7" height="7"/><rect x="17" y="17" width="7" height="7"/></svg>`;
const LOGO = `<svg class="logo-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="6" height="6"/><rect x="11" y="2" width="6" height="6"/><rect x="2" y="11" width="6" height="6"/><rect x="11" y="11" width="6" height="6" opacity=".35"/><rect x="2" y="20" width="15" height="2"/></svg>`;
const chap = (label: string, count: string) =>
  `<div class="chap">${MARK}<span class="chap-label">${esc(label)}</span><span class="chap-rule"></span><span class="chap-n">${esc(count)}</span></div>`;

// The simple document: sign-in, setup, errors.
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · zomb</title>${FONTS}<style>${TOKENS}
.solo{min-height:100dvh;display:grid;place-items:center;padding:40px var(--pad)}
.solo-in{width:min(36rem,100%);display:flex;flex-direction:column;gap:14px}
.solo-in p{max-width:52ch}
.solo-in a:not(.btn){text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-2)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:10px}
</style></head><body><div class="solo"><div class="solo-in">${body}</div></div></body></html>`;

function landing(cfg: ReturnType<typeof config>) {
  return page('zomb', `<p class="eyebrow">zomb cloud</p><h1>A health check on every pull request.</h1>
<p>Trends across your repos, and a weekly clean-up handed to the agent your team already pays for.</p>
<div class="row"><a class="btn btn-p" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on GitHub</a><a href="/login">Sign in</a></div>`);
}

const DASH_CSS = `
.nav{position:sticky;top:14px;z-index:90;padding:0 var(--pad);margin-top:22px}
.nav-in{max-width:1180px;margin:0 auto;height:58px;display:flex;align-items:center;gap:18px;padding:0 10px 0 18px;
  background:rgba(255,255,255,.78);backdrop-filter:saturate(150%) blur(10px);-webkit-backdrop-filter:saturate(150%) blur(10px);
  border:1px solid var(--line);border-radius:999px;box-shadow:var(--lift-sm)}
.logo{display:flex;align-items:center;gap:10px;color:var(--ink)}
.logo-mark{width:22px;height:22px;flex:none;color:var(--accent)}
.logo-word{font-size:21px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;line-height:1}
.logo small{font:500 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--mute);align-self:flex-end;padding-bottom:2px}
.nav .who{margin-left:auto;display:flex;align-items:center;gap:16px;font:11px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--mute)}
.nav .who a:hover{color:var(--ink)}
@media(max-width:720px){.nav .who span:first-child{display:none}}

/* views: pill segmented control, the house's own control shape */
.views{display:flex;gap:6px;margin:30px 0 0;padding:4px;background:var(--sunk);border:1px solid var(--line);border-radius:999px;width:max-content;max-width:100%;overflow-x:auto;scrollbar-width:none}
.views a{display:flex;align-items:baseline;gap:7px;padding:9px 16px;border-radius:999px;font-size:13.5px;color:var(--mute);white-space:nowrap;transition:background-color .15s var(--ease),color .15s var(--ease)}
.views a b{font:500 11px/1 var(--mono);color:var(--line-2)}
.views a:hover{color:var(--ink)}
.views a.on{background:var(--surface);color:var(--ink);font-weight:600;box-shadow:var(--lift-sm)}
.views a.on b{color:var(--mute)}
main{padding-bottom:72px}

/* figures: one surface, hairline dividers, caption under the number */
.figs{display:grid;grid-template-columns:repeat(4,1fr);background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.fig{padding:22px 24px;border-left:1px solid var(--line)}
.fig:first-child{border-left:0}
.fig .n{font-size:2rem;font-weight:500;letter-spacing:-.038em;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums}
.fig .n u{text-decoration:none;font-size:.5em;color:var(--mute);margin-left:2px}
.fig .k{margin-top:11px;font:500 9.5px/1.5 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--mute)}
.fig .f{margin-top:7px;font-size:12.5px;color:var(--mute);line-height:1.45}
.delta{font-variant-numeric:tabular-nums;font-weight:500}
.delta.better{color:var(--accent-ink)}.delta.worse{color:var(--high)}.delta.same{color:var(--line-2)}
@media(max-width:900px){.figs{grid-template-columns:1fr 1fr}.fig:nth-child(3){border-left:0}.fig:nth-child(n+3){border-top:1px solid var(--line)}}
@media(max-width:560px){.figs{grid-template-columns:1fr}.fig{border-left:0}.fig+.fig{border-top:1px solid var(--line)}}

/* the fleet: one surface, rows ruled inside it — not a box of boxes */
.fleet{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.scroll{overflow:auto;max-height:min(62vh,580px)}
table{width:100%;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
thead th{position:sticky;top:0;z-index:2;background:var(--sunk);text-align:right;padding:11px 16px;
  font:500 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--mute);
  box-shadow:inset 0 -1px 0 var(--line);white-space:nowrap}
thead th.gut{width:28px;padding:0}
thead th.nm{text-align:left;padding-left:22px;width:32%}
thead th.act{width:10rem}
thead th:last-child{padding-right:22px}
tbody td{padding:14px 16px;border-bottom:1px solid var(--line);text-align:right;font-size:14px;color:var(--ink);white-space:nowrap}
tbody td.gut{width:28px;padding:0 0 0 12px}
tbody td.gut span{display:block;width:4px;height:26px;border-radius:2px}
tbody td.nm{text-align:left;padding-left:10px;max-width:0;overflow:hidden;text-overflow:ellipsis}
tbody td:last-child{padding-right:22px}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--paper)}
.repo{font-weight:600;color:var(--ink)}
.repo:hover{text-decoration:underline;text-underline-offset:3px}
.when{display:block;font:11px/1.5 var(--mono);color:var(--mute)}
td .zero{color:var(--line-2)}
td .hit{color:var(--high);font-weight:600}
td .warn{color:var(--warn);font-weight:600}
/* one quiet action per row: 24 bordered buttons shout louder than the data */
.handoff{background:none;border:0;padding:0;font:500 13px/1 var(--sans);color:var(--mute);cursor:pointer;white-space:nowrap;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-2);transition:color .15s var(--ease)}
.handoff:hover{color:var(--ink);text-decoration-color:currentColor}
.trend{display:inline-block;margin-left:9px;vertical-align:middle}
.act{display:flex;justify-content:flex-end}

/* the study, on the night ground — the same band the landing page uses */
.band{background:var(--night);border-radius:var(--r);padding:26px 28px;color:var(--night-mute)}
.band .chap{margin-top:0}
.band .chap-label{color:var(--night-ink)}
.band .chap-rule{background:var(--night-line)}
.band .chap-n{color:var(--night-mute)}
.band p{max-width:60ch;font-size:13.5px}
.band table{margin-top:18px}
.band td{padding:11px 0;border-bottom:1px solid var(--night-line);font-size:14px;color:var(--night-ink);text-align:left}
.band td:last-child{text-align:right;padding-right:0}
.band tr:last-child td{border-bottom:0}
.band .bar{display:inline-block;height:6px;border-radius:3px;background:var(--night-line);vertical-align:middle;margin-right:12px}
.band .me td{color:#fff;font-weight:600}
.band .me .bar{background:var(--accent)}

.empty{padding:44px 24px 48px;display:flex;flex-direction:column;align-items:flex-start;gap:12px}
.empty p{max-width:46ch;color:var(--mute);font-size:14px}
footer{border-top:1px solid var(--line);margin-top:56px;padding:24px 0 56px}
footer .wrap{display:flex;flex-wrap:wrap;gap:6px 22px;font:11px/1.8 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--mute)}
footer a:hover{color:var(--ink)}
`;

const VIEWS: [string, string, (s: any) => boolean][] = [
  ['all', 'All repos', () => true],
  ['attention', 'Needs attention', (s) => Boolean(s && (s.security.high || s.blueprint))],
  ['clean', 'Clean', (s) => Boolean(s && !s.security.high && !s.blueprint)],
];

// A 12-point trend. Higher is worse for everything shown, so a rising line is the alarm colour.
function spark(values: number[]) {
  if (values.length < 2 || !values.some(Boolean)) return '';
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 52 + 1},${13 - (v / max) * 11}`).join(' ');
  const [first, last] = [values[0], values.at(-1)!];
  const tone = last > first ? 'var(--high)' : last < first ? 'var(--accent)' : 'var(--line-2)';
  return `<svg class="trend" width="54" height="14" viewBox="0 0 54 14" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Your repos placed on the study's scale, as the bar table the landing page uses. */
export function field(yours: number | null, authors: Record<string, { deletedPer100: number }>) {
  const rows = [
    ...Object.entries(authors).map(([name, a]) => ({ name: name === 'Human' ? 'Humans' : name, v: Math.round(a.deletedPer100), you: false })),
    ...(yours === null ? [] : [{ name: 'Your repos', v: yours, you: true }]),
  ].sort((a, b) => b.v - a.v);
  const max = Math.max(...rows.map((r) => r.v), 1);
  return `<table><tbody>${rows
    .map((r) => `<tr class="${r.you ? 'me' : ''}"><td>${esc(r.name)}</td><td><span class="bar" style="width:${Math.round((r.v / max) * 120)}px"></span>${r.v}</td></tr>`)
    .join('')}</tbody></table>`;
}

function dashboard(db: any, me: Session, cfg: ReturnType<typeof config>, view = 'all') {
  const repos = (db.prepare(`SELECT * FROM repos WHERE installation IN (${me.installations.map(() => '?').join(',') || 'NULL'}) ORDER BY name`).all(...me.installations) as any[]).map((r) => {
    const scans = (db.prepare("SELECT * FROM scans WHERE repo = ? AND kind != 'pr' ORDER BY id DESC LIMIT 12").all(r.id) as any[]).reverse().map((s) => ({ ...s, summary: JSON.parse(s.summary) }));
    return { ...r, scans, last: scans.at(-1)?.summary, prev: scans.at(-2)?.summary, at: scans.at(-1)?.at };
  });
  const scanned = repos.filter((r) => r.last);
  const withPrev = scanned.filter((r) => r.prev);
  const counts = Object.fromEntries(VIEWS.map(([key, , match]) => [key, repos.filter((r) => match(r.last)).length]));
  const [, viewLabel, shown] = VIEWS.find(([k]) => k === view) || VIEWS[0];

  const sum = (list: any[], pick: (s: any) => number) => list.reduce((n, r) => n + (pick(r) || 0), 0);
  // a share can never exceed its denominator, whatever a scan reports
  const share = (n: number, d: number) => (d ? Math.min(100, Math.round((n / d) * 100)) : 0);
  const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const cleanRepos = scanned.filter((r) => !r.last.security.high).length;
  const cleanNow = share(cleanRepos, scanned.length);
  const cleanWas = share(withPrev.filter((r) => !r.prev.security.high).length, withPrev.length);
  const highNow = sum(scanned, (r) => r.last.security.high);
  const highWas = sum(withPrev, (r) => r.prev.security.high);
  const deadNow = share(sum(scanned, (r) => r.last.zombie.lines), sum(scanned, (r) => r.last.lines));
  const deadWas = share(sum(withPrev, (r) => r.prev.zombie.lines), sum(withPrev, (r) => r.prev.lines));
  const deletes = median(scanned.map((r) => r.last.deletedPer100).filter((x: number | null) => x !== null));
  const humans = Math.round(study.authors.Human.deletedPer100);

  // a delta only appears once there is an earlier scan to compare with
  const delta = (now: number, was: number, higherIsBetter: boolean, unit = '') => {
    if (!withPrev.length) return '';
    const d = now - was;
    if (!d) return `<span class="delta same">no change</span>`;
    return `<span class="delta ${(higherIsBetter ? d > 0 : d < 0) ? 'better' : 'worse'}">${d > 0 ? '+' : '−'}${num(Math.abs(d))}${unit}</span>`;
  };
  const fig = (value: string, label: string, foot: string) =>
    `<div class="fig"><p class="n">${value}</p><p class="k">${esc(label)}</p><p class="f">${foot}</p></div>`;

  const figures = scanned.length
    ? `<div class="figs">
${fig(`${cleanNow}<u>%</u>`, 'Repos clean', `${delta(cleanNow, cleanWas, true, 'pts')} · ${num(cleanRepos)} of ${num(scanned.length)} with no high findings`)}
${fig(num(highNow), 'High security', `${delta(highNow, highWas, false)} · across ${num(scanned.filter((r) => r.last.security.high).length)} repos`)}
${fig(`${deadNow}<u>%</u>`, 'Dead code', `${delta(deadNow, deadWas, false, 'pts')} · of ${num(sum(scanned, (r) => r.last.lines))} lines`)}
${fig(deletes === null ? '—' : num(deletes), 'Deleted per 100 added', deletes === null ? 'needs a year of history' : `humans in the study delete ${humans}`)}
</div>`
    : '';

  // built for 100 rows: sticky head, long names truncate with a tooltip, numbers never do
  // colour is severity: only a high finding earns the alarm, the rest are plain figures
  const cell = (r: any, pick: (s: any) => number, { trend = false, tone = '' } = {}) => {
    if (!r.last) return '<td><span class="zero">—</span></td>';
    const v = pick(r.last) || 0;
    return `<td><span class="${v ? tone : 'zero'}">${num(v)}</span>${trend ? spark(r.scans.map((s: any) => pick(s.summary) || 0)) : ''}</td>`;
  };
  const list = repos.filter((r) => shown(r.last));
  const rows = list
    .map((r) => {
      // the gutter carries each repo's worst finding, so scrolling the fleet maps the damage
      const tick = !r.last ? 'transparent' : r.last.security.high ? 'var(--high)' : r.last.blueprint ? 'var(--warn)' : r.last.zombie.lines ? 'var(--line-2)' : 'var(--accent)';
      return `<tr><td class="gut"><span style="background:${tick}"></span></td>
<td class="nm" title="${esc(r.name)}"><a class="repo" href="${esc(cfg.web)}/${esc(r.name)}">${esc(r.name)}</a>
<span class="when">${r.at ? `scanned ${esc(String(r.at).slice(0, 10))}` : 'waiting for the first push'}${r.weekly_at ? ` · cleaned ${esc(String(r.weekly_at).slice(0, 10))}` : ''}</span></td>
${cell(r, (s) => s.security.high, { trend: true, tone: 'hit' })}${cell(r, (s) => s.zombie.lines, { trend: true })}${cell(r, (s) => s.zombie.packages)}${cell(r, (s) => s.architecture.cycles + s.architecture.bigFiles)}${cell(r, (s) => s.blueprint || 0, { tone: 'warn' })}
<td><div class="act"><form method="post" action="/repos/${r.id}/copilot"><button class="handoff">Hand to Copilot</button></form></div></td></tr>`;
    })
    .join('');

  const fleet = !repos.length
    ? `<div class="fleet"><div class="empty"><h3>No repos yet</h3><p>Install the app on a repository, then push to its default branch. The first scan lands within a minute and the trends build from there.</p>
<a class="btn btn-p" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on a repo</a></div></div>`
    : !list.length
      ? `<div class="fleet"><div class="empty"><h3>Nothing in this view</h3><p>No repo is ${esc(viewLabel.toLowerCase())} right now.</p><a class="btn btn-g" href="/">Show all repos</a></div></div>`
      : `<div class="fleet"><div class="scroll"><table><thead><tr><th class="gut"></th><th class="nm">Repo</th><th>High</th><th>Zombie lines</th><th>Packages</th><th>Architecture</th><th>Blueprint</th><th class="act">Weekly clean-up</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;

  const views = VIEWS.map(([key, label]) => `<a class="${key === view ? 'on' : ''}" href="${key === 'all' ? '/' : `/?view=${key}`}">${esc(label)} <b>${num(counts[key])}</b></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repos · zomb</title>${FONTS}<style>${TOKENS}${DASH_CSS}</style></head><body>
<nav class="nav"><div class="nav-in">
  <a class="logo" href="/">${LOGO}<span class="logo-word">zomb</span><small>cloud</small></a>
  <span class="who"><span>${esc(me.login)}</span><a href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">add repos</a><a href="/logout">sign out</a></span>
</div></nav>
<main class="wrap">
  <div class="views">${views}</div>
  ${scanned.length ? `${chap('Standing', `${num(scanned.length)} scanned`)}${figures}` : ''}
  ${chap(viewLabel, `${num(list.length)} of ${num(repos.length)}`)}
  ${fleet}
  ${scanned.length ? `<div class="band" style="margin-top:40px">${chap('The field', `${num(study.study.repos)} public repos`)}
  <p>Lines deleted for every 100 added since October 2025, measured the same way in your repos and in the study.</p>
  ${field(deletes, study.authors)}</div>` : ''}
</main>
<footer><div class="wrap"><span>zomb cloud</span><a href="${esc(study.study.url)}">the study</a><a href="https://github.com/Open-Dev-Society/zomb">docs</a></div></footer>
</body></html>`;
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
