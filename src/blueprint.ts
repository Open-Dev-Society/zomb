// Blueprint: the rules a codebase already follows, inferred from its code, approved once as .zomb/blueprint.yml,
// then enforced on every agent edit (Guard) and every PR (the scan).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { family, jobOf, isTest, isEntry, styleOf, sharedFolders } from './score.ts';
import { truthy } from './types.ts';
import type { BrokenRule, Parsed, Rule, RouteFacts, Rules } from './types.ts';

export const FILE = '.zomb/blueprint.yml';
// short names for the jobs in score.js, as they read in the YAML
const JOBS: Record<string, string> = { 'icon sets': 'icons', 'date libraries': 'dates', 'HTTP clients': 'http', 'animation libraries': 'animation', 'state managers': 'state', 'form libraries': 'forms', 'validation libraries': 'validation', 'CSS-in-JS libraries': 'css', 'toast libraries': 'toasts', 'chart libraries': 'charts', 'UI kits': 'ui', 'markdown renderers': 'markdown', 'data-fetching libraries': 'fetching', ORMs: 'orm' };
const HOOK = /(^|\/)use[A-Z]\w*\.[cm]?[jt]sx?$/;
const SHARED = /^(utils?|libs?|helpers?|common|shared|core)$/i;
const isHook = (f: string) => HOOK.test(f) && !isTest(f);
const isComponent = (f: string) => /\.[jt]sx$/.test(f) && !isTest(f) && !isEntry(f) && !isHook(f);
// the folder a file belongs to: the nearest enclosing `components/` (or hooks/, utils/…), else its own folder
const homeOf = (f: string, seg: RegExp) => {
  const dirs = f.split('/').slice(0, -1);
  const i = dirs.findLastIndex((d) => seg.test(d));
  return i >= 0 ? dirs.slice(0, i + 1).join('/') : null;
};
const under = (f: string, dir: string) => f.startsWith(`${dir}/`);
const count = <T>(list: T[]): [T, number][] => [...list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map<T, number>())].sort((a, b) => b[1] - a[1]);
const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

// parsed: Map(path -> { packages, deep, alias, fetch, route, lines }) -> [{ section, key, value, evidence }]
// Only rules the code already mostly follows: a blueprint describes the codebase, it doesn't redesign it.
type Facts = Pick<Parsed, 'packages' | 'fetch' | 'route' | 'lines' | 'deep' | 'alias'>;
export function infer(parsed: Map<string, Facts>, { middlewareAuth = false }: { middlewareAuth?: boolean } = {}): Rule[] {
  const files = [...parsed].filter(([f]) => !isTest(f));
  const rules: Rule[] = [];
  const add = (section: string, key: string, value: string | number, evidence: string) => rules.push({ section, key, value, evidence });

  // one library per job: the one most files use (fetch counts as an HTTP client)
  const users = new Map<string, Set<string>>();
  for (const [f, p] of files) {
    for (const pkg of p.packages) if (jobOf(pkg)) users.set(family(pkg), new Set([...(users.get(family(pkg)) || []), f]));
    if (p.fetch) users.set('fetch', new Set([...(users.get('fetch') || []), f]));
  }
  for (const [job, key] of Object.entries(JOBS)) {
    const used = [...users].filter(([lib]) => (lib === 'fetch' ? job === 'HTTP clients' : jobOf(lib) === job)).sort((a, b) => b[1].size - a[1].size);
    if (!used.length) continue;
    const [[lib, by], ...rest] = used;
    add('libraries', key, lib, `${plural(by.size, 'file')}${rest.length ? `; also ${rest.map(([l, s]) => `${l} (${s.size})`).join(', ')}` : ''}`);
  }

  // where each kind of file lives, when 70%+ already live in one folder of that kind
  const kinds: [string, string[], RegExp][] = [
    ['components', files.map(([f]) => f).filter(isComponent), /^components$/i],
    ['hooks', files.map(([f]) => f).filter(isHook), /^hooks$/i],
  ];
  for (const [kind, list, seg] of kinds) {
    const [top] = count(list.map((f) => homeOf(f, seg)).filter(truthy));
    if (list.length >= 3 && top && top[1] / list.length >= 0.7) add('folders', kind, top[0], `${top[1]} of ${list.length} ${kind}`);
  }
  const shared = count(files.map(([f]) => sharedFolders([f])[0]).filter(truthy));
  if (shared.length) add('folders', 'shared', shared[0][0], `${plural(shared[0][1], 'file')}${shared.length > 1 ? `; also ${shared.slice(1).map(([d, k]) => `${d} (${k})`).join(', ')}` : ''}`);

  const styles = count(files.map(([f]) => f).filter(isComponent).map(styleOf).filter(truthy));
  const named = styles.reduce((s, [, k]) => s + k, 0);
  if (named >= 3 && styles[0][1] / named >= 0.8) add('naming', 'components', styles[0][0], `${styles[0][1]} of ${named} component files`);

  const [alias] = count(files.flatMap(([, p]) => p.alias));
  if (alias && alias[1] >= 3) {
    const deep = files.filter(([, p]) => p.deep).length;
    add('imports', 'alias', alias[0], `${plural(alias[1], 'file')} import through it${deep ? `; ${deep} still use ../../../` : ''}`);
  }

  // API auth, when most routes that change data already check it (a middleware check covers every route, so Guard can't judge one file)
  const mutating = files.filter(([, p]) => p.route?.mutates);
  const authed = mutating.filter(([, p]) => p.route!.authSignal).length;
  if (!middlewareAuth && mutating.length && authed / mutating.length >= 0.5) add('api', 'auth', 'required', `${authed} of ${plural(mutating.length, 'route')} that change data check auth`);

  const big = files.filter(([, p]) => p.lines > 500).length;
  add('files', 'maxLines', 500, big ? `${plural(big, 'file')} over it today` : 'every file is under it');
  return rules;
}

// [{ section, key, value }] -> { libraries: { icons: 'react-icons' }, … }, the shape blueprint.yml parses to
export const toRules = (list: Rule[]): Rules => list.reduce((r, x) => ({ ...r, [x.section]: { ...r[x.section], [x.key]: x.value } }), {});

// One file against the blueprint -> [{ rule, why }]. placed: judge where it lives and its name (Guard: new files only).
export function breaks(rules: Rules, { file, packages = [], deep = 0, route = null, lines = 0, placed = true }: { file: string; packages?: string[]; deep?: number; route?: RouteFacts | null; lines?: number; placed?: boolean }): BrokenRule[] {
  const out: BrokenRule[] = [];
  const add = (rule: string, why: string) => out.push({ rule, why });
  for (const pkg of packages) {
    const job = jobOf(pkg);
    const key = job && JOBS[job];
    const want = key && rules.libraries?.[key];
    if (want && family(pkg) !== want) add(`libraries.${key}`, `${key} use ${want} in this repo, not ${pkg}`);
  }
  if (placed) {
    const f = (rules.folders || {}) as Record<string, string>;
    if (f.components && isComponent(file) && !under(file, f.components)) add('folders.components', `components live in ${f.components}/`);
    if (f.hooks && isHook(file) && !under(file, f.hooks)) add('folders.hooks', `hooks live in ${f.hooks}/`);
    const home = homeOf(file, SHARED);
    if (f.shared && home && home !== f.shared && !under(file, f.shared)) add('folders.shared', `shared code lives in ${f.shared}/, not ${home}/`);
    const style = rules.naming?.components as string | undefined;
    if (style && isComponent(file) && styleOf(file) && styleOf(file) !== style) add('naming.components', `component files are ${style}`);
  }
  if (rules.imports?.alias && deep) add('imports.alias', `import through ${rules.imports.alias} instead of ../../../`);
  if (rules.api?.auth === 'required' && route?.mutates && !route.authSignal && !route.public) add('api.auth', 'API routes that change data must check auth');
  if (rules.files?.maxLines && lines > Number(rules.files.maxLines)) add('files.maxLines', `${lines} lines, over the ${rules.files.maxLines}-line limit`);
  return out;
}

// The YAML, written by hand so each rule carries its evidence as a comment you read before approving.
export function toYaml(list: Rule[], repo: string): string {
  const TITLES: Record<string, string> = { libraries: 'one library per job: Guard blocks a second one', folders: 'where new files go', naming: 'how files are named', imports: 'import through the alias, not ../../../', api: 'API routes that change data', files: 'size limit' };
  const out = [`# zomb blueprint for ${repo}: rules inferred from the code, approved by you.`, '# Guard enforces them on every agent edit, and the scan in CI on every PR. Edit freely.', ''];
  for (const section of [...new Set(list.map((r) => r.section))]) {
    out.push(`# ${TITLES[section]}`, `${section}:`);
    const rows = list.filter((r) => r.section === section).map((r) => [`  ${r.key}: ${typeof r.value === 'number' ? r.value : JSON.stringify(r.value)}`, r.evidence]);
    const w = Math.max(...rows.map(([l]) => l.length));
    for (const [l, why] of rows) out.push(`${l.padEnd(w)}  # ${why}`);
    out.push('');
  }
  return out.join('\n');
}

// .zomb/blueprint.yml -> rules, or null when there is none. yaml loads only when there is a file to read.
export function readBlueprint(root: string): Rules | null {
  const file = path.join(root, FILE);
  if (!existsSync(file)) return null;
  return createRequire(import.meta.url)('yaml').parse(readFileSync(file, 'utf8')) || {};
}
