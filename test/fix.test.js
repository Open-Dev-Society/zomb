// zomb fix end to end: deletes what's dead, keeps what a check proves is needed, never touches uncommitted work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChecks, packageManager, isTooling } from '../src/fix.js';

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.js');

test('findChecks picks the project checks, cheapest first, and skips the npm placeholder test', () => {
  const checks = findChecks({ build: 'next build', test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .', 'type-check': 'tsc --noEmit' }, 'pnpm');
  assert.deepEqual(checks.map((c) => `${c.label}: ${c.cmd} ${c.args.join(' ')}`), ['typecheck: pnpm run type-check', 'lint: pnpm run lint', 'build: pnpm run build']);
  assert.deepEqual(findChecks({}, 'npm', { tsc: true }).map((c) => c.label), ['typecheck']);
  assert.equal(packageManager(import.meta.dirname), 'npm');
  assert.deepEqual(['eslint-config-next', '@types/node', 'prettier-plugin-tailwindcss', '@tailwindcss/postcss', 'firebase', 'tw-animate-css', '@radix-ui/react-tabs'].filter(isTooling), ['eslint-config-next', '@types/node', 'prettier-plugin-tailwindcss', '@tailwindcss/postcss']);
});

test('zomb fix deletes dead code on a branch and keeps what a check proves is needed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-fix-'));
  try {
    const files = {
      'package.json': JSON.stringify({ name: 'fix-demo', private: true, main: 'index.ts', scripts: { typecheck: 'node check.js' } }),
      // a check that needs lib/needed.ts through a path nothing can see statically
      'check.js': "require('fs').accessSync(['lib', 'needed'].join('/') + '.ts');\n",
      'index.ts': "import { used } from './lib/used';\nconsole.log(used);\n",
      'lib/used.ts': 'export const used = 1;\nexport const unusedFn = () => 2;\n',
      'lib/needed.ts': 'export const needed = true;\n',
      'lib/dead.ts': 'export const dead = 1;\n',
      'lib/dead2.ts': 'export const dead2 = 2;\n',
      'scripts/seed.mjs': "console.log('seed');\n",
    };
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
    }
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Dev');
    git('config', 'user.email', 'dev@example.com');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const zomb = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [cli, 'fix', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (e) {
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
      }
    };

    // a dry run changes nothing
    const dry = zomb('--dry-run');
    assert.equal(dry.code, 0);
    assert.match(dry.out, /delete 3 dead files/);
    assert.match(dry.out, /scripts\/seed\.mjs/);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('branch', '--show-current'), 'main');

    // uncommitted work: refuse
    writeFileSync(path.join(dir, 'lib/used.ts'), `${files['lib/used.ts']}// wip\n`);
    const dirty = zomb();
    assert.equal(dirty.code, 1);
    assert.match(dirty.out, /uncommitted changes/);
    git('checkout', '--', '.');

    // the real run
    const run = zomb();
    assert.equal(run.code, 0, run.out);
    assert.match(git('branch', '--show-current'), /^zomb\/fix-/);
    assert.ok(!existsSync(path.join(dir, 'lib/dead.ts')) && !existsSync(path.join(dir, 'lib/dead2.ts')), 'dead files are gone');
    assert.ok(existsSync(path.join(dir, 'lib/needed.ts')), 'the file the check needs is kept');
    assert.match(run.out, /kept.*lib\/needed\.ts/);
    assert.ok(existsSync(path.join(dir, 'scripts/seed.mjs')), 'scripts are left for a human');
    assert.ok(!/export const unusedFn/.test(readFileSync(path.join(dir, 'lib/used.ts'), 'utf8')), 'the dead export is no longer exported');
    const log = git('log', '--format=%s', 'main..HEAD');
    assert.match(log, /zomb fix: delete 2 unused files/);
    assert.match(log, /zomb fix: remove unused exports/);
    assert.ok(!/wip/.test(log), 'one-by-one retries fold into one commit per batch');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'everything is committed');
    execFileSync(process.execPath, ['check.js'], { cwd: dir }); // and the project check still passes
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
