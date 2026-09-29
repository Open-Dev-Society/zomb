import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent, parseBlame, testsOnly, routeOf, growth, versionSprawl, overlaps, sameNames, cycles, sharedFolders, namingStyles } from '../src/score.js';
import { findSecrets, publicSecretNames, findDangerous, routeFacts, openRoute, envValues, isEnvFile, securityFindings } from '../src/security.js';

test('isAgent spots agents, not humans who share a name', () => {
  assert.ok(isAgent('Claude Opus 5 <noreply@anthropic.com>'));
  assert.ok(isAgent('Cursor Agent <cursoragent@cursor.com>'));
  assert.ok(isAgent('claude[bot] <209825114+claude[bot]@users.noreply.github.com>'));
  assert.ok(!isAgent('Claude Monet <claude@monet.fr>'));
  assert.ok(!isAgent('Ashwin Bhat <ashwin@anthropic.com>'));
  assert.ok(!isAgent('dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'));
});

test('parseBlame returns the sha behind each line', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.deepEqual(parseBlame(`${a} 1 1 2\nauthor X\n\tline1\n${a} 2 2\n\tline2\n${b} 1 3 1\n\tline3\n`), [a, a, b]);
});

test('testsOnly: files kept alive only by their tests, unless something starts them by path', () => {
  const parsed = new Map([
    ['src/app/page.tsx', { imports: ['src/lib/live.ts'] }],
    ['src/lib/live.ts', { imports: [] }],
    ['src/lib/old.ts', { imports: ['src/lib/helper.ts'] }],
    ['src/lib/helper.ts', { imports: [] }],
    ['src/lib/old.test.ts', { imports: ['src/lib/old.ts', 'src/lib/live.ts'] }],
  ]);
  assert.deepEqual([...testsOnly(parsed)].sort(), ['src/lib/helper.ts', 'src/lib/old.ts']);
  assert.deepEqual([...testsOnly(parsed, new Set(['src/lib/old.ts']))], []);
});

test('routeOf turns Next.js route files into URLs and skips ones outside services call', () => {
  assert.deepEqual(routeOf('app/(marketing)/old-pricing/page.tsx'), { url: '/old-pricing', prefix: '/old-pricing', kind: 'page' });
  assert.deepEqual(routeOf('src/app/api/users/[id]/route.ts'), { url: '/api/users/[id]', prefix: '/api/users', kind: 'api' });
  assert.equal(routeOf('pages/blog/index.tsx').url, '/blog');
  assert.equal(routeOf('app/page.tsx'), null);
  assert.equal(routeOf('app/api/stripe/webhook/route.ts'), null);
  assert.equal(routeOf('src/lib/db.ts'), null);
});

test('growth: lines added vs deleted per month', () => {
  const history = [
    { date: '2026-09-20T00:00:00Z', files: [{ added: 100, deleted: 5 }] },
    { date: '2026-09-01T00:00:00Z', files: [{ added: 50, deleted: 0 }, { added: 10, deleted: 2 }] },
    { date: '2026-08-01T00:00:00Z', files: [{ added: 7, deleted: 7 }] },
  ];
  assert.deepEqual(growth(history), [{ month: '2026-08', added: 7, deleted: 7 }, { month: '2026-09', added: 160, deleted: 7 }]);
});

test('versionSprawl finds V2/old/copy files and versioned folders', () => {
  const files = ['src/Landing.tsx', 'src/LandingV2.tsx', 'src/api-old.ts', 'lib/utils copy.ts', 'components/ov2/Hero.tsx', 'src/Oldham.tsx', 'src/Button.tsx', 'src/new.ts'];
  assert.deepEqual(versionSprawl(files), [
    { path: 'src/LandingV2.tsx', original: 'src/Landing.tsx' },
    { path: 'src/api-old.ts', original: null },
    { path: 'lib/utils copy.ts', original: null },
    { path: 'components/ov2/', files: 1, original: null },
  ]);
});

test('overlaps: two libraries doing one job, companions folded together', () => {
  const packages = new Map([['lucide-react', ['a', 'b']], ['react-icons', ['c']], ['@reduxjs/toolkit', ['d']], ['react-redux', ['d']], ['zod', ['e']]]);
  assert.deepEqual(overlaps(packages), [{ job: 'icon sets', libraries: [{ name: 'lucide-react', files: 2 }, { name: 'react-icons', files: 1 }] }]);
});

test('sameNames finds helpers defined twice, not framework conventions', () => {
  const parsed = new Map([['a/format.ts', { exported: ['formatCurrency', 'GET'] }], ['b/money.ts', { exported: ['formatCurrency'] }], ['c/route.ts', { exported: ['GET'] }]]);
  assert.deepEqual(sameNames(parsed), [{ name: 'formatCurrency', files: ['a/format.ts', 'b/money.ts'] }]);
});

test('architecture: cycles, scattered shared folders, mixed naming', () => {
  const graph = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']], ['e', ['e']]]);
  assert.deepEqual(cycles(graph), [['a', 'b', 'c']]);
  assert.deepEqual(sharedFolders(['src/utils/a.ts', 'src/lib/db.ts', 'app/helpers/x.ts', 'src/utils/b.ts', 'src/ui/Button.tsx']), ['app/helpers', 'src/lib', 'src/utils']);
  assert.deepEqual(namingStyles(['ui/Button.tsx', 'ui/Card.tsx', 'ui/nav-bar.tsx', 'app/page.tsx', 'ui/Button.test.tsx']), [['PascalCase', 2], ['kebab-case', 1]]);
});

test('findSecrets catches real key formats, skips placeholders, and masks what it shows', () => {
  const live = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const found = findSecrets(`const stripe = new Stripe("${live}");\nconst key = "sk_live_your_key_here_xxxxxxxxxxxx";\nAKIAIOSFODNN7EXAMPLE`);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'Stripe live key');
  assert.equal(found[0].line, 1);
  assert.ok(!found[0].preview.includes(live.slice(8)), 'the report must never show the full key');
  assert.equal(findSecrets('DATABASE_URL=postgres://admin:hunter2secret@db.prod.example.net:5432/app')[0], undefined); // "example" host = placeholder
  assert.equal(findSecrets('postgres://app:Zq9!rT4vWx@db.acme-prod.net/app')[0].kind, 'Database URL with a password');
  assert.equal(findSecrets('postgres://postgres:postgres@localhost:5432/dev').length, 0);
  assert.equal(findSecrets('const uri = `mongodb://${user}:${pass}@${hosts}/db`').length, 0);
  assert.equal(findSecrets('const t = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"').length, 0);
});

test('publicSecretNames flags browser-exposed secrets, not public keys', () => {
  assert.deepEqual(publicSecretNames('process.env.NEXT_PUBLIC_OPENAI_API_KEY; NEXT_PUBLIC_STRIPE_SECRET_KEY=x; VITE_SUPABASE_SERVICE_ROLE_KEY').sort(), ['NEXT_PUBLIC_OPENAI_API_KEY', 'NEXT_PUBLIC_STRIPE_SECRET_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY']);
  assert.deepEqual(publicSecretNames('NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY NEXT_PUBLIC_POSTHOG_KEY'), []);
});

test('findDangerous: string-built SQL and shell, not regex.exec', () => {
  const src = 'await db.query(`SELECT * FROM users WHERE id = ${id}`);\nconst m = re.exec(a + b);\nexec(`rm -rf ${dir}`);\n// eval(x) in a comment\n<div dangerouslySetInnerHTML={{ __html: post.body }} />\n<script dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />\n<style dangerouslySetInnerHTML={{ __html: CSS }} />\nconst phaseScript = `try{document.documentElement.dataset.phase="day"}catch(e){}`;\n<script dangerouslySetInnerHTML={{ __html: phaseScript }} />';
  assert.deepEqual(findDangerous(src).map((d) => [d.line, d.severity]), [[1, 'high'], [5, 'medium']]);
  assert.deepEqual(findDangerous(src, { shell: true }).map((d) => d.line), [1, 3, 5]);
});

test('open routes: changes data or touches the database with no auth check', () => {
  const post = 'export async function POST(req) { await db.insert(users).values(await req.json()) }';
  assert.equal(openRoute(routeFacts('app/api/users/route.ts', post), ['database']), 'changes data and touches database');
  assert.equal(openRoute(routeFacts('app/api/users/route.ts', `const s = await auth();\n${post}`), ['database']), null);
  assert.equal(openRoute(routeFacts('app/api/stripe/route.ts', 'export async function POST(){ stripe.webhooks.constructEvent(b, sig, s) }'), ['payments']), null);
  assert.equal(openRoute(routeFacts('app/api/users/route.ts', post), ['database', 'auth']), null); // an imported module does the auth
  assert.equal(openRoute(routeFacts('app/api/hello/route.ts', 'export function GET(){ return Response.json({}) }'), []), null);
  assert.equal(routeFacts('src/lib/db.ts', post), null);
});

test('env files and ranking', () => {
  assert.ok(isEnvFile('.env') && isEnvFile('apps/web/.env.local') && !isEnvFile('.env.example'));
  const env = (committed) => securityFindings({ secrets: [], envFiles: [{ file: '.env', values: 2, committed }], publicVars: [], dangerous: [], openRoutes: [], audit: {} })[0];
  assert.equal(env(true).severity, 'high');
  assert.equal(env(false).title, '.env file not in .gitignore');
  assert.equal(envValues('A=1\nB=\n# C=3\nexport D="x"\n'), 2);
  const f = securityFindings({ secrets: [], envFiles: [], publicVars: [], dangerous: [{ severity: 'medium', kind: 'eval', file: 'a.ts', line: 1 }], openRoutes: [], audit: { top: [{ name: 'next', severity: 'critical', title: 'SSRF', fix: true }], counts: { critical: 1, high: 0 } } });
  assert.deepEqual(f.map((x) => x.severity), ['high', 'medium']);
});

test('shortcuts: suppressions, skipped and focused tests, removed tests, test-env branches', async () => {
  const { shortcuts, removedImports } = await import('../src/diff.js');
  const diff = [
    'diff --git a/src/pay.ts b/src/pay.ts', '--- a/src/pay.ts', '+++ b/src/pay.ts', '@@ -10,0 +11,4 @@',
    '+  // @ts-ignore', '+  const total = (cart as any).sum;', "+  if (process.env.NODE_ENV === 'test') return 0;", '+  // this used to be as any',
    'diff --git a/src/pay.test.ts b/src/pay.test.ts', '--- a/src/pay.test.ts', '+++ b/src/pay.test.ts', '@@ -3,4 +3,1 @@',
    "-it('rounds to cents', () => { expect(round(1.005)).toBe(1.01) });", "-it('rejects negatives', () => { expect(() => pay(-1)).toThrow() });",
    "+it.only('pays', () => { expect(pay(1)).toBe(1) });",
    'diff --git a/src/page.tsx b/src/page.tsx', '--- a/src/page.tsx', '+++ b/src/page.tsx', '@@ -1,1 +0,0 @@', "-import moment from 'moment';",
  ].join('\n');
  const found = shortcuts(diff, ['src/old.test.ts', 'src/old.ts']).map((s) => `${s.severity} ${s.kind} ${s.file}${s.line ? `:${s.line}` : ''}`);
  assert.deepEqual(found, [
    'medium Silences the type checker src/pay.ts:11',
    'low Casts to any src/pay.ts:12',
    'medium Special-cases the test environment src/pay.ts:13',
    'high Focuses one test, so CI silently skips the rest src/pay.test.ts:3',
    'medium Removes 1 test src/pay.test.ts',
    'medium Deletes a test file src/old.test.ts',
  ]);
  assert.deepEqual([...removedImports(diff)], ['moment']);
});

test('fingerprints ignore line numbers and counts; markdown shows only new findings', async () => {
  const { fingerprint, toMarkdown } = await import('../src/tasks.js');
  const t = (title, where) => ({ area: 'security', action: 'fix', severity: 'high', title, where });
  assert.equal(fingerprint(t('Stripe live key in the code', 'lib/pay.ts:12')), fingerprint(t('Stripe live key in the code', 'lib/pay.ts:40')));
  assert.equal(fingerprint(t('Delete a.ts (301 lines)', 'a.ts')), fingerprint(t('Delete a.ts (310 lines)', 'a.ts')));
  assert.notEqual(fingerprint(t('Stripe live key in the code', 'lib/pay.ts:12')), fingerprint(t('Stripe live key in the code', 'lib/other.ts:12')));
  const md = toMarkdown([{ ...t('New key', 'x.ts:1'), new: true }, { ...t('Old key', 'y.ts:1'), new: false }], { baseline: true, since: 'main' });
  assert.match(md, /1 new finding in this change/);
  assert.ok(md.includes('New key') && !md.includes('Old key'));
  assert.match(toMarkdown([], { since: 'main' }), /nothing new/);
});

test('scopeTo keeps only what the change touched', async () => {
  const { scopeTo } = await import('../src/diff.js');
  const data = {
    zombie: { files: [{ path: 'a.ts' }, { path: 'b.ts' }], packages: [{ name: 'moment' }, { name: 'lodash' }], exports: [], maybe: [] },
    security: { findings: [{ files: ['a.ts'] }, { files: ['c.ts'] }, { package: true, files: [] }] },
    sprawl: { dupes: [], names: [], versions: [], overlaps: [{ job: 'x' }] },
    architecture: { cycles: [['a.ts', 'z.ts'], ['q.ts', 'r.ts']], big: [], deep: [], shared: ['lib'], naming: [] },
  };
  const s = scopeTo(data, { changed: new Set(['a.ts']), diff: "-import moment from 'moment';" });
  assert.deepEqual(s.zombie.files, [{ path: 'a.ts' }]);
  assert.deepEqual(s.zombie.packages, [{ name: 'moment' }]);
  assert.equal(s.security.findings.length, 1);
  assert.deepEqual(s.architecture.cycles, [['a.ts', 'z.ts']]);
  assert.deepEqual(s.sprawl.overlaps, []);
});

test('terminal output never wraps, at any width', async () => {
  const { render, visible } = await import('../src/terminal.js');
  const long = 'src/components/features/dashboard/analytics/really-long-folder-name/SomeVeryLongComponentName.tsx';
  const data = {
    repo: 'a-repo-with-a-fairly-long-name', files: 1234, lines: 123456,
    security: { findings: [{ severity: 'high', title: 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is shipped to every browser', where: `${long}, ${long}` }, { severity: 'medium', title: '/api/users/[id]/settings changes data and touches database with no visible auth check', where: long }] },
    shortcuts: [{ severity: 'high', kind: 'Focuses one test, so CI silently skips the rest', file: long, line: 12 }],
    zombie: { files: [{ path: long, lines: 1264, why: 'Nothing imports or names it', share: 1 }, { path: 'x.ts', lines: 3, why: 'Only its own tests import it' }], packages: ['@radix-ui/react-dropdown-menu', 'tailwind-merge', 'framer-motion', 'react-circle-flags', 'country-data-list'].map((name) => ({ name })), exports: [{ file: long, names: ['a', 'b'] }], maybe: [{ url: '/api/some/very/long/route/that/nobody/calls/anymore', file: long }] },
    sprawl: { dupes: [{ lines: 30, a: { file: long }, b: { file: long } }], names: [{ name: 'formatCurrencyWithLocaleAndFallbackSymbol', files: [long, long] }], versions: [{ path: long, original: long }, { path: 'components/ov2/', files: 75 }], overlaps: [{ job: 'icon sets', libraries: [{ name: '@phosphor-icons/react', files: 40 }, { name: 'react-icons', files: 3 }, { name: '@heroicons/react', files: 1 }] }] },
    architecture: { cycles: [[long, long, long, long]], big: [{ file: long, lines: 1727 }], deep: [{ file: long, count: 3 }], shared: ['src/lib', 'src/utils', 'app/helpers', 'packages/shared/src/core'], naming: [] },
  };
  const tasks = [{ safe: true }, { safe: false }];
  for (const width of [50, 60, 80, 120]) {
    const lines = render(data, tasks, { width, color: true, all: true, recent: [{ added: 34628, deleted: 15120 }], out: `/Users/someone/projects/${long}/.zomb/report.html`, failOn: 'high', failing: [1] });
    const widest = Math.max(...lines.map(visible));
    assert.ok(widest <= Math.max(48, Math.min(width - 1, 80)), `width ${width}: a line is ${widest} columns`);
    assert.ok(lines.every((l) => !/ $/.test(l.replace(/\x1b\[[0-9;]*m/g, ''))), 'no trailing spaces');
  }
});
