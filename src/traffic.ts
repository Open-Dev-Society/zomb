// Production traffic: which page and API routes still get requests. Reads access logs (nginx, Apache), JSON
// lines or arrays (Vercel drains, most log shippers, zomb Cloud) and plain "/path count" lines. Keeps only
// paths, counts and the time range: nothing about who sent the request.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';

export type Traffic = { hits: Map<string, number>; requests: number; from: number | null; to: number | null };
export type TrafficSummary = { requests: number; from: string | null; to: string | null; days: number | null; routes: number; unvisited: number };
type Hit = { path: string; count: number; at: number | null };

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const LOG_REQUEST = /"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/[\d.]+"/;
const LOG_TIME = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\]/;

/** "/blog/post/?utm=x#top" or "https://site.com/blog/post" -> "/blog/post"; null when it isn't a path. */
export function normalPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let p = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
  if (!p.startsWith('/')) return null;
  try {
    p = decodeURI(p);
  } catch {
    // a stray % is still a path
  }
  p = p.replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// a number of seconds or milliseconds, or anything Date.parse reads
function time(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    if (/^\d+(\.\d+)?$/.test(v)) return time(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function fromObject(o: any): Hit | null {
  if (!o || typeof o !== 'object') return null;
  const path = [o.path, o.pathname, o.requestPath, o.request_path, o.proxy?.path, o.request?.path, o.request?.url, o.req?.url, o.http?.path, o.url, o.page]
    .map(normalPath)
    .find(Boolean);
  if (!path) return null;
  const count = Number(o.count ?? o.hits ?? o.requests ?? o.visits ?? o.pageviews ?? 1);
  const at = [o.timestamp, o.time, o['@timestamp'], o.ts, o.date, o.proxy?.timestamp].map(time).find((t) => t !== null) ?? null;
  return { path, count: Number.isFinite(count) && count >= 0 ? count : 1, at };
}

/** One line of a log or export -> the request it records, or null when the line isn't one. */
export function readLine(line: string): Hit | null {
  const text = line.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return fromObject(JSON.parse(text));
    } catch {
      return null;
    }
  }
  const req = text.match(LOG_REQUEST);
  if (req) {
    const path = normalPath(req[1]);
    if (!path) return null;
    const t = text.match(LOG_TIME);
    const at = t ? Date.UTC(Number(t[3]), MONTHS[t[2]] ?? 0, Number(t[1]), Number(t[4]), Number(t[5]), Number(t[6])) - (t[7] === '-' ? -1 : 1) * (Number(t[8]) * 60 + Number(t[9])) * 60_000 : null;
    return { path, count: 1, at };
  }
  // "/path", "/path 12", "/path,12": an analytics export or a list someone made by hand
  if (text.startsWith('/')) {
    const [raw, n] = text.split(/[\s,;\t]+/);
    const path = normalPath(raw);
    const count = Number(n);
    return path ? { path, count: n !== undefined && Number.isFinite(count) && count >= 0 ? count : 1, at: null } : null;
  }
  return null;
}

/** The requests in one file or webhook body: a JSON array, or one request per line. */
export function hitsOf(text: string): Hit[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[')) {
    try {
      const list = JSON.parse(trimmed);
      if (Array.isArray(list)) return list.map(fromObject).filter((h): h is Hit => h !== null);
    } catch {
      // not one array after all: read it as lines
    }
  }
  return text.split('\n').map(readLine).filter((h): h is Hit => h !== null);
}

export function addText(into: Traffic, text: string) {
  for (const hit of hitsOf(text)) add(into, hit);
}

function add(into: Traffic, hit: Hit | null) {
  if (!hit) return;
  into.hits.set(hit.path, (into.hits.get(hit.path) || 0) + hit.count);
  into.requests += hit.count;
  if (hit.at !== null) {
    into.from = into.from === null ? hit.at : Math.min(into.from, hit.at);
    into.to = into.to === null ? hit.at : Math.max(into.to, hit.at);
  }
}

export const emptyTraffic = (): Traffic => ({ hits: new Map(), requests: 0, from: null, to: null });

const open = (file: string) => (file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file));

/** Read every file (plain or .gz) into one tally. Large logs are streamed line by line. */
export async function readTraffic(files: string[]): Promise<Traffic> {
  const into = emptyTraffic();
  for (const file of files) {
    // a JSON array has to be parsed whole; everything else streams
    if ((await firstChar(file)) === '[') {
      addText(into, file.endsWith('.gz') ? gunzipSync(await readFile(file)).toString('utf8') : await readFile(file, 'utf8'));
      continue;
    }
    for await (const line of createInterface({ input: open(file), crlfDelay: Infinity })) add(into, readLine(String(line)));
  }
  return into;
}
function firstChar(file: string) {
  return new Promise<string>((resolve, reject) => {
    const raw = createReadStream(file);
    const s = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
    let seen = '';
    const done = (ch: string) => (resolve(ch), s.destroy(), raw.destroy());
    s.on('data', (c: Buffer) => {
      seen += c.toString('utf8');
      if (seen.trim()) done(seen.trimStart()[0]);
    });
    s.once('error', reject);
    s.once('end', () => done(''));
  });
}

// A Next.js route URL -> a regex for the request paths it serves, and how specific it is.
// /blog/[slug] serves /blog/x, /docs/[...slug] one or more segments, /shop/[[...slug]] zero or more.
function pattern(url: string): { re: RegExp; rank: number[] } {
  const rank: number[] = [];
  let src = '';
  for (const seg of url.split('/').filter(Boolean)) {
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) (src += '(?:/[^/]+)*'), rank.push(0);
    else if (/^\[\.\.\..+\]$/.test(seg)) (src += '(?:/[^/]+)+'), rank.push(1);
    else if (/^\[.+\]$/.test(seg)) (src += '/[^/]+'), rank.push(2);
    else (src += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), rank.push(3);
  }
  return { re: new RegExp(`^${src || '/'}$`), rank };
}
// Next.js picks the most specific route: /blog/new beats /blog/[slug], which beats /blog/[...rest]
const better = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1);
  return false;
};
const LOCALE = /^\/[a-z]{2}(?:-[A-Za-z]{2,4})?(?=\/|$)/;

/** Requests per route URL. Each path counts once, for the route Next.js would serve it from. */
export function routeHits(urls: string[], traffic: Traffic): Map<string, number> {
  const routes = [...new Set(urls)].map((url) => ({ url, ...pattern(url) }));
  const out = new Map(routes.map((r) => [r.url, 0]));
  const serve = (p: string) => {
    let best: (typeof routes)[number] | null = null;
    for (const r of routes) if (r.re.test(p) && (!best || better(r.rank, best.rank))) best = r;
    return best;
  };
  for (const [p, count] of traffic.hits) {
    // /fr/about is /about in a Next.js app with i18n routing
    const r = serve(p) || (LOCALE.test(p) ? serve(p.replace(LOCALE, '') || '/') : null);
    if (r) out.set(r.url, (out.get(r.url) || 0) + count);
  }
  return out;
}

const day = (t: number | null) => (t === null ? null : new Date(t).toISOString().slice(0, 10));

export function summarize(traffic: Traffic, routes: number, unvisited: number): TrafficSummary {
  const days = traffic.from !== null && traffic.to !== null ? Math.max(1, Math.round((traffic.to - traffic.from) / 864e5)) : null;
  return { requests: traffic.requests, from: day(traffic.from), to: day(traffic.to), days, routes, unvisited };
}

/** "from 2026-09-01 to 2026-10-01 (1,204 requests)" or "in 1,204 requests" when the traffic has no dates. */
export const span = (t: TrafficSummary) => (t.from && t.to ? `from ${t.from} to ${t.to} (${t.requests.toLocaleString('en-US')} requests)` : `in ${t.requests.toLocaleString('en-US')} requests`);
