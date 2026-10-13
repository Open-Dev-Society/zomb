import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { addText, emptyTraffic, normalPath, readLine, readTraffic, routeHits, span, summarize } from '../src/traffic.ts';

test('normalPath keeps the path and drops the rest', () => {
  assert.equal(normalPath('/blog/post/?utm=x#top'), '/blog/post');
  assert.equal(normalPath('https://site.com/blog//post'), '/blog/post');
  assert.equal(normalPath('/caf%C3%A9'), '/café');
  assert.equal(normalPath('/'), '/');
  assert.equal(normalPath('/100%'), '/100%', 'a stray % is still a path');
  assert.equal(normalPath('blog'), null);
  assert.equal(normalPath(42), null);
});

test('readLine reads access logs, JSON lines and plain counts, and nothing else', () => {
  const nginx = '203.0.113.9 - - [01/Oct/2026:10:00:00 +0200] "GET /pricing?ref=x HTTP/1.1" 200 512 "-" "Mozilla/5.0"';
  assert.deepEqual(readLine(nginx), { path: '/pricing', count: 1, at: Date.parse('2026-10-01T08:00:00Z') });
  // a Vercel log drain entry: the request is in proxy, the time in milliseconds
  assert.deepEqual(readLine(JSON.stringify({ source: 'edge', proxy: { method: 'GET', path: '/api/export?x=1', timestamp: 1790000000000 } })), { path: '/api/export', count: 1, at: 1790000000000 });
  assert.deepEqual(readLine('{"path":"/docs","count":12,"timestamp":"2026-09-01"}'), { path: '/docs', count: 12, at: Date.parse('2026-09-01') });
  assert.deepEqual(readLine('{"url":"https://x.dev/a","time":1790000000}'), { path: '/a', count: 1, at: 1790000000000 }, 'seconds become milliseconds');
  assert.deepEqual(readLine('/about 7'), { path: '/about', count: 7, at: null });
  assert.deepEqual(readLine('/about,3'), { path: '/about', count: 3, at: null });
  assert.deepEqual(readLine('/about'), { path: '/about', count: 1, at: null });
  assert.equal(readLine('page,visitors'), null, 'a CSV header is not a request');
  assert.equal(readLine('{"message":"build started"}'), null, 'a log line with no path');
  assert.equal(readLine('{broken'), null);
  assert.equal(readLine(''), null);
});

test('addText reads a whole JSON array, as Vercel posts it', () => {
  const t = emptyTraffic();
  addText(t, JSON.stringify([{ path: '/a', timestamp: 1000 * 86400 * 20000 }, { proxy: { path: '/b' }, timestamp: 1000 * 86400 * 20010 }, { message: 'no path' }]));
  assert.deepEqual([...t.hits], [['/a', 1], ['/b', 1]]);
  assert.equal(t.requests, 2);
  assert.equal(summarize(t, 5, 3).days, 10);
});

test('readTraffic streams logs, reads arrays whole, and opens .gz', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-traffic-'));
  try {
    const log = path.join(dir, 'access.log');
    writeFileSync(log, ['1.2.3.4 - - [01/Sep/2026:00:00:00 +0000] "GET /a HTTP/1.1" 200 1', '1.2.3.4 - - [08/Sep/2026:00:00:00 +0000] "POST /a HTTP/2.0" 201 1', 'garbage'].join('\n'));
    const arr = path.join(dir, 'drain.json');
    writeFileSync(arr, `\n  ${JSON.stringify([{ path: '/b', count: 2 }])}`);
    const gz = path.join(dir, 'old.log.gz');
    writeFileSync(gz, gzipSync('/c 5\n/a\n'));
    const t = await readTraffic([log, arr, gz]);
    assert.deepEqual(Object.fromEntries(t.hits), { '/a': 3, '/b': 2, '/c': 5 });
    const s = summarize(t, 4, 1);
    assert.deepEqual(s, { requests: 10, from: '2026-09-01', to: '2026-09-08', days: 7, routes: 4, unvisited: 1 });
    assert.equal(span(s), 'from 2026-09-01 to 2026-09-08 (10 requests)');
    assert.equal(span({ ...s, from: null, to: null }), 'in 10 requests');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routeHits credits each request to the route Next.js would serve it from', () => {
  const t = emptyTraffic();
  addText(t, ['/blog/new 2', '/blog/hello 3', '/docs/a/b 1', '/shop 1', '/fr/about 4', '/wp-admin 9', '/api/users/7 1'].join('\n'));
  const hits = routeHits(['/blog/[slug]', '/blog/new', '/docs/[...slug]', '/docs', '/shop/[[...slug]]', '/about', '/api/users/[id]', '/unused'], t);
  assert.deepEqual(Object.fromEntries(hits), {
    '/blog/[slug]': 3,
    '/blog/new': 2,
    '/docs/[...slug]': 1,
    '/docs': 0,
    '/shop/[[...slug]]': 1,
    '/about': 4,
    '/api/users/[id]': 1,
    '/unused': 0,
  });
});
