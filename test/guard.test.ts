// zomb guard: what it stops, what it only notes, and what it must let through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check } from '../src/guard.ts';

const bin = path.join(import.meta.dirname, '..', 'src', 'bin.ts');
const stripeKey = ['sk', 'live', 'Q7mZp2Lx9Rt4Vb8Nc1Hs6Kd3'].join('_');

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-guard-'));
  const files = {
    'package.json': JSON.stringify({ dependencies: { 'react-icons': '5.0.0', next: '15.0.0' } }),
    'src/Chat.tsx': 'export function Chat() { return null }\n',
    'src/lib/format.ts': 'export function formatCurrency(n: number) { return `$${n}` }\n',
    'src/pay.ts': "// @ts-ignore\nexport const total = (x) => x;\n",
    '.gitignore': '.env\n',
  };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('guard stops the mess before it lands', () => {
  const dir = repo();
  try {
    const write = (file_path, content) => check({ file_path, content }, dir);
    const edit = (file_path, old_string, new_string) => check({ file_path, old_string, new_string }, dir);

    // shortcuts
    assert.match(write('src/a.ts', '// @ts-ignore\nconst x: number = "1";\n').deny[0], /^line 1: silences the type checker/);
    assert.match(write('src/a.test.ts', "it.only('works', () => {});\n").deny[0], /focuses one test/);
    assert.match(write('src/b.ts', '// eslint-disable-next-line no-console\nconsole.log(1);\n').deny[0], /turns off a lint rule/);
    assert.deepEqual(write('src/b.ts', '// eslint-disable-next-line no-console -- CLI output is the point\nconsole.log(1);\n').deny, [], 'eslint "-- reason" is a deliberate, explained disable');
    assert.deepEqual(write('src/b.ts', '// @ts-ignore zomb-allow: vendor types are wrong\nconst x = 1;\n').deny, [], 'zomb-allow is the escape hatch');
    assert.deepEqual(write('src/c.ts', 'const y = z as any;\n').deny, [], 'as any only warns');
    assert.match(write('src/c.ts', 'const y = z as any;\n').warn[0], /casts to any/);

    // an edit is judged on what it adds: removing a suppression is fine, and old lines aren't blamed
    assert.deepEqual(edit('src/pay.ts', '// @ts-ignore\nexport const total = (x) => x;', 'export const total = (x: number) => x;').deny, []);
    assert.match(edit('src/pay.ts', 'export const total = (x) => x;', 'export const total = (x) => x;\n// @ts-nocheck').deny[0], /^line 3:/);

    // keys and browser secrets, masked, but .env files are where keys belong
    const key = write('src/stripe.ts', `export const s = new Stripe("${stripeKey}");\n`).deny[0];
    assert.match(key, /Stripe live key/);
    assert.ok(!key.includes(stripeKey.slice(8)), 'the key never appears in the message');
    assert.match(write('src/ai.ts', 'const k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n').deny[0], /ships to every browser/);
    assert.deepEqual(write('.env', `STRIPE_SECRET_KEY=${stripeKey}\n`).deny, []);

    // injection
    assert.match(write('src/db.ts', 'await db.query(`SELECT * FROM users WHERE id = ${id}`);\n').deny[0], /sql built from a string/);

    // a second version of an existing file
    assert.match(write('src/ChatV2.tsx', 'export function Chat() { return 2 }\n').deny[0], /looks like a new version of src\/Chat\.tsx/);
    assert.deepEqual(write('src/Toast.tsx', 'export function Toast() { return 1 }\n').deny, []);

    // a second library for the same job
    assert.match(write('src/Icon.tsx', "import { Camera } from 'lucide-react';\n").deny[0], /already uses react-icons/);
    assert.deepEqual(write('src/Icon.tsx', "import { FaGithub } from 'react-icons/fa';\n").deny, []);
    assert.deepEqual(write('src/Date.tsx', "import dayjs from 'dayjs';\n").deny, [], 'the first date library is fine');

    // re-creating something that already exists only warns
    assert.match(write('src/utils/money.ts', 'export function formatCurrency(n: number) { return n }\n').warn[0], /formatCurrency already exists in src\/lib\/format\.ts/);

    // files outside the project are none of our business
    assert.deepEqual(write('../elsewhere.ts', '// @ts-ignore\n'), { deny: [], warn: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook speaks Claude Code: deny with a reason, notes as context, silence when clean', () => {
  const dir = repo();
  try {
    const hook = (tool_name, tool_input) => execFileSync(process.execPath, [bin, 'guard'], { input: JSON.stringify({ tool_name, tool_input, cwd: dir, hook_event_name: 'PreToolUse' }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    const denied = JSON.parse(hook('Write', { file_path: path.join(dir, 'src/a.ts'), content: '// @ts-ignore\nconst x = 1;\n' })).hookSpecificOutput;
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /zomb guard stopped this edit to src\/a\.ts/);
    assert.match(JSON.parse(hook('Write', { file_path: path.join(dir, 'src/a.ts'), content: '// @ts-ignore\nconst x = 1;\n' })).systemMessage, /blocked an edit to src\/a\.ts\n   ✗ line 1: silences the type checker/);
    const noted = JSON.parse(hook('Edit', { file_path: path.join(dir, 'src/Chat.tsx'), old_string: 'return null', new_string: 'return (x as any)' })).hookSpecificOutput;
    assert.equal(noted.permissionDecision, undefined);
    assert.match(noted.additionalContext, /casts to any/);
    assert.equal(hook('Write', { file_path: path.join(dir, 'src/ok.ts'), content: 'export const ok = 1;\n' }), '');
    assert.equal(hook('Read', { file_path: path.join(dir, 'src/ok.ts') }), '');
    assert.equal(execFileSync(process.execPath, [bin, 'guard'], { input: 'not json', encoding: 'utf8' }), '', 'garbage in: let the edit through');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
