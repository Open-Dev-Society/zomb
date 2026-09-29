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

// What a file can hurt, from its imports (and a few source patterns).
const SURFACES = [
  ['payments', /^(stripe|@stripe\/|razorpay|dodopayments|@dodopayments\/|@paddle\/|@lemonsqueezy\/|braintree|@paypal\/)/],
  ['auth', /^(next-auth|@auth\/|jsonwebtoken|jose|bcrypt|bcryptjs|argon2|@clerk\/|lucia|passport|better-auth|iron-session|@kinde-oss\/|@supabase\/ssr)/],
  ['database', /^(pg|postgres|mysql2?|mongodb|mongoose|@prisma\/client|drizzle-orm|@supabase\/supabase-js|kysely|ioredis|redis|better-sqlite3|sqlite3|@neondatabase\/|@planetscale\/|@libsql\/|@vercel\/postgres|@vercel\/kv|@upstash\/redis|firebase-admin)/],
  ['shell', /^(node:)?child_process$/],
];
export function surfacesOf(specs, src) {
  const tags = new Set(SURFACES.filter(([, re]) => specs.some((s) => re.test(s))).map(([tag]) => tag));
  // NEXT_PUBLIC_/VITE_/PUBLIC_ keys ship to the browser on purpose, so they aren't secrets
  if (/process\.env\.(?!NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_)\w*(SECRET|KEY|TOKEN|PASSWORD|PRIVATE)/i.test(src)) tags.add('secrets');
  return [...tags];
}

// ---------- zombie code: in the codebase, not in use ----------

const TEST = /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright|fixtures?)\/|\.(test|spec|stories|story|bench)\.[cm]?[jt]sx?$/;
// Files a framework or runtime loads by name, so having no importer (or only test importers) doesn't make them dead.
const ENTRY = /(^|\/)(page|layout|route|loading|error|not-found|template|default|middleware|instrumentation|global-error|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$|(^|\/)(index|main|server|cli|app)\.[cm]?[jt]sx?$|(^|\/)(bin|scripts|pages)\//;
export const isTest = (f) => TEST.test(f);
const isEntry = (f) => ENTRY.test(f);

// Files that only tests (or other test-only files) import: their tests keep them alive, nothing else does.
// parsed: Map(path -> { imports:[paths] }); keep: files known to be live (e.g. started by path from action.yml)
export function testsOnly(parsed, keep = new Set()) {
  const importers = new Map();
  for (const [file, p] of parsed) for (const dep of p.imports) importers.set(dep, [...(importers.get(dep) || []), file]);
  const only = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of parsed.keys()) {
      if (only.has(file) || isTest(file) || isEntry(file) || keep.has(file)) continue;
      const ups = importers.get(file) || [];
      if (ups.length && ups.every((u) => isTest(u) || only.has(u))) only.add(file), (changed = true);
    }
  }
  return only;
}

// Next.js page/API route file -> { url, prefix, kind:'page'|'api' } (prefix = the static part before the first [param]); null for other files.
// Routes that outside services call by design (webhooks, auth callbacks, crons, SEO files) are skipped.
export function routeOf(file) {
  const app = file.match(/(?:^|\/)app\/((?:.*\/)?)(?:page|route)\.[cm]?[jt]sx?$/);
  const pages = !app && file.match(/(?:^|\/)pages\/(.+)\.[cm]?[jt]sx?$/);
  let segs;
  if (app) segs = app[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  else if (pages && !/(^|\/)_(app|document|error)$|(^|\/)(404|500)$/.test(pages[1])) segs = pages[1].split('/').filter((s) => s !== 'index');
  else return null;
  if (segs.some((s) => s.startsWith('('))) return null; // intercepting routes
  const url = `/${segs.join('/')}`;
  const external = segs.some((s) => /^(\.well-known|auth|oauth|cron|og|opengraph-image|twitter-image|feed|rss|health|healthz|status|ping|sitemap(\.xml)?|robots(\.txt)?)$/i.test(s));
  if (url === '/' || external || /webhook|callback/i.test(url)) return null;
  const prefix = url.split('/[')[0];
  const kind = (app ? /(^|\/)route\.[cm]?[jt]sx?$/.test(file) : segs[0] === 'api') ? 'api' : 'page';
  return prefix && prefix !== '/' ? { url, prefix, kind } : null;
}

// ---------- sprawl: AI keeps creating, never deleting ----------

// git log records -> [{ month:'2026-03', added, deleted }] lines of JS/TS per month
export function growth(history) {
  const months = new Map();
  for (const c of history) {
    const month = c.date.slice(0, 7);
    const row = months.get(month) || { month, added: 0, deleted: 0 };
    for (const f of c.files) (row.added += f.added), (row.deleted += f.deleted);
    months.set(month, row);
  }
  return [...months.values()].filter((m) => m.added + m.deleted).sort((a, b) => a.month.localeCompare(b.month));
}

// Files and folders whose name says "another version of something": LandingV2, api-old, utils copy, ov2/, legacy/.
const VERSIONED = /^(.+?)(?:[-_. ]?(?:v\d+|new|old|copy|backup|bak|legacy|temp|tmp|final|fixed|deprecated|unused|draft)|(?<=[a-z0-9])(?:V\d+|New|Old|Copy|Backup|Legacy|Temp|Final|Fixed|Deprecated|Draft))$/;
const VERSIONED_DIR = /^(v\d+|old|legacy|backup|deprecated|archive|unused|temp|tmp|[a-z]{1,3}v\d+)$/i;
// -> [{ path, original|null }] for files, then [{ path:'dir/', files:N }] for versioned folders (counted once, not per file)
export function versionSprawl(files) {
  const set = new Set(files);
  const out = [];
  const folders = new Map();
  for (const f of files) {
    if (isTest(f)) continue;
    const dir = f.slice(0, f.lastIndexOf('/') + 1);
    const segs = dir.split('/');
    const at = segs.findIndex((seg) => VERSIONED_DIR.test(seg));
    if (at >= 0) {
      const folder = `${segs.slice(0, at + 1).join('/')}/`;
      folders.set(folder, (folders.get(folder) || 0) + 1);
      continue;
    }
    const [, stem, ext] = f.slice(dir.length).match(/^(.*?)((?:\.[a-z0-9]+)+)$/i) || [null, f.slice(dir.length), ''];
    const m = stem.match(VERSIONED);
    if (m && m[1].length > 1) out.push({ path: f, original: set.has(`${dir}${m[1]}${ext}`) ? `${dir}${m[1]}${ext}` : null });
  }
  return [...out, ...[...folders].map(([path, n]) => ({ path, files: n, original: null }))];
}

// Libraries that do the same job. Aliases fold a library's companion packages into one.
const OVERLAP = {
  'icon sets': ['lucide-react', 'react-icons', '@heroicons/react', '@tabler/icons-react', '@phosphor-icons/react', '@radix-ui/react-icons', 'react-feather', '@fortawesome/react-fontawesome', '@mui/icons-material', 'iconoir-react', '@remixicon/react'],
  'date libraries': ['moment', 'dayjs', 'date-fns', 'luxon'],
  'HTTP clients': ['axios', 'got', 'ky', 'node-fetch', 'superagent', 'ofetch'],
  'animation libraries': ['framer-motion', 'motion', 'gsap', 'react-spring', 'animejs', 'lottie-react'],
  'state managers': ['redux', 'zustand', 'jotai', 'recoil', 'mobx', 'valtio'],
  'form libraries': ['react-hook-form', 'formik', '@tanstack/react-form', 'react-final-form'],
  'validation libraries': ['zod', 'yup', 'joi', 'valibot', 'superstruct'],
  'CSS-in-JS libraries': ['styled-components', 'emotion', '@stitches/react', '@vanilla-extract/css'],
  'toast libraries': ['sonner', 'react-hot-toast', 'react-toastify', 'notistack'],
  'chart libraries': ['recharts', 'chart.js', 'nivo', 'victory', 'visx', 'apexcharts', 'echarts', 'd3', 'highcharts'],
  'UI kits': ['@mui/material', '@chakra-ui/react', 'antd', '@mantine/core', '@nextui-org/react', '@heroui/react', 'react-bootstrap', 'semantic-ui-react'],
  'markdown renderers': ['react-markdown', 'marked', 'markdown-it', 'showdown'],
  'data-fetching libraries': ['swr', '@tanstack/react-query'],
  ORMs: ['@prisma/client', 'drizzle-orm', 'kysely', 'typeorm', 'sequelize', 'mongoose', 'knex'],
};
const ALIAS = { '@reduxjs/toolkit': 'redux', 'react-redux': 'redux', 'react-chartjs-2': 'chart.js', 'echarts-for-react': 'echarts', 'react-apexcharts': 'apexcharts', '@emotion/react': 'emotion', '@emotion/styled': 'emotion', '@react-spring/web': 'react-spring', 'react-query': '@tanstack/react-query' };
export const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const family = (pkg) => ALIAS[pkg] || (pkg.startsWith('@nivo/') ? 'nivo' : pkg.startsWith('@visx/') ? 'visx' : pkg.startsWith('d3-') ? 'd3' : pkg);
// packages: Map(package name -> [files importing it]) -> [{ job, libraries:[{ name, files }] }]
export function overlaps(packages) {
  const out = [];
  for (const [job, libs] of Object.entries(OVERLAP)) {
    const used = new Map();
    for (const [pkg, files] of packages) if (libs.includes(family(pkg))) used.set(family(pkg), [...new Set([...(used.get(family(pkg)) || []), ...files])]);
    if (used.size > 1) out.push({ job, libraries: [...used].map(([name, files]) => ({ name, files: files.length })).sort((a, b) => b.files - a.files) });
  }
  return out;
}

// Names that every framework file exports: two route files both exporting GET is not a duplicate.
const CONVENTION = new Set(['default', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'metadata', 'generateMetadata', 'generateStaticParams', 'viewport', 'config', 'runtime', 'dynamic', 'revalidate', 'maxDuration', 'fetchCache', 'preferredRegion', 'middleware', 'handler', 'loader', 'action', 'alt', 'size', 'contentType']);

// parsed: Map(path -> { exported:[names] }) -> [{ name, files }] for names defined in 2+ files
export function sameNames(parsed) {
  const byName = new Map();
  for (const [file, p] of parsed) for (const name of new Set(p.exported)) if (!CONVENTION.has(name) && !isTest(file)) byName.set(name, [...(byName.get(name) || []), file]);
  return [...byName].filter(([, files]) => files.length > 1).map(([name, files]) => ({ name, files })).sort((a, b) => b.files.length - a.files.length);
}

// ---------- architecture ----------

// Import cycles (runtime imports only; type imports vanish at build time). graph: Map(path -> [paths]) -> [[paths]]
// ponytail: recursive Tarjan; switch to an explicit stack if a repo has import chains thousands deep
export function cycles(graph) {
  let index = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const visit = (v) => {
    idx.set(v, index), low.set(v, index++), stack.push(v), on.add(v);
    for (const w of graph.get(v) || []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) visit(w), low.set(v, Math.min(low.get(v), low.get(w)));
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do (w = stack.pop()), on.delete(w), scc.push(w);
      while (w !== v);
      if (scc.length > 1) out.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => b.length - a.length);
}

// Where shared code lives: every utils/lib/helpers/shared/common folder. Several of them means nobody knows where to look.
export function sharedFolders(files) {
  const dirs = new Set();
  for (const f of files) {
    if (isTest(f)) continue;
    const segs = f.split('/').slice(0, -1);
    const i = segs.findIndex((s) => /^(utils?|libs?|helpers?|common|shared|core)$/i.test(s));
    if (i >= 0) dirs.add(segs.slice(0, i + 1).join('/'));
  }
  return [...dirs].sort();
}

// Component file naming: PascalCase vs kebab-case vs camelCase. Mixed styles make files hard to guess.
export function namingStyles(files) {
  const count = { PascalCase: 0, 'kebab-case': 0, camelCase: 0, snake_case: 0 };
  for (const f of files) {
    if (!/\.[jt]sx$/.test(f) || isTest(f) || isEntry(f)) continue;
    const stem = f.slice(f.lastIndexOf('/') + 1).replace(/\.[jt]sx$/, '');
    if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) count.PascalCase++;
    else if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(stem)) count['kebab-case']++;
    else if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(stem)) count.camelCase++;
    else if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(stem)) count.snake_case++;
  }
  return Object.entries(count).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
}
