// The security mistakes AI-written code makes most: keys pasted into source, committed .env files, secrets shipped
// to the browser, API routes with no auth check, SQL/shell built from strings, and known-vulnerable packages.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isTest } from './score.js';

// ponytail: high-confidence provider patterns only; add gitleaks' rule set if teams need broader coverage
export const SECRET_PATTERNS = [
  ['Private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g],
  ['Stripe live key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{30,}/g],
  ['OpenAI API key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/g],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['Database URL with a password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^:/\s"'`]+:[^@/\s"'`]{6,}@(?!localhost|127\.0\.0\.1)[^\s"'`]+/g],
];
// built from variables (${pass}, {{token}}, %s) or obviously fake (ABCDEFGH, 12345678) is not a leaked key
const PLACEHOLDER = /example|xxxx|your[_-]?|dummy|fake|sample|placeholder|<|\*\*\*|changeme|:(password|pass|secret|postgres|root|admin|user)@|\$\{|\{\{|%s|abcdefgh|12345678|0123456/i;

// Show just enough of a secret to find it, never enough to use it: the report may get shared.
export const mask = (s) => `${s.slice(0, Math.min(8, Math.floor(s.length / 4)))}…`;

// text -> [{ kind, line, preview }]
export function findSecrets(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (l.length > 2000) return; // minified bundles
    for (const [kind, re] of SECRET_PATTERNS) for (const m of l.matchAll(re)) if (!PLACEHOLDER.test(m[0])) out.push({ kind, line: i + 1, preview: mask(m[0]) });
  });
  return out;
}

export const isEnvFile = (f) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f) && !/\.(example|sample|template|dist|defaults?)$/i.test(f);
// how many KEY=value lines actually hold a value
export const envValues = (text) => text.split('\n').filter((l) => /^\s*(export\s+)?[A-Z_][A-Z0-9_]*\s*=\s*['"]?[^'"\s#]/.test(l)).length;

// Browser-exposed env vars (NEXT_PUBLIC_, VITE_, ...) whose name says they are secret.
const PUBLIC_VAR = /\b(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|NUXT_PUBLIC|GATSBY)_([A-Z0-9_]+)/g;
const SENSITIVE = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|ADMIN_KEY/;
const SERVER_ONLY_PROVIDER = /OPENAI|ANTHROPIC|CLAUDE|GEMINI|GROQ|MISTRAL|COHERE|DEEPSEEK|OPENROUTER|REPLICATE|ELEVENLABS|STRIPE_SECRET|SUPABASE_SERVICE|GITHUB|RESEND|SENDGRID|POSTMARK|MAILGUN|TWILIO|AWS|PINECONE|DATABASE|MONGO|REDIS|FIREBASE_ADMIN/;
export function publicSecretNames(text) {
  const names = new Set();
  for (const m of text.matchAll(PUBLIC_VAR)) if (SENSITIVE.test(m[1]) || (SERVER_ONLY_PROVIDER.test(m[1]) && /(KEY|TOKEN)$/.test(m[1]))) names.add(m[0]);
  return [...names];
}

// Line patterns for string-built SQL/shell, eval, raw HTML and disabled TLS.
const DANGEROUS = [
  ['high', 'SQL built from a string (injection risk)', /\.(?:query|execute|raw|unsafe|\$queryRawUnsafe|\$executeRawUnsafe)\(\s*`[^`]*\$\{/],
  ['high', 'Shell command built from a string (injection risk)', /(?:(?<![.\w])|\b(?:child_?process|cp)\.)(?:exec|execSync)\(\s*(?:`[^`]*\$\{|[^)'"`,]*\+)/, 'shell'],
  ['medium', 'eval() or new Function() runs arbitrary code', /(?<![.\w])eval\(|\bnew Function\(/],
  // JSON-LD (JSON.stringify(schema)) and SCREAMING_CASE constants are the safe cases; plain .innerHTML = x was too noisy to keep
  ['medium', 'Raw HTML from a variable (XSS risk)', /dangerouslySetInnerHTML=\{\{\s*__html:(?!\s*(?:['"`]|JSON\.stringify\(|[A-Z][A-Z0-9_]*\s*\}))/],
  ['medium', 'TLS certificate checks turned off', /rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/],
];
// text -> [{ severity, kind, line }]; `shell` = the file imports child_process (so `re.exec(x + y)` isn't a shell call)
export function findDangerous(text, { shell = false } = {}) {
  const out = [];
  // const phaseScript = `...` (no ${}) in the same file: HTML the author wrote, not user input
  const constants = new Set([...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(?:(?!\2|\$\{)[\s\S])*\2/g)].map((m) => m[1]));
  text.split('\n').forEach((l, i) => {
    if (l.length > 2000 || /^\s*(\/\/|\*)/.test(l)) return;
    for (const [severity, kind, re, needs] of DANGEROUS) {
      if ((needs && !shell) || !re.test(l)) continue;
      if (kind.startsWith('Raw HTML') && constants.has(l.match(/__html:\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1])) continue;
      out.push({ severity, kind, line: i + 1 });
    }
  });
  return out;
}

// API route facts from its source: does it change data, and is there any sign of an auth or signature check?
const API_ROUTE = /(^|\/)app\/(.*\/)?route\.[cm]?[jt]sx?$|(^|\/)pages\/api\//;
const AUTH_SIGNAL = /\b(auth|getServerSession|getSession|currentUser|getToken|getAuth|protect|jwtVerify|constructEvent|constructEventAsync)\s*\(|\b(assert|ensure|require|check|verify|validate|get|with)(Auth|User|Session|Admin|Signed\w*|Logged\w*|Owner|Member|Access|Permission|Role|Token|Signature|Webhook|ApiKey|Key)\w*\s*\(|authorization|x-api-key|bearer/i;
export function routeFacts(file, src) {
  if (!API_ROUTE.test(file)) return null;
  const mutates = /export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(src) || (/(^|\/)pages\/api\//.test(file) && /req\.method/.test(src));
  return { mutates, authSignal: AUTH_SIGNAL.test(src) };
}
export const hasAuthSignal = (src) => AUTH_SIGNAL.test(src);
// app/api/users/[id]/route.ts -> /api/users/[id]
export const apiUrl = (file) => file.replace(/^(.*\/)?(app|pages)\//, '/').replace(/\/?route\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$/, '').replace(/\/\([^/]+\)/g, '') || '/';

// All findings, worst first: [{ severity:'high'|'medium', title, where, detail }]
export function securityFindings({ secrets, envFiles, publicVars, dangerous, openRoutes, audit }) {
  const out = [];
  const list = (files) => files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');
  for (const s of secrets) out.push({ severity: 'high', title: `${s.kind} in the code`, where: `${s.file}:${s.line}`, files: [s.file], detail: `${s.preview} is readable by anyone with access to the repo. Rotate it, then move it to an environment variable.` });
  for (const e of envFiles)
    out.push(
      e.committed
        ? { severity: 'high', title: 'Committed .env file', where: e.file, files: [e.file], detail: `${e.values} value${e.values > 1 ? 's are' : ' is'} in git history. Rotate them, remove the file and add it to .gitignore.` }
        : { severity: 'medium', title: '.env file not in .gitignore', where: e.file, files: [e.file], detail: `${e.values} value${e.values > 1 ? 's are' : ' is'} one \`git add .\` away from being committed. Add it to .gitignore.` },
    );
  for (const v of publicVars) out.push({ severity: 'high', title: `${v.name} is shipped to every browser`, where: list(v.files), files: v.files, key: v.name, detail: 'Variables with this prefix are bundled into client code, so a secret here is public. Rename it without the prefix and use it only on the server.' });
  if (audit?.top?.length) {
    const c = audit.counts;
    out.push({ severity: 'high', title: `${audit.top.length} vulnerable package${audit.top.length > 1 ? 's' : ''} in production (${[c.critical && `${c.critical} critical`, c.high && `${c.high} high`].filter(Boolean).join(', ')})`, where: 'npm audit', files: [], package: true, detail: audit.top.slice(0, 5).map((a) => `${a.name}: ${a.title}${a.fix ? '' : ' (no fix yet)'}`).join('; ') });
  }
  for (const d of dangerous) out.push({ severity: d.severity, title: d.kind, where: `${d.file}:${d.line}`, files: [d.file] });
  for (const r of openRoutes) out.push({ severity: 'medium', title: `${apiUrl(r.file)} ${r.why} with no visible auth check`, where: r.file, files: [r.file], detail: 'No login, session, API-key or signature check in the route or anything it imports. Fine if it is meant to be public; otherwise anyone can call it.' });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

// A route that changes data, or touches the database or payments, with no sign of auth anywhere in it or its imports.
export function openRoute(facts, touches) {
  if (!facts || facts.authSignal || touches.includes('auth')) return null;
  const risky = touches.filter((t) => t === 'database' || t === 'payments');
  if (!facts.mutates && !risky.length) return null;
  return [facts.mutates && 'changes data', risky.length && `touches ${risky.join(' and ')}`].filter(Boolean).join(' and ');
}

// ---------- IO ----------

// zomb's own report and baseline quote finding titles, so they are skipped too
const SKIP = /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp4|webm|mov|mp3|wav|ogg|wasm|lockb?)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|zomb-report\.html)$|(^|\/)\.zomb\//i;
// Scans every tracked text file (not just JS/TS): keys hide in JSON, YAML, markdown and .env files too.
export async function scanRepo(root, allFiles, tracked = new Set(allFiles)) {
  const secrets = [], envFiles = [], publicVars = new Map();
  let inTests = 0; // key-shaped strings in test files: almost always fakes for redaction tests, so counted, not listed
  for (const f of allFiles) {
    if (SKIP.test(f)) continue;
    const text = await readFile(path.join(root, f), 'utf8').catch(() => '');
    if (!text || text.length > 1e6 || text.includes('\0')) continue;
    if (isEnvFile(f)) {
      const values = envValues(text);
      if (values) envFiles.push({ file: f, values, committed: tracked.has(f) });
      continue; // a committed env file is reported whole
    }
    const found = findSecrets(text);
    if (isTest(f)) inTests += found.length;
    else for (const s of found) secrets.push({ file: f, ...s });
    for (const name of publicSecretNames(text)) publicVars.set(name, [...(publicVars.get(name) || []), f]);
  }
  return { secrets, envFiles, publicVars: [...publicVars].map(([name, files]) => ({ name, files })), inTests };
}

// Production dependencies with known vulnerabilities, from `npm audit` (needs package-lock.json).
export async function npmAudit(root) {
  if (!existsSync(path.join(root, 'package-lock.json'))) return { skipped: 'no package-lock.json (npm audit needs one)' };
  const out = await promisify(execFile)('npm', ['audit', '--json', '--omit=dev'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then(
    (r) => r.stdout,
    (e) => e.stdout, // npm audit exits 1 when it finds anything
  );
  try {
    const j = JSON.parse(out);
    const top = Object.values(j.vulnerabilities || {})
      .filter((v) => v.severity === 'critical' || v.severity === 'high')
      .map((v) => ({ name: v.name, severity: v.severity, direct: v.isDirect, title: v.via.find((x) => typeof x === 'object')?.title || `through ${v.via.join(', ')}`, fix: Boolean(v.fixAvailable) }))
      .sort((a, b) => (a.severity === b.severity ? Number(b.direct) - Number(a.direct) : a.severity === 'critical' ? -1 : 1));
    return { counts: j.metadata.vulnerabilities, top };
  } catch {
    return { skipped: 'npm audit failed (offline?)' };
  }
}
