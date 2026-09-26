// Pure logic: no IO here, so test/score.test.js can cover all of it.

// ponytail: heuristic agent list from trailers/authors; read git-ai notes + Entire checkpoints for exact attribution
// Only agent addresses: people who work at Anthropic/OpenAI/Cursor use the same domains.
const AGENT_EMAIL = /<(noreply@anthropic\.com|noreply@openai\.com|cursoragent@cursor\.com|noreply@aider\.chat)>$|\+?(copilot|claude|codex|devin-ai-integration|jules|cursor)[^@]*@users\.noreply\.github\.com/i;
const AGENT_BOT = /\b(claude|codex|copilot|cursor|devin|jules|gemini|aider|windsurf|opencode|amp|droid)\b.*\[bot\]$/i;

// "Name <email>" -> true when an AI agent wrote it. Human names like "Claude Monet <c@x.com>" stay human.
export const isAgent = (person) =>
  AGENT_EMAIL.test(person) || AGENT_BOT.test(person.replace(/\s*<.*$/, '')) || /\(aider\)/i.test(person);

// `git blame --porcelain` -> Map(sha -> number of lines it last touched)
export function parseBlame(text) {
  const counts = new Map();
  let sha = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) counts.set(sha, (counts.get(sha) || 0) + 1);
    else if (/^[0-9a-f]{40} \d+ \d+/.test(line)) sha = line.slice(0, 40);
  }
  return counts;
}

// A PR is only "reviewed" if a human other than the author reviewed it and didn't just rubber-stamp it.
export function classifyPR(pr) {
  const human = pr.reviews.filter((r) => !r.bot && r.author !== pr.author);
  if (!human.length) return 'unreviewed';
  const talked = pr.threads > 0 || human.some((r) => r.body.trim());
  const firstApproval = human.filter((r) => r.state === 'APPROVED').map((r) => Date.parse(r.at)).sort()[0];
  const fast = firstApproval && firstApproval - Date.parse(pr.lastCommitAt) < 120_000;
  return fast && !talked ? 'rubber' : 'reviewed';
}

export const QUADRANTS = {
  'delete-first': { label: 'Delete first', note: 'Unused, and nobody understands it' },
  danger: { label: 'Zombie code', note: 'Alive and running, but nobody has read it' },
  'safe-delete': { label: 'Safe to delete', note: 'Unused, but someone knows it' },
  healthy: { label: 'Healthy', note: 'Used and understood' },
};

// f: { path, lines, agentLines, agents:Set, unusedFile, unusedExports, referencedBy:string|null, pr:{number,state}|null }
export function scoreFile(f) {
  const evidence = [];
  const used = !f.unusedFile || Boolean(f.referencedBy);
  if (f.unusedFile && f.referencedBy) evidence.push(`Nothing imports it, but ${f.referencedBy} names its path: kept as used`);
  else if (f.unusedFile) evidence.push('Nothing imports or names this file (Knip + repo search)');
  if (f.unusedExports) evidence.push(`${f.unusedExports} unused export${f.unusedExports > 1 ? 's' : ''}`);

  const agentShare = f.lines ? f.agentLines / f.lines : 0;
  if (agentShare) evidence.push(`${Math.round(agentShare * 100)}% of lines last written by ${[...f.agents].join(', ') || 'an agent'}`);
  if (f.pr) evidence.push({ unreviewed: `PR #${f.pr.number} merged with no human review`, rubber: `PR #${f.pr.number} approved in under 2 min, no comments`, reviewed: `PR #${f.pr.number} had a real review` }[f.pr.state]);

  // ponytail: agent lines count as half-read after a real review; tune weights against dogfood repos
  const read = 1 - agentShare + agentShare * (f.pr?.state === 'reviewed' ? 0.5 : 0);
  const understood = read >= 0.5;
  const quadrant = used ? (understood ? 'healthy' : 'danger') : understood ? 'safe-delete' : 'delete-first';
  return { ...f, used, understood, read, quadrant, evidence };
}

// Group scored files by their first `depth` folders.
export function rollup(files, depth = 2) {
  const folders = new Map();
  for (const f of files) {
    const key = f.path.split('/').slice(0, -1).slice(0, depth).join('/') || '(root)';
    const row = folders.get(key) || { folder: key, total: 0, healthy: 0, danger: 0, 'safe-delete': 0, 'delete-first': 0 };
    row.total++;
    row[f.quadrant]++;
    folders.set(key, row);
  }
  return [...folders.values()].sort((a, b) => b.danger + b['delete-first'] - (a.danger + a['delete-first']) || b.total - a.total);
}
