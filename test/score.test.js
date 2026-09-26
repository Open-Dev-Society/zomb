import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgent, parseBlame, classifyPR, scoreFile } from '../src/score.js';

test('isAgent spots agents, not humans who share a name', () => {
  assert.ok(isAgent('Claude Opus 5 <noreply@anthropic.com>'));
  assert.ok(isAgent('Cursor Agent <cursoragent@cursor.com>'));
  assert.ok(isAgent('copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>'));
  assert.ok(isAgent('Paul (aider) <paul@example.com>'));
  assert.ok(isAgent('claude[bot] <209825114+claude[bot]@users.noreply.github.com>'));
  assert.ok(!isAgent('Claude Monet <claude@monet.fr>'));
  assert.ok(!isAgent('Ashwin Bhat <ashwin@anthropic.com>'));
  assert.ok(!isAgent('dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'));
  assert.ok(!isAgent('Sampson Lee <sam@example.com>'));
});

test('parseBlame counts lines per commit', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const text = `${a} 1 1 2\nauthor X\n\tline1\n${a} 2 2\n\tline2\n${b} 1 3 1\nauthor Y\n\tline3\n`;
  assert.deepEqual([...parseBlame(text)], [[a, 2], [b, 1]]);
});

test('classifyPR: none, rubber stamp, real review', () => {
  const base = { author: 'ravi', lastCommitAt: '2026-09-27T10:00:00Z', threads: 0 };
  assert.equal(classifyPR({ ...base, reviews: [{ author: 'ravi', state: 'APPROVED', at: '2026-09-27T10:00:30Z', body: '' }] }), 'unreviewed');
  assert.equal(classifyPR({ ...base, reviews: [{ author: 'coderabbitai', bot: true, state: 'COMMENTED', at: '2026-09-27T10:01:00Z', body: 'lgtm' }] }), 'unreviewed');
  assert.equal(classifyPR({ ...base, reviews: [{ author: 'sam', state: 'APPROVED', at: '2026-09-27T10:01:00Z', body: '' }] }), 'rubber');
  assert.equal(classifyPR({ ...base, threads: 2, reviews: [{ author: 'sam', state: 'APPROVED', at: '2026-09-27T10:01:00Z', body: '' }] }), 'reviewed');
});

test('scoreFile puts files in the right quadrant', () => {
  const f = { path: 'src/a.ts', lines: 100, agentLines: 0, agents: new Set(), unusedExports: 0, referencedBy: null, pr: null };
  assert.equal(scoreFile({ ...f, unusedFile: false }).quadrant, 'healthy');
  assert.equal(scoreFile({ ...f, unusedFile: true }).quadrant, 'safe-delete');
  assert.equal(scoreFile({ ...f, unusedFile: true, agentLines: 90 }).quadrant, 'delete-first');
  assert.equal(scoreFile({ ...f, unusedFile: false, agentLines: 90 }).quadrant, 'danger');
  assert.equal(scoreFile({ ...f, unusedFile: true, referencedBy: 'action.yml', agentLines: 90 }).quadrant, 'danger');
  // 80% agent lines, real review -> 20% + 40% read = understood
  assert.equal(scoreFile({ ...f, unusedFile: false, agentLines: 80, pr: { number: 1, state: 'reviewed' } }).quadrant, 'healthy');
});
