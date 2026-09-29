// Blueprint: infer the rules a codebase follows, save them, and hold agents (Guard) and PRs (the scan) to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { infer, toRules, breaks, toYaml } from '../src/blueprint.js';
import { check } from '../src/guard.js';

const file = (packages = [], extra = {}) => ({ packages, deep: 0, alias: ['@/'], fetch: false, route: null, lines: 40, ...extra });
const parsed = new Map([
  ['src/components/Header.tsx', file(['react-icons'])],
  ['src/components/Footer.tsx', file(['react-icons'])],
  ['src/components/ui/Button.tsx', file(['react-icons'])],
  ['src/components/Card.tsx', file()],
  ['src/features/Legacy.tsx', file(['lucide-react'], { deep: 1 })],
  ['src/hooks/useUser.ts', file([], { fetch: true })],
  ['src/hooks/useTheme.ts', file()],
  ['src/hooks/useCart.ts', file([], { fetch: true })],
  ['src/lib/db.ts', file()],
  ['src/utils/format.ts', file()],
  ['src/app/api/orders/route.ts', file([], { route: { mutates: true, authSignal: true } })],
  ['src/app/api/cart/route.ts', file([], { route: { mutates: true, authSignal: true } })],
  ['src/app/api/contact/route.ts', file([], { route: { mutates: true, authSignal: false } })],
  ['src/components/Header.test.tsx', file(['lucide-react'])],
]);

test('infer proposes only the rules the code already mostly follows', () => {
  const rules = toRules(infer(parsed));
  assert.deepEqual(rules, {
    libraries: { icons: 'react-icons', http: 'fetch' },
    folders: { components: 'src/components', hooks: 'src/hooks', shared: 'src/lib' },
    naming: { components: 'PascalCase' },
    imports: { alias: '@/' },
    api: { auth: 'required' },
    files: { maxLines: 500 },
  });
  assert.match(infer(parsed).find((r) => r.key === 'icons').evidence, /^3 files; also lucide-react \(1\)$/, 'the test file does not count');
  assert.equal(toRules(infer(parsed, { middlewareAuth: true })).api, undefined, 'a middleware check covers every route');
  // the YAML round-trips, including values YAML would misread unquoted ('@/')
  assert.deepEqual(parse(toYaml(infer(parsed), 'shop')), rules);
});

test('breaks names each rule a file breaks', () => {
  const rules = toRules(infer(parsed));
  const why = (f) => breaks(rules, f).map((b) => b.rule);
  assert.deepEqual(why({ file: 'src/features/Legacy.tsx', packages: ['lucide-react', 'react-icons'], deep: 1 }), ['libraries.icons', 'folders.components', 'imports.alias']);
  assert.deepEqual(why({ file: 'src/components/user-card.tsx' }), ['naming.components']);
  assert.deepEqual(why({ file: 'src/components/useThing.ts' }), ['folders.hooks']);
  assert.deepEqual(why({ file: 'src/helpers/money.ts' }), ['folders.shared']);
  assert.deepEqual(why({ file: 'src/lib/utils/money.ts' }), [], 'a folder inside the shared one is fine');
  assert.deepEqual(why({ file: 'src/app/page.tsx' }), [], 'framework entry files are not components');
  assert.deepEqual(why({ file: 'src/lib/http.ts', packages: ['axios'] }), ['libraries.http']);
  assert.deepEqual(why({ file: 'src/app/api/x/route.ts', route: { mutates: true, authSignal: false } }), ['api.auth']);
  assert.deepEqual(why({ file: 'src/app/api/x/route.ts', route: { mutates: true, authSignal: false, public: true } }), [], 'zomb-allow marks it public');
  assert.deepEqual(why({ file: 'src/lib/big.ts', lines: 501 }), ['files.maxLines']);
  assert.deepEqual(why({ file: 'src/features/Legacy.tsx', placed: false }), [], 'Guard skips placement for files that already exist');
});

test('Guard holds agents to the blueprint', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-blueprint-'));
  try {
    const repo = {
      'package.json': JSON.stringify({ dependencies: { 'react-icons': '5.0.0', 'lucide-react': '0.400.0' } }),
      'src/components/Chat.tsx': 'export function Chat() { return null }\n',
      'src/app/api/orders/route.ts': 'export async function POST(req: Request) { await auth(); return Response.json({}); }\n',
      '.zomb/blueprint.yml': toYaml(infer(parsed), 'shop').replace('maxLines: 500', 'maxLines: 20'),
    };
    for (const [f, body] of Object.entries(repo)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), body);
    }
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const write = (file_path, content) => check({ file_path, content }, dir);
    const edit = (file_path, old_string, new_string) => check({ file_path, old_string, new_string }, dir);

    assert.match(write('src/components/Icon.tsx', "import { Camera } from 'lucide-react';\n").deny[0], /^blueprint: icons use react-icons in this repo, not lucide-react\. .*\.zomb\/blueprint\.yml/, 'installed is not enough: the blueprint picks one');
    assert.match(write('src/pages-parts/Hero.tsx', 'export function Hero() { return null }\n').deny[0], /components live in src\/components\//);
    assert.match(write('src/components/hero-banner.tsx', 'export function HeroBanner() { return null }\n').deny[0], /component files are PascalCase/);
    assert.match(edit('src/components/Chat.tsx', 'export function Chat', "import { db } from '../../../lib/db';\nexport function Chat").deny[0], /import through @\/ instead of \.\.\/\.\.\/\.\.\//);
    assert.match(write('src/app/api/cart/route.ts', 'export async function POST() { return Response.json({}); }\n').deny[0], /API routes that change data must check auth/);
    assert.deepEqual(write('src/app/api/contact/route.ts', '// zomb-allow: public contact form\nexport async function POST() { return Response.json({}); }\n').deny, []);
    assert.match(edit('src/app/api/orders/route.ts', 'await auth(); ', '').deny[0], /must check auth/, 'removing the check is blocked');
    assert.match(write('src/lib/long.ts', 'export const x = 1;\n'.repeat(25)).deny[0], /over the 20-line limit/);
    assert.deepEqual(write('src/components/Toast.tsx', "import { FaBell } from 'react-icons/fa';\nexport function Toast() { return null }\n"), { deny: [], warn: [] });

    writeFileSync(path.join(dir, '.zomb/blueprint.yml'), 'libraries: [oops');
    assert.deepEqual(write('src/pages-parts/Hero.tsx', 'export function Hero() { return null }\n').deny, [], 'a broken blueprint never blocks every edit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zomb blueprint --write saves it, and the scan reports what breaks it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-blueprint-cli-'));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.js');
  try {
    const repo = {
      'package.json': JSON.stringify({ name: 'shop', private: true, dependencies: { 'react-icons': '5.0.0', 'lucide-react': '0.400.0' } }),
      'src/components/A.tsx': "import { FaA } from 'react-icons/fa';\nexport function A() { return <FaA /> }\n",
      'src/components/B.tsx': "import { FaB } from 'react-icons/fa';\nexport function B() { return <FaB /> }\n",
      'src/components/C.tsx': "import { Camera } from 'lucide-react';\nexport function C() { return <Camera /> }\n",
      'src/app/page.tsx': "import { A } from '../components/A';\nimport { B } from '../components/B';\nimport { C } from '../components/C';\nexport default function Page() { return <><A /><B /><C /></> }\n",
    };
    for (const [f, body] of Object.entries(repo)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), body);
    }
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'init');
    const run = (...args) => execFileSync(process.execPath, [cli, dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    assert.match(execFileSync(process.execPath, [cli, 'blueprint', dir], { encoding: 'utf8' }), /icons\s+react-icons/);
    execFileSync(process.execPath, [cli, 'blueprint', dir, '--write'], { stdio: 'ignore' });
    const yml = readFileSync(path.join(dir, '.zomb/blueprint.yml'), 'utf8');
    assert.match(yml, /icons: "react-icons"\s+# 2 files; also lucide-react \(1\)/);
    assert.match(readFileSync(path.join(dir, '.zomb/.gitignore'), 'utf8'), /!blueprint\.yml/, 'the blueprint is meant to be committed');
    const task = JSON.parse(run('--json')).tasks.find((t) => t.area === 'blueprint');
    assert.deepEqual([task.severity, task.where, task.title], ['high', 'src/components/C.tsx', 'icons use react-icons in this repo, not lucide-react']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
