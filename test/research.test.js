// The State of AI Code measures commits: check who gets credit for what, on a tiny repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentOf, history } from '../research/state-of-ai-code.js';

test('agentOf names the agent from the author or a trailer, and humans stay human', () => {
  assert.equal(agentOf(['Dev <dev@example.com>', 'Claude <noreply@anthropic.com>']), 'Claude');
  assert.equal(agentOf(['Copilot <198982749+Copilot@users.noreply.github.com>', 'Dev <dev@example.com>']), 'Copilot');
  assert.equal(agentOf(['Dev <dev@example.com>', 'Cursor Agent <cursoragent@cursor.com>']), 'Cursor');
  assert.equal(agentOf(['google-labs-jules[bot] <161369871+google-labs-jules[bot]@users.noreply.github.com>']), 'Jules');
  assert.equal(agentOf(['Claude Monet <claude@monet.fr>']), 'Human');
});

test('history credits each commit, skips the root commit, and reads what the added lines do', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zomb-research-'));
  try {
    const write = (f, body) => (mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), body));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    write('src/Chat.tsx', 'export const Chat = 1;\n');
    write('src/chat.test.ts', "it('works', () => {});\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'scaffold');
    write('src/ChatV2.tsx', '// @ts-ignore\nexport const Chat = 2 as any;\n');
    write('dist/bundle.js', 'x\n'.repeat(10));
    git('add', '-A');
    git('commit', '-q', '-m', 'v2', '--trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>');
    git('rm', '-q', 'src/chat.test.ts');
    git('commit', '-q', '-m', 'drop test', '--trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>');
    write('src/Chat.tsx', 'export const Chat = 1;\nexport const more = 2;\n');
    git('commit', '-q', '-am', 'human edit');

    const commits = await history(dir);
    assert.deepEqual(commits.map((c) => [c.agent, c.counted]), [['Human', false], ['Claude', true], ['Claude', true], ['Human', true]], 'oldest first; the root commit is not counted');
    const [, v2, drop, edit] = commits;
    assert.deepEqual(v2.files.map((f) => f.path), ['src/ChatV2.tsx'], 'build output is skipped');
    assert.deepEqual(v2.files[0].shortcuts, { 'Silences the type checker': 1, 'Casts to any': 1 });
    assert.ok(v2.files[0].isNew);
    assert.deepEqual([drop.files[0].path, drop.files[0].gone], ['src/chat.test.ts', true]);
    assert.deepEqual([edit.files[0].added, edit.files[0].deleted], [1, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
