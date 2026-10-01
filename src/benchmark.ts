// How this repo compares with the 336 public repos measured in The State of AI Code.
// Same arithmetic as the study, over the same window, so the two numbers are comparable.
import { createRequire } from 'node:module';
import type { Month } from './types.ts';

type Author = { deletedPer100: number; medianCommit: number; addedShare: number };
type Baseline = { study: { repos: number; commits: number; lines: number; since: string; url: string }; authors: Record<string, Author> };
const baseline: Baseline = createRequire(import.meta.url)('./baseline.json');

export type Benchmark = {
  study: Baseline['study'];
  /** lines deleted per 100 added, this repo vs the humans and the agents in the study */
  deletedPer100: number;
  humans: number;
  agents: { name: string; deletedPer100: number }[];
  /** share of added lines an agent signed, and the agents that signed them */
  agentShare: number;
  agentNames: string[];
  medianCommit: number;
  humanMedianCommit: number;
  commits: number;
  added: number;
};

/**
 * history: every commit, newest or oldest first, with the agent that signed it (null = human).
 * Returns null when there is too little history in the window to say anything.
 */
export function benchmark(history: { date: string; agent: string | null; files: { added: number; deleted: number }[] }[], months: Month[]): Benchmark | null {
  const since = baseline.study.since;
  const inWindow = history.filter((c) => c.date >= since);
  const added = inWindow.reduce((s, c) => s + c.files.reduce((n, f) => n + f.added, 0), 0);
  // the study pools whole repos; under a few thousand lines the ratio swings on one commit
  if (added < 2000 || inWindow.length < 5) return null;
  const deleted = inWindow.reduce((s, c) => s + c.files.reduce((n, f) => n + f.deleted, 0), 0);
  const agentLines = inWindow.filter((c) => c.agent).reduce((s, c) => s + c.files.reduce((n, f) => n + f.added, 0), 0);
  const sizes = inWindow.map((c) => c.files.reduce((n, f) => n + f.added, 0)).sort((a, b) => a - b);
  const { Human, ...agents } = baseline.authors;
  return {
    study: baseline.study,
    deletedPer100: Math.round((deleted / added) * 100),
    humans: Math.round(Human.deletedPer100),
    agents: Object.entries(agents)
      .map(([name, a]) => ({ name, deletedPer100: Math.round(a.deletedPer100) }))
      .sort((a, b) => a.deletedPer100 - b.deletedPer100),
    agentShare: Math.round((agentLines / added) * 100),
    agentNames: [...new Set(inWindow.map((c) => c.agent).filter((a): a is string => Boolean(a)))].sort(),
    medianCommit: sizes[Math.floor(sizes.length / 2)],
    humanMedianCommit: Human.medianCommit,
    commits: inWindow.length,
    added,
  };
}
