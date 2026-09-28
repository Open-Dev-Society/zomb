import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent, parseBlame, classifyPR, scoreFile, surfacesOf, churn, timeline, readingPlan, sameNames, testsOnly, routeOf } from '../src/score.js';

test('isAgent spots agents, not humans who share a name', () => {
  assert.ok(isAgent('Claude Opus 5 <noreply@anthropic.com>'));
  assert.ok(isAgent('Cursor Agent <cursoragent@cursor.com>'));
  assert.ok(isAgent('copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>'));
  assert.ok(isAgent('claude[bot] <209825114+claude[bot]@users.noreply.github.com>'));
  assert.ok(isAgent('Paul (aider) <paul@example.com>'));
  assert.ok(!isAgent('Claude Monet <claude@monet.fr>'));
  assert.ok(!isAgent('Ashwin Bhat <ashwin@anthropic.com>'));
  assert.ok(!isAgent('dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'));
  assert.ok(!isAgent('Sampson Lee <sam@example.com>'));
});

test('parseBlame returns the sha behind each line', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const text = `${a} 1 1 2\nauthor X\n\tline1\n${a} 2 2\n\tline2\n${b} 1 3 1\nauthor Y\n\tline3\n`;
  assert.deepEqual(parseBlame(text), [a, a, b]);
});

test('classifyPR: none, rubber stamp, too fast for its size, real review', () => {
  const base = { author: 'ravi', lastCommitAt: '2026-09-27T10:00:00Z', threads: 0, additions: 100, deletions: 0 };
  const sam = (at) => [{ author: 'sam', state: 'APPROVED', at, body: '' }];
  assert.equal(classifyPR({ ...base, reviews: [{ author: 'ravi', state: 'APPROVED', at: '2026-09-27T10:00:30Z', body: '' }] }).state, 'unreviewed');
  assert.equal(classifyPR({ ...base, reviews: [{ author: 'coderabbitai', bot: true, state: 'COMMENTED', at: '2026-09-27T10:01:00Z', body: 'lgtm' }] }).state, 'unreviewed');
  assert.equal(classifyPR({ ...base, reviews: sam('2026-09-27T10:01:00Z') }).state, 'rubber');
  // 100 lines in 30 min is fine; 1,240 lines in 30 min is 2,480 lines/hour
  assert.equal(classifyPR({ ...base, reviews: sam('2026-09-27T10:30:00Z') }).state, 'reviewed');
  const big = classifyPR({ ...base, additions: 1240, reviews: sam('2026-09-27T10:30:00Z') });
  assert.deepEqual(big, { state: 'rubber', lines: 1240, seconds: 1800 });
  assert.equal(classifyPR({ ...base, threads: 2, reviews: sam('2026-09-27T10:01:00Z') }).state, 'reviewed');
});

test('surfacesOf reads what a file can hurt from its imports', () => {
  assert.deepEqual(surfacesOf('src/lib/pay.ts', ['stripe', '@/lib/db'], 'const k = process.env.STRIPE_SECRET_KEY').sort(), ['payments', 'secrets']);
  assert.deepEqual(surfacesOf('app/api/users/route.ts', ['@supabase/supabase-js'], '').sort(), ['database', 'endpoint']);
  assert.deepEqual(surfacesOf('src/ui/Button.tsx', ['react'], 'process.env.NEXT_PUBLIC_URL'), []);
});

test('churn and timeline from git history', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  const history = [
    { sha: 'a', date: '2026-09-20T00:00:00Z', subject: 'fix: billing rounding', files: [{ path: 'billing.ts', added: 10 }] },
    { sha: 'b', date: '2026-09-01T00:00:00Z', subject: 'add billing', files: [{ path: 'billing.ts', added: 90 }] },
    { sha: 'c', date: '2026-01-01T00:00:00Z', subject: 'old', files: [{ path: 'billing.ts', added: 50 }] },
  ];
  assert.deepEqual(churn(history, now).get('billing.ts'), { changes: 2, fixes: 1 });
  const agentOf = new Map([['a', 'Claude'], ['b', 'Claude'], ['c', null]]);
  assert.deepEqual(timeline(history, agentOf), [{ month: '2026-01', agent: 0, human: 50 }, { month: '2026-09', agent: 100, human: 0 }]);
});

test('scoreFile: zombie = not in use; risk ranks unread code by what it can break', () => {
  const f = { path: 'src/a.ts', lines: 100, agentLines: 0, agents: new Set(), unusedExports: 0, referencedBy: null, pr: null };
  assert.equal(scoreFile({ ...f, unusedFile: false }).quadrant, 'healthy');
  assert.equal(scoreFile({ ...f, unusedFile: true }).quadrant, 'zombie-known');
  assert.equal(scoreFile({ ...f, unusedFile: true, agentLines: 90 }).quadrant, 'zombie');
  assert.equal(scoreFile({ ...f, unusedFile: false, testsOnly: true, agentLines: 90 }).quadrant, 'zombie');
  assert.equal(scoreFile({ ...f, unusedFile: false, agentLines: 90 }).quadrant, 'unread');
  assert.equal(scoreFile({ ...f, unusedFile: true, referencedBy: 'action.yml', agentLines: 90 }).quadrant, 'unread');
  // 80% agent lines, real review -> 20% + 40% read = understood
  assert.equal(scoreFile({ ...f, unusedFile: false, agentLines: 80, pr: { number: 1, state: 'reviewed', lines: 10, seconds: 600 } }).quadrant, 'healthy');

  const zombie = { ...f, unusedFile: false, agentLines: 100 };
  const util = scoreFile({ ...zombie, path: 'src/format.ts' });
  const billing = scoreFile({ ...zombie, path: 'src/billing.ts', dependents: 20, touches: ['payments', 'database'], churn: { changes: 6, fixes: 3 } });
  assert.ok(billing.risk > util.risk * 5);
  assert.equal(scoreFile({ ...f, unusedFile: false }).risk, 0);

  const plan = readingPlan([util, billing]);
  assert.equal(plan.files[0].path, 'src/billing.ts');
  assert.ok(plan.coverage >= 0.6);
});

test('sameNames finds helpers defined twice, not framework conventions', () => {
  const parsed = new Map([
    ['a/format.ts', { exported: ['formatCurrency', 'GET'] }],
    ['b/money.ts', { exported: ['formatCurrency'] }],
    ['c/route.ts', { exported: ['GET', 'POST'] }],
  ]);
  assert.deepEqual(sameNames(parsed), [{ name: 'formatCurrency', files: ['a/format.ts', 'b/money.ts'] }]);
});

test('testsOnly: files kept alive only by their tests, even through a chain', () => {
  const parsed = new Map([
    ['src/app/page.tsx', { imports: ['src/lib/live.ts'] }],
    ['src/lib/live.ts', { imports: [] }],
    ['src/lib/old.ts', { imports: ['src/lib/helper.ts'] }],
    ['src/lib/helper.ts', { imports: [] }],
    ['src/lib/old.test.ts', { imports: ['src/lib/old.ts', 'src/lib/live.ts'] }],
    ['src/lib/lonely.ts', { imports: [] }],
  ]);
  assert.deepEqual([...testsOnly(parsed)].sort(), ['src/lib/helper.ts', 'src/lib/old.ts']);
  // action.yml starts old.ts by path: it and everything it imports are live, even if only tests import it
  assert.deepEqual([...testsOnly(parsed, new Set(['src/lib/old.ts']))], []);
});

test('routeOf turns Next.js route files into URLs and skips ones outside services call', () => {
  assert.deepEqual(routeOf('app/(marketing)/old-pricing/page.tsx'), { url: '/old-pricing', prefix: '/old-pricing', kind: 'page' });
  assert.deepEqual(routeOf('src/app/api/users/[id]/route.ts'), { url: '/api/users/[id]', prefix: '/api/users', kind: 'api' });
  assert.deepEqual(routeOf('pages/blog/index.tsx'), { url: '/blog', prefix: '/blog', kind: 'page' });
  assert.equal(routeOf('pages/api/users.ts').kind, 'api');
  assert.equal(routeOf('app/page.tsx'), null);
  assert.equal(routeOf('app/api/stripe/webhook/route.ts'), null);
  assert.equal(routeOf('app/[slug]/page.tsx'), null);
  assert.equal(routeOf('pages/_app.tsx'), null);
  assert.equal(routeOf('src/lib/db.ts'), null);
});
