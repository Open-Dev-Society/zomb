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

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@0,400;0,500;0,600&display=swap">`;

const TOKENS = `
:root{
  --paper:#f4f5f1;      /* page ground, the report's paper */
  --surface:#fbfbf9;    /* the one lighter plane: table head, inert strips */
  --ink:#16191b;        /* headings and figures */
  --body:#44494b;       /* running text, recedes from headings */
  --mute:#6a7073;       /* labels, captions, units */
  --faint:#9aa0a2;      /* zeros and absent values */
  --line:#e2e3dd;       /* hairline */
  --line-2:#cfd1c9;     /* stronger divider */
  --high:#c0402a; --high-sub:#fbe9e4;
  --warn:#9a6b00; --warn-sub:#fdf3dd;
  --good:#1d7a4f; --good-sub:#e6f3eb;
  --radius:4px;
  --display:'Bricolage Grotesque',ui-sans-serif,sans-serif;
  --ui:'IBM Plex Sans',ui-sans-serif,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  --ease:cubic-bezier(.2,0,0,1);
  --gutter:clamp(16px,4vw,40px);
}
*{box-sizing:border-box;min-width:0}
body{margin:0;background:var(--paper);color:var(--body);font:15px/1.6 var(--ui);-webkit-font-smoothing:antialiased}
h1,h2,h3{margin:0;font-family:var(--display);font-weight:600;color:var(--ink);letter-spacing:-.028em;line-height:1.1;text-wrap:balance}
a{color:inherit;text-decoration:none}
.num{font-variant-numeric:tabular-nums}
/* the one uppercase style in the system: mono, 10.5px, wide */
.eyebrow{font:500 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.13em;color:var(--mute)}
.btn{display:inline-flex;align-items:center;gap:7px;border:0;border-radius:var(--radius);padding:9px 14px;font:600 13.5px/1 var(--ui);cursor:pointer;background:var(--ink);color:var(--paper);transition:opacity .15s var(--ease),transform .15s var(--ease)}
.btn:hover{opacity:.86}
.btn:active{transform:scale(.97)}
.btn.quiet{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-2);font-weight:500;padding:7px 11px;font-size:13px;white-space:nowrap}
.btn.quiet:hover{background:var(--surface);opacity:1}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
`;

// The simple document: sign-in, setup, errors. Same ground, no ornament.
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · zomb</title>${FONTS}<style>${TOKENS}
.solo{min-height:100dvh;display:flex;flex-direction:column;justify-content:center;gap:14px;max-width:34rem;margin:0 auto;padding:40px var(--gutter)}
.solo h1{font-size:40px;letter-spacing:-.04em}
.solo p{margin:0;max-width:52ch}
.solo a:not(.btn){text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-2)}
.solo .row{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:8px}
</style></head><body><div class="solo">${body}</div></body></html>`;

function landing(cfg: ReturnType<typeof config>) {
  return page('zomb', `<p class="eyebrow">zomb cloud</p><h1>A health check on every pull request.</h1>
<p>Trends across your repos, and a weekly clean-up handed to the agent your team already pays for.</p>
<div class="row"><a class="btn" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on GitHub</a><a href="/login">Sign in</a></div>`);
}

const DASH_CSS = `
.bar{display:flex;align-items:center;gap:16px;padding:14px var(--gutter);border-bottom:1px solid var(--line);background:var(--paper);position:sticky;top:0;z-index:3}
.bar .word{font:600 19px/1 var(--display);letter-spacing:-.045em;color:var(--ink)}
.bar .sep{width:1px;height:18px;background:var(--line-2)}
.bar .who{margin-left:auto;display:flex;align-items:center;gap:14px;font:12.5px/1 var(--mono);color:var(--mute)}
.bar .who a{text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-2)}

/* views: text tabs on a rule, the active one marked by ink, not a pill */
.views{display:flex;gap:26px;padding:0 var(--gutter);border-bottom:1px solid var(--line);overflow-x:auto}
.views a{position:relative;display:flex;align-items:baseline;gap:7px;padding:13px 0 12px;font-size:13.5px;color:var(--mute);white-space:nowrap;transition:color .15s var(--ease)}
.views a b{font:500 11.5px/1 var(--mono);color:var(--faint)}
.views a:hover{color:var(--ink)}
.views a.on{color:var(--ink);font-weight:600}
.views a.on b{color:var(--mute)}
.views a.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--ink)}

/* the section rule, promoted from the terminal: label left, count right */
.rule{display:flex;align-items:baseline;gap:14px;padding:30px var(--gutter) 0}
.rule::after{content:"";flex:1 1 auto;height:1px;background:var(--line);transform:translateY(-3px)}
.rule h2{font-size:14.5px;letter-spacing:-.01em}
.rule .count{font:500 11.5px/1 var(--mono);color:var(--mute);font-variant-numeric:tabular-nums;white-space:nowrap}
.note{margin:6px 0 0;padding:0 var(--gutter);font-size:13px;color:var(--mute);max-width:70ch}

/* figures: one ruled row, divided by hairlines — no boxes, no shadows */
.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:18px 0 4px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--surface)}
.fig{padding:16px var(--gutter);border-left:1px solid var(--line);display:flex;flex-direction:column;gap:9px;min-width:0}
.fig:first-child{border-left:0}
.fig .eyebrow{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fig .v{font:500 38px/1 var(--display);letter-spacing:-.045em;color:var(--ink);font-variant-numeric:tabular-nums}
.fig .v u{text-decoration:none;font-size:.5em;letter-spacing:-.02em;color:var(--mute);margin-left:1px}
.fig .foot{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px;color:var(--mute)}
.fig .foot em{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.delta{flex:none;font:500 11.5px/1 var(--mono);font-variant-numeric:tabular-nums}
.delta.better{color:var(--good)}.delta.worse{color:var(--high)}.delta.same{color:var(--faint)}

/* table: hairline rows, numbers right, nothing else */
.scroll{overflow:auto;max-height:min(62vh,560px);border-top:1px solid var(--line);margin-top:18px}
table{width:100%;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
thead th{position:sticky;top:0;z-index:2;background:var(--surface);text-align:right;padding:9px var(--gutter) 9px 14px;font:500 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.13em;color:var(--mute);box-shadow:inset 0 -1px 0 var(--line);white-space:nowrap}
thead th:first-child{text-align:left;padding-left:var(--gutter)}
thead th:last-child{padding-right:var(--gutter)}
tbody td{padding:13px var(--gutter) 13px 14px;border-bottom:1px solid var(--line);text-align:right;font-size:14px;color:var(--ink)}
tbody td:first-child{text-align:left;padding-left:var(--gutter);max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tbody td:last-child{padding-right:var(--gutter)}
tbody tr:hover td{background:var(--surface)}
.repo{font-weight:600;color:var(--ink)}
.repo:hover{text-decoration:underline;text-underline-offset:3px}
.when{display:block;font:11.5px/1.5 var(--mono);color:var(--faint)}
td .zero{color:var(--faint)}
td .hit{color:var(--high);font-weight:600}
.trend{display:inline-block;margin-left:9px;vertical-align:middle}
.act{display:flex;justify-content:flex-end}

/* the study strip: bars drawn on the rule, your repos in ink */
.bars{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:18px}
.bars div{padding:14px var(--gutter);border-left:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.bars div:first-child{border-left:0}
.bars span{font:500 11.5px/1 var(--mono);color:var(--mute);text-transform:lowercase}
.bars b{font:500 22px/1 var(--display);letter-spacing:-.04em;color:var(--ink);font-variant-numeric:tabular-nums}
.bars i{display:block;height:3px;background:var(--line-2)}
.bars .you span,.bars .you b{color:var(--ink)}
.bars .you span{font-weight:600}
.bars .you i{background:var(--ink)}

.empty{padding:44px var(--gutter) 52px;display:flex;flex-direction:column;align-items:flex-start;gap:12px;border-top:1px solid var(--line);margin-top:18px}
.empty h3{font-size:19px}
.empty p{margin:0;max-width:46ch;color:var(--mute);font-size:14px}
footer{padding:28px var(--gutter) 40px;font:12.5px/1.6 var(--mono);color:var(--faint);display:flex;flex-wrap:wrap;gap:6px 20px}
footer a{text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-2)}
@media (max-width:860px){.figures{grid-template-columns:repeat(2,minmax(0,1fr))}.fig:nth-child(3){border-left:0}.fig:nth-child(n+3){border-top:1px solid var(--line)}}
@media (max-width:560px){.figures{grid-template-columns:minmax(0,1fr)}.fig{border-left:0}.fig+.fig{border-top:1px solid var(--line)}}
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
  const tone = last > first ? 'var(--high)' : last < first ? 'var(--good)' : 'var(--line-2)';
  return `<svg class="trend" width="54" height="14" viewBox="0 0 54 14" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
    const good = higherIsBetter ? d > 0 : d < 0;
    return `<span class="delta ${good ? 'better' : 'worse'}">${d > 0 ? '+' : '−'}${num(Math.abs(d))}${unit}</span>`;
  };
  const fig = (label: string, value: string, foot: string) =>
    `<div class="fig"><p class="eyebrow">${esc(label)}</p><p class="v">${value}</p><div class="foot">${foot}</div></div>`;

  const figures = scanned.length
    ? `<div class="figures">
${fig('Repos clean', `${cleanNow}<u>%</u>`, `${delta(cleanNow, cleanWas, true, 'pts')}<em>${num(cleanRepos)} of ${num(scanned.length)} with no high findings</em>`)}
${fig('High security', num(highNow), `${delta(highNow, highWas, false)}<em>across ${num(scanned.filter((r) => r.last.security.high).length)} repos</em>`)}
${fig('Dead code', `${deadNow}<u>%</u>`, `${delta(deadNow, deadWas, false, 'pts')}<em>of ${num(sum(scanned, (r) => r.last.lines))} lines</em>`)}
${fig('Deleted per 100 added', deletes === null ? '—' : num(deletes), `<em>${deletes === null ? 'needs a year of history' : `humans in the study delete ${humans}`}</em>`)}
</div>`
    : '';

  // table built for 100 rows: sticky head, long names truncate with a tooltip, numbers never do
  const figure = (r: any, pick: (s: any) => number, trend = true) => {
    if (!r.last) return '<td><span class="zero">—</span></td>';
    const v = pick(r.last) || 0;
    return `<td><span class="${v ? 'hit' : 'zero'}">${num(v)}</span>${trend ? spark(r.scans.map((s: any) => pick(s.summary) || 0)) : ''}</td>`;
  };
  const list = repos.filter((r) => shown(r.last));
  const rows = list
    .map(
      (r) => `<tr><td title="${esc(r.name)}"><a class="repo" href="${esc(cfg.web)}/${esc(r.name)}">${esc(r.name)}</a>
<span class="when">${r.at ? `scanned ${esc(String(r.at).slice(0, 10))}` : 'waiting for the first push'}${r.weekly_at ? ` · cleaned ${esc(String(r.weekly_at).slice(0, 10))}` : ''}</span></td>
${figure(r, (s) => s.security.high)}${figure(r, (s) => s.zombie.lines)}${figure(r, (s) => s.zombie.packages, false)}${figure(r, (s) => s.architecture.cycles + s.architecture.bigFiles, false)}${figure(r, (s) => s.blueprint || 0, false)}
<td><div class="act"><form method="post" action="/repos/${r.id}/copilot"><button class="btn quiet">Hand to Copilot</button></form></div></td></tr>`,
    )
    .join('');

  const table = !repos.length
    ? `<div class="empty"><h3>No repos yet</h3><p>Install the app on a repository, then push to its default branch. The first scan lands within a minute and the trends build from there.</p>
<a class="btn" href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">Install on a repo</a></div>`
    : !list.length
      ? `<div class="empty"><h3>Nothing in this view</h3><p>No repo matches ${esc(viewLabel.toLowerCase())} right now.</p><a class="btn quiet" href="/">Show all repos</a></div>`
      : `<div class="scroll"><table><thead><tr><th>Repo</th><th>High</th><th>Zombie lines</th><th>Packages</th><th>Architecture</th><th>Blueprint</th><th>Weekly clean-up</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const bars = [{ name: 'your repos', v: deletes, you: true }, ...Object.entries(study.authors).map(([name, a]) => ({ name: name === 'Human' ? 'humans' : name, v: Math.round(a.deletedPer100), you: false }))]
    .filter((b) => b.v !== null)
    .sort((a, b) => (b.v as number) - (a.v as number));
  const max = Math.max(...bars.map((b) => b.v as number), 1);
  const strip = scanned.length
    ? `<div class="rule"><h2>Deleted per 100 added</h2><span class="count">${num(study.study.repos)} public repos</span></div>
<p class="note">Lines deleted for every 100 added since October 2025, measured the same way in your repos and in the study.</p>
<div class="bars">${bars.map((b) => `<div class="${b.you ? 'you' : ''}"><span>${esc(b.name)}</span><b>${b.v}</b><i style="width:${Math.round(((b.v as number) / max) * 100)}%"></i></div>`).join('')}</div>`
    : '';

  const views = VIEWS.map(([key, label]) => `<a class="${key === view ? 'on' : ''}" href="${key === 'all' ? '/' : `/?view=${key}`}">${esc(label)} <b>${num(counts[key])}</b></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repos · zomb</title>${FONTS}<style>${TOKENS}${DASH_CSS}</style></head><body>
<div class="bar"><span class="word">zomb</span><span class="sep"></span><span class="eyebrow">cloud</span>
<span class="who"><span>${esc(me.login)}</span><a href="${esc(cfg.web)}/apps/${esc(cfg.slug)}/installations/new">add repos</a><a href="/logout">sign out</a></span></div>
<nav class="views">${views}</nav>
<div class="rule"><h2>${esc(viewLabel)}</h2><span class="count">${num(list.length)} of ${num(repos.length)}</span></div>
<p class="note">Figures come from the last scan of each default branch.</p>
${figures}${table}${strip}
<footer><span>zomb cloud</span><a href="${esc(study.study.url)}">the study</a><a href="https://github.com/Open-Dev-Society/zomb">docs</a></footer>
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
