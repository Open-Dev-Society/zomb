// Pure logic: no IO here, so test/score.test.js can cover all of it.

// ponytail: heuristic agent list from trailers/authors; read git-ai notes + Entire checkpoints for exact attribution
// Only agent addresses: people who work at Anthropic/OpenAI/Cursor use the same domains.
const AGENT_EMAIL = /<(noreply@anthropic\.com|noreply@openai\.com|cursoragent@cursor\.com|noreply@aider\.chat)>$|\+?(copilot|claude|codex|devin-ai-integration|jules|cursor)[^@]*@users\.noreply\.github\.com/i;
const AGENT_BOT = /\b(claude|codex|copilot|cursor|devin|jules|gemini|aider|windsurf|opencode|amp|droid)\b.*\[bot\]$/i;

// "Name <email>" -> true when an AI agent wrote it. Human names like "Claude Monet <c@x.com>" stay human.
export const isAgent = (person) =>
  AGENT_EMAIL.test(person) || AGENT_BOT.test(person.replace(/\s*<.*$/, '')) || /\(aider\)/i.test(person);

// `git blame --porcelain` -> the sha that last touched each line, in file order
export function parseBlame(text) {
  const shas = [];
  let sha = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) shas.push(sha);
    else if (/^[0-9a-f]{40} \d+ \d+/.test(line)) sha = line.slice(0, 40);
  }
  return shas;
}

// Careful review runs a few hundred lines an hour; approving faster than this with no comments is a rubber stamp.
// ponytail: fixed 1,000 lines/hour cut-off; make it configurable if teams push back
const MAX_REVIEW_RATE = 1000;

// -> { state: 'unreviewed' | 'rubber' | 'reviewed', lines, seconds } where seconds = last commit to first human approval
export function classifyPR(pr) {
  const lines = (pr.additions || 0) + (pr.deletions || 0);
  const human = pr.reviews.filter((r) => !r.bot && r.author !== pr.author);
  if (!human.length) return { state: 'unreviewed', lines, seconds: null };
  const talked = pr.threads > 0 || human.some((r) => r.body.trim());
  const firstApproval = human.filter((r) => r.state === 'APPROVED').map((r) => Date.parse(r.at)).sort()[0];
  const seconds = firstApproval ? Math.max(0, (firstApproval - Date.parse(pr.lastCommitAt)) / 1000) : null;
  const tooFast = seconds !== null && (seconds < 120 || lines / Math.max(seconds / 3600, 1 / 60) > MAX_REVIEW_RATE);
  return { state: tooFast && !talked ? 'rubber' : 'reviewed', lines, seconds };
}

const duration = (s) => (s < 90 ? `${Math.round(s)} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${Math.round(s / 3600)} hours`);
export const prEvidence = (pr) =>
  ({
    unreviewed: `PR #${pr.number} (${pr.lines.toLocaleString('en-US')} lines) merged with no human review`,
    rubber: `PR #${pr.number}: ${pr.lines.toLocaleString('en-US')} lines approved ${duration(pr.seconds)} after the last commit, no comments`,
    reviewed: `PR #${pr.number} had a real review`,
  })[pr.state];

// What a file can hurt. Judged from its imports (and a few source patterns), so it stays cheap and explainable.
const SURFACES = [
  ['payments', /^(stripe|@stripe\/|razorpay|dodopayments|@dodopayments\/|@paddle\/|@lemonsqueezy\/|braintree|@paypal\/)/],
  ['auth', /^(next-auth|@auth\/|jsonwebtoken|jose|bcrypt|bcryptjs|argon2|@clerk\/|lucia|passport|better-auth|iron-session|@kinde-oss\/|@supabase\/ssr)/],
  ['database', /^(pg|postgres|mysql2?|mongodb|mongoose|@prisma\/client|drizzle-orm|@supabase\/supabase-js|kysely|ioredis|redis|better-sqlite3|sqlite3|@neondatabase\/|@planetscale\/|@libsql\/|@vercel\/postgres|@vercel\/kv|@upstash\/redis|firebase-admin)/],
  ['shell', /^(node:)?child_process$/],
  ['network', /^(axios|got|ky|undici|node-fetch|openai|@anthropic-ai\/|resend|nodemailer|twilio)/],
];
export const SURFACE_WEIGHT = { payments: 3, auth: 3, database: 2, secrets: 2, shell: 2, endpoint: 2, network: 1 };

export function surfacesOf(file, specs, src) {
  const tags = new Set(SURFACES.filter(([, re]) => specs.some((s) => re.test(s))).map(([tag]) => tag));
  if (/\bfetch\(/.test(src)) tags.add('network');
  // NEXT_PUBLIC_/VITE_/PUBLIC_ keys ship to the browser on purpose, so they aren't secrets
  if (/process\.env\.(?!NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_)\w*(SECRET|KEY|TOKEN|PASSWORD|PRIVATE)/i.test(src)) tags.add('secrets');
  if (/(^|\/)(app\/(.*\/)?route\.[cm]?[jt]sx?|pages\/api\/.+)$/.test(file)) tags.add('endpoint');
  return [...tags];
}

// git log records -> path -> { changes, fixes } within the last `days`
export function churn(history, now = Date.now(), days = 90) {
  const out = new Map();
  for (const c of history) {
    if (now - Date.parse(c.date) > days * 864e5) continue;
    const fix = /\b(fix|fixes|fixed|bug|hotfix|revert|patch)\b/i.test(c.subject);
    for (const { path } of c.files) {
      const row = out.get(path) || { changes: 0, fixes: 0 };
      row.changes++;
      if (fix) row.fixes++;
      out.set(path, row);
    }
  }
  return out;
}

// git log records -> [{ month:'2026-03', agent, human }] lines of JS/TS added per month
export function timeline(history, agentOf) {
  const months = new Map();
  for (const c of history) {
    const month = c.date.slice(0, 7);
    const row = months.get(month) || { month, agent: 0, human: 0 };
    const added = c.files.reduce((n, f) => n + f.added, 0);
    row[agentOf.get(c.sha) ? 'agent' : 'human'] += added;
    months.set(month, row);
  }
  return [...months.values()].filter((m) => m.agent + m.human).sort((a, b) => a.month.localeCompare(b.month));
}

export const QUADRANTS = {
  'delete-first': { label: 'Delete first', note: 'Unused, and nobody understands it' },
  danger: { label: 'Zombie code', note: 'Alive and running, but nobody has read it' },
  'safe-delete': { label: 'Safe to delete', note: 'Unused, but someone knows it' },
  healthy: { label: 'Healthy', note: 'Used and understood' },
};

// f: { path, lines, agentLines, agents:Set, unusedFile, unusedExports, referencedBy, pr, dependents, touches[], churn:{changes,fixes} }
export function scoreFile(f) {
  const evidence = [];
  const used = !f.unusedFile || Boolean(f.referencedBy);
  if (f.unusedFile && f.referencedBy) evidence.push(`Nothing imports it, but ${f.referencedBy} names its path: kept as used`);
  else if (f.unusedFile) evidence.push('Nothing imports or names this file (Knip + repo search)');
  if (f.unusedExports) evidence.push(`${f.unusedExports} unused export${f.unusedExports > 1 ? 's' : ''}`);
  if (f.dependents) evidence.push(`${f.dependents} file${f.dependents > 1 ? 's' : ''} depend on it`);
  if (f.touches?.length) evidence.push(`Touches ${f.touches.join(', ')}`);
  if (f.churn?.changes) evidence.push(`Changed ${f.churn.changes} time${f.churn.changes > 1 ? 's' : ''} in 90 days${f.churn.fixes ? `, ${f.churn.fixes} of them fixes` : ''}`);

  const agentShare = f.lines ? f.agentLines / f.lines : 0;
  if (agentShare) evidence.push(`${Math.round(agentShare * 100)}% of lines last written by ${[...f.agents].join(', ') || 'an agent'}`);
  if (f.pr) evidence.push(prEvidence(f.pr));

  // ponytail: agent lines count as half-read after a real review; tune weights against dogfood repos
  const read = 1 - agentShare + agentShare * (f.pr?.state === 'reviewed' ? 0.5 : 0);
  const understood = read >= 0.5;
  const quadrant = used ? (understood ? 'healthy' : 'danger') : understood ? 'safe-delete' : 'delete-first';
  return { ...f, used, understood, read, quadrant, evidence, risk: riskOf({ ...f, read }) };
}

// How much an unread file can hurt: unread share x reach x what it touches x how hot it is x size.
// ponytail: hand-set multipliers, only used for ranking; calibrate against incidents once teams share them
export function riskOf(f) {
  const unread = 1 - f.read;
  const reach = 1 + Math.log2(1 + (f.dependents || 0));
  const touch = 1 + (f.touches || []).reduce((n, t) => n + (SURFACE_WEIGHT[t] || 0), 0);
  const heat = 1 + Math.log2(1 + (f.churn?.changes || 0)) + (f.churn?.fixes || 0) * 0.5;
  const size = 1 + Math.log10(1 + (f.lines || 0) / 100);
  return unread * reach * touch * heat * size;
}

// ponytail: 10 lines a minute reading estimate
export const READ_LINES_PER_MIN = 10;

// Riskiest zombie files first, until they cover `target` of all zombie risk, `max` files, or about `budget` minutes of reading.
export function readingPlan(files, target = 0.6, max = 8, budget = 60) {
  const zombies = files.filter((f) => f.quadrant === 'danger' && f.risk > 0).sort((a, b) => b.risk - a.risk);
  const total = zombies.reduce((n, f) => n + f.risk, 0);
  const plan = [];
  let covered = 0;
  let minutes = 0;
  for (const f of zombies) {
    const cost = f.lines / READ_LINES_PER_MIN;
    if (plan.length >= max || (total && covered / total >= target)) break;
    if (plan.length && minutes + cost > budget) continue; // too long for this hour: try the next riskiest
    plan.push(f);
    covered += f.risk;
    minutes += cost;
  }
  const lines = plan.reduce((n, f) => n + f.lines, 0);
  return { files: plan, minutes: Math.ceil(lines / READ_LINES_PER_MIN), coverage: total ? covered / total : 0, zombies: zombies.length };
}

// Names that every framework file exports: two route files both exporting GET is not a duplicate.
const CONVENTION = new Set(['default', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'metadata', 'generateMetadata', 'generateStaticParams', 'viewport', 'config', 'runtime', 'dynamic', 'revalidate', 'maxDuration', 'fetchCache', 'preferredRegion', 'middleware', 'handler', 'loader', 'action', 'alt', 'size', 'contentType']);

// parsed: Map(path -> { exported:[names] }) -> [{ name, files }] for names defined in 2+ files
export function sameNames(parsed) {
  const byName = new Map();
  for (const [file, p] of parsed) for (const name of new Set(p.exported)) if (!CONVENTION.has(name)) byName.set(name, [...(byName.get(name) || []), file]);
  return [...byName].filter(([, files]) => files.length > 1).map(([name, files]) => ({ name, files })).sort((a, b) => b.files.length - a.files.length);
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
