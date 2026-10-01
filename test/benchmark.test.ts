// The benchmark only speaks when there is enough history, and it counts the same way the study does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from '../src/benchmark.ts';

const commit = (date: string, agent: string | null, added: number, deleted: number) => ({ date, agent, files: [{ added, deleted }] });

test('benchmark compares this repo with the study, and stays quiet on thin history', () => {
  const commits = Array.from({ length: 10 }, (_, i) => commit(`2026-0${(i % 9) + 1}-01T00:00:00Z`, i < 6 ? 'Claude' : null, 500, 50));
  const b = benchmark(commits, [])!;
  assert.equal(b.deletedPer100, 10);
  assert.equal(b.agentShare, 60);
  assert.deepEqual(b.agentNames, ['Claude']);
  assert.equal(b.medianCommit, 500);
  assert.equal(b.added, 5000);
  assert.equal(b.humans, 33, 'the shipped baseline still has the human figure');
  assert.ok(b.agents.length >= 5 && b.agents[0].deletedPer100 <= b.agents.at(-1)!.deletedPer100, 'agents listed, tidiest first');

  assert.equal(benchmark(commits.slice(0, 2), []), null, 'two commits prove nothing');
  assert.equal(benchmark(Array.from({ length: 10 }, () => commit('2026-01-01T00:00:00Z', null, 50, 5)), []), null, '500 lines prove nothing');
  // commits before the study window are not comparable
  assert.equal(benchmark(commits.map((c) => ({ ...c, date: '2024-05-01T00:00:00Z' })), []), null);
});
