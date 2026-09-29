// End to end: build a small app with the classic AI-coding mistakes planted in it, run `zomb --json`, check each one is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.js');

// Keys are assembled at runtime so this repo never contains a key-shaped string.
const stripeKey = ['sk', 'live', 'Q7mZp2Lx9Rt4Vb8Nc1Hs6Kd3'].join('_');

const files = {
  'package.json': JSON.stringify({ name: 'vibe-app', private: true, dependencies: { next: '15.0.0', react: '19.0.0', 'lucide-react': '0.400.0', 'react-icons': '5.0.0', moment: '2.30.1', dayjs: '1.11.0', '@prisma/client': '5.0.0', stripe: '14.0.0', lodash: '4.17.21' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] }, jsx: 'preserve' } }),
  '.env': `DATABASE_URL=postgres://app:Zq9rT4vWxy@db.acme-prod.net/app\nSTRIPE_SECRET_KEY=${stripeKey}\n`,
  'lib/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\nexport async function findUser(id: string) { return db.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`); }\n",
  'lib/stripe.ts': `import Stripe from 'stripe';\nexport const stripe = new Stripe("${stripeKey}");\n`,
  'lib/session.ts': 'export async function getSession() { return null }\n',
  'app/api/users/route.ts': "import { db } from '@/lib/db';\nexport async function POST(req: Request) { const body = await req.json(); return Response.json(await db.user.create({ data: body })); }\n",
  'app/api/admin/route.ts': "import { exec } from 'child_process';\nimport { getSession } from '@/lib/session';\nexport async function POST(req: Request) { await getSession(); const { dir } = await req.json(); exec(`tar -czf backup.tgz ${dir}`); return Response.json({ ok: true }); }\n",
  'app/page.tsx': "import { Camera } from 'lucide-react';\nimport { FaGithub } from 'react-icons/fa';\nimport moment from 'moment';\nimport dayjs from 'dayjs';\nimport { Chat } from '@/components/Chat';\nexport default function Page({ post }: any) { const k = process.env.NEXT_PUBLIC_OPENAI_API_KEY; return <main><Camera /><FaGithub />{moment().format()}{dayjs().format()}<Chat /><div dangerouslySetInnerHTML={{ __html: post.body }} /></main>; }\n",
  'components/Chat.tsx': 'export function Chat() { return <div>chat</div> }\n',
  'components/ChatV2.tsx': 'export function Chat() { return <div>chat v2</div> }\n',
  'components/OldBanner.tsx': 'export function OldBanner() { return <div>old</div> }\n',
};

test('zomb --json finds every planted mistake', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-e2e-'));
  try {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
    }
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'init', '--trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>');

    const { summary, tasks } = JSON.parse(execFileSync(process.execPath, [cli, dir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const titles = tasks.map((t) => t.title);
    const has = (re) => assert.ok(titles.some((t) => re.test(t)), `expected a task matching ${re}\n${titles.join('\n')}`);

    has(/Stripe live key in the code/);
    has(/Committed \.env file/);
    has(/NEXT_PUBLIC_OPENAI_API_KEY is shipped to every browser/);
    has(/SQL built from a string/);
    has(/Shell command built from a string/);
    has(/\/api\/users changes data and touches database with no visible auth check/);
    has(/Raw HTML from a variable/);
    has(/Delete components\/ChatV2\.tsx/);
    has(/Delete components\/OldBanner\.tsx/);
    has(/Use one of your 2 icon sets/);
    has(/Use one of your 2 date libraries/);
    assert.ok(!titles.some((t) => /\/api\/admin.*no visible auth/.test(t)), 'the admin route calls getSession(), so it is not open');
    assert.ok(!JSON.stringify(tasks).includes(stripeKey.slice(8)), 'the key must never appear in the output');
    assert.equal(tasks[0].severity, 'high');
    assert.ok(summary.security.high >= 5);
    assert.ok(tasks.filter((t) => t.safe).every((t) => t.area === 'zombie'), 'only zombie clean-up is safe to automate');

    // The gate: save a baseline, then only new problems fail.
    const run = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [cli, dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
      } catch (e) {
        return { code: e.status, out: e.stdout };
      }
    };
    assert.equal(run('--fail-on', 'high', '--json').code, 1, 'known problems fail before there is a baseline');
    run('--save-baseline');
    assert.equal(run('--fail-on', 'high', '--json').code, 0, 'known problems pass once they are in the baseline');

    // A change that adds a new key and takes shortcuts.
    writeFileSync(path.join(dir, 'lib/github.ts'), `export const token = "${['ghp', 'Zq9rT4vWxyKm2Lp8Nc1Hs6Kd3Vb7Qe5Tr0Uy'].join('_')}";\n`);
    writeFileSync(path.join(dir, 'lib/db.ts'), files['lib/db.ts'] + '// @ts-ignore\nexport const n: number = "1";\n');
    mkdirSync(path.join(dir, 'test'), { recursive: true });
    writeFileSync(path.join(dir, 'test/db.test.ts'), "import { findUser } from '../lib/db';\nit.only('finds', () => { expect(findUser).toBeDefined() });\n");
    const gated = run('--since', 'HEAD', '--fail-on', 'high', '--json');
    const diffTasks = JSON.parse(gated.out).tasks;
    const diffTitles = diffTasks.map((t) => t.title);
    assert.equal(gated.code, 1, 'a new key fails the gate');
    assert.ok(diffTitles.includes('GitHub token in the code'));
    assert.ok(diffTitles.includes('Silences the type checker'));
    assert.ok(diffTitles.includes('Focuses one test, so CI silently skips the rest'));
    assert.ok(!diffTitles.includes('Stripe live key in the code'), 'unchanged files stay out of a --since report');
    assert.ok(diffTasks.find((t) => t.title === 'GitHub token in the code').new);
    assert.match(run('--since', 'HEAD', '--markdown').out, /new finding/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
