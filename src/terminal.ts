// The terminal look for every zomb command. Fits the window: nothing wraps, long paths shorten from the left, numbers line up on the right.
// One visual language: ⬢ marks zomb at work, ● ◐ ○ are high, medium and low, ☒ ▣ ☐ are done, running and next.
import type { Month, Rule, ScanData, Severity, Task } from './types.ts';

const ANSI = /\x1b\[[0-9;]*m/g;
export const visible = (s: unknown) => String(s).replace(ANSI, '').length;
const DAY = 864e5;

export function ui({ width = 80, color = true, all = false }: { width?: number; color?: boolean; all?: boolean } = {}) {
  // capped at 80: on a wide window, numbers pushed far right are hard to match to their file
  const W = Math.max(48, Math.min(width - 1, 80));
  const paint = (code: number | string) => (s: unknown) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const [bold, dim, red, yellow, green, faint, underline] = [paint(1), paint(2), paint(31), paint(33), paint(32), paint(90), paint(4)];
  // the shape carries the severity too, so it still reads without colour
  const mark: Record<Severity, string> = { high: red('●'), medium: yellow('◐'), low: dim('○') };
  const n = (x: number) => x.toLocaleString('en-US');
  const plural = (k: number, word: string) => `${n(k)} ${word}${k === 1 ? '' : 's'}`;
  // a path that must fit in `w` columns loses its start, never its file name
  const fit = (s: string, w: number) => (visible(s) <= w ? s : `…${s.slice(-(w - 1))}`);
  // prose that must fit loses its end
  const clip = (s: string, w: number) => (s.length <= w ? s : `${s.slice(0, Math.max(w - 1, 1))}…`);
  // left text + right text on one line, left shortened to make room
  const row = (left: string, right = '', indent = 2) => {
    const room = W - indent - visible(right) - (right ? 2 : 0);
    const l = visible(left) > room ? fit(left.replace(ANSI, ''), room) : left;
    return right ? `${' '.repeat(indent)}${l}${' '.repeat(Math.max(room - visible(l), 0) + 2)}${right}` : `${' '.repeat(indent)}${l}`;
  };
  // a title line: the meta goes on its own line when both don't fit
  const head = (left: string, right = '') => (visible(left) + visible(right) + 3 <= W ? [row(left, right, 1)] : [row(left, '', 1), ...(right ? [row(right, '', 1)] : [])]);
  // words that wrap onto indented lines instead of running off the edge
  const wrap = (label: string, words: string[], indent = 2, sep = dim(' · ')) => {
    const pad = ' '.repeat(indent + visible(label) + 1);
    const lines: string[] = [];
    let cur = `${' '.repeat(indent)}${label} `;
    for (let w of words) {
      if (visible(cur) + visible(w) + 3 > W && visible(cur) > pad.length) (lines.push(cur.trimEnd()), (cur = pad));
      const room = W - visible(cur) - 3;
      if (visible(w) > room) w = fit(w.replace(ANSI, ''), Math.max(room, 8)); // one item wider than the line
      cur += cur === pad || cur.endsWith(`${label} `) ? w : `${sep}${w}`;
    }
    return [...lines, cur];
  };
  // a section heading: its name, a dotted leader, and a summary on the right
  const dots = (left: string, right = '') => ` ${left} ${faint('·'.repeat(Math.max(W - visible(left) - visible(right) - (right ? 3 : 2), 3)))}${right ? ` ${right}` : ''}`;
  // the status bar: values over their labels, as many columns as fit
  const bar = (cells: [string, string][]) => {
    const top: string[] = [];
    const bottom: string[] = [];
    let used = 1;
    for (const [value, label] of cells) {
      const w = Math.max(visible(value), visible(label));
      if (used + w > W) break;
      top.push(value + ' '.repeat(w - visible(value)));
      bottom.push(label + ' '.repeat(w - visible(label)));
      used += w + 3;
    }
    const line = (xs: string[]) => ` ${xs.join('   ')}`.replace(/ +$/, '');
    return [` ${faint('─'.repeat(W - 1))}`, line(top), line(bottom)];
  };
  return { W, all, bold, dim, red, yellow, green, faint, underline, mark, n, plural, fit, clip, row, head, wrap, dots, bar };
}

const AREAS: [Task['area'], string][] = [['security', 'security'], ['shortcuts', 'shortcuts'], ['blueprint', 'blueprint'], ['zombie', 'zombie code'], ['sprawl', 'sprawl'], ['architecture', 'architecture']];
const short = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

export function render(
  data: ScanData,
  tasks: Task[],
  { width = 80, color = true, all = false, audit = {}, knipError, recent = [], days, out, failing = [], failOn, baseline }: { width?: number; color?: boolean; all?: boolean; audit?: ScanData['security']['audit']; knipError?: string; recent?: Month[]; days?: Map<string, number>; out?: string; failing?: unknown[]; failOn?: string; baseline?: unknown } = {},
): string[] {
  const u = ui({ width, color, all });
  const { W, bold, dim, red, yellow, green, faint, underline, mark, n, plural, fit, clip, head, wrap, dots, bar } = u;
  const z = data.zombie;
  const a = data.architecture;
  const zLines = z.files.reduce((s, f) => s + f.lines, 0);
  const of = (area: Task['area']) => tasks.filter((t) => t.area === area);
  const count = (list: Task[], sev: Severity) => list.filter((t) => t.severity === sev).length;
  const L: string[] = [];

  // ── header: the repo, its size, and one status mark per area
  L.push(...head(`${green('⬢ zomb')}  ${bold(underline(clip(data.repo, W - 24)))}${dim(` [${n(tasks.length)}]`)}`, dim(`${n(data.files)} files · ${n(data.lines)} lines${data.since ? ` · since ${short(data.since)}` : ''}`)));
  const tone = { bad: red('●'), warn: yellow('◐'), ok: green('✓') };
  const status: [string, keyof typeof tone][] = [
    ['security', count(of('security'), 'high') ? 'bad' : of('security').length ? 'warn' : 'ok'],
    ...(data.blueprint ? [['blueprint', data.blueprint.broken.length ? 'bad' : 'ok'] as [string, keyof typeof tone]] : []),
    ...(data.shortcuts ? [['shortcuts', data.shortcuts.length ? 'warn' : 'ok'] as [string, keyof typeof tone]] : []),
    ['zombie code', knipError || of('zombie').length ? 'warn' : 'ok'],
    ['sprawl', of('sprawl').length ? 'warn' : 'ok'],
    ['architecture', of('architecture').length ? 'warn' : 'ok'],
  ];
  L.push(...wrap('', status.map(([label, t]) => `${tone[t]} ${label}`), 0, '   '));

  // ── one numbered to-do list, grouped by area. The numbers are what `zomb show <n>` takes.
  const severities = (list: Task[]) => [count(list, 'high') && red(`${n(count(list, 'high'))} high`), count(list, 'medium') && yellow(`${n(count(list, 'medium'))} medium`), count(list, 'low') && dim(`${n(count(list, 'low'))} low`)].filter(Boolean).join(dim(' · '));
  const summary: Record<Task['area'], (list: Task[]) => string> = {
    security: severities,
    shortcuts: severities,
    blueprint: (list) => red(plural(list.length, 'break')),
    zombie: (list) => (zLines ? `${bold(n(zLines))} ${dim(`lines · ${plural(z.files.length, 'file')}`)}` : dim(plural(list.length, 'task'))),
    sprawl: (list) => dim(`${plural(list.length, 'thing')} to tidy`),
    architecture: (list) => (a.cycles.length ? yellow(plural(a.cycles.length, 'cycle')) : dim(plural(list.length, 'task'))),
  };
  const added = recent.reduce((s, m) => s + m.added, 0);
  const deleted = recent.reduce((s, m) => s + m.deleted, 0);
  const byAgent = z.files.filter((f) => f.share >= 0.5).length;
  const notes: Record<Task['area'], string[]> = {
    security: audit.skipped ? [`   ${dim(clip(`packages not checked: ${audit.skipped}`, W - 3))}`] : [],
    shortcuts: [],
    blueprint: [],
    zombie: byAgent ? [`   ${dim(`${byAgent} of ${plural(z.files.length, 'dead file')} written by an AI agent`)}`] : [],
    sprawl: added && !data.since ? [`   ${dim(clip(`+${n(added)} −${n(deleted)} lines in 3 months${data.benchmark ? '' : ` · ${Math.round((deleted / added) * 100)} deleted per 100 added`}`, W - 3))}`] : [],
    architecture: [...(a.shared.length > 1 ? wrap(dim('shared code in'), a.shared, 3) : []), ...(a.deep.length ? [`   ${dim(`${plural(a.deep.length, 'file')} with ../../../ imports`)}`] : [])],
  };
  const first = tasks[0];
  const item = (t: Task) => {
    const lead = ` ${faint(`${String(t.id).padStart(3)}.`)} ${mark[t.severity]}  `;
    const tags = [t.how.startsWith('Only its own tests') && dim('tests only'), t.safe && green('fix'), t.new && yellow('new')].filter(Boolean).join(' ');
    const where = t.where && !t.title.includes(t.where) ? t.where : '';
    // the first task is where to start
    const hot = t === first;
    const text = clip(t.title, W - visible(lead) - (tags ? visible(tags) + 2 : 0) - (hot ? 4 : 0));
    const left = `${lead}${hot ? `${yellow(underline(text))}${yellow(' (!)')}` : text}`;
    const right = [where && dim(where), tags].filter(Boolean).join('  ');
    const line = (r: string) => (r ? `${left}${' '.repeat(Math.max(W - visible(left) - visible(r), 2))}${r}` : left);
    if (visible(left) + visible(right) + 2 <= W) return [line(right)];
    return [line(tags), ...(where ? [`${' '.repeat(visible(lead))}${dim(fit(where, W - visible(lead)))}`] : [])];
  };
  for (const [area, name] of AREAS) {
    const list = of(area);
    if (area === 'zombie' && knipError) {
      L.push('', dots(bold(name), yellow('skipped')), `   ${dim(clip(knipError, W - 3))}`);
      continue;
    }
    if (!list.length && !notes[area].length) continue;
    L.push('', dots(bold(name), list.length ? summary[area](list) : ''));
    for (const t of all ? list : list.slice(0, 5)) L.push(...item(t));
    if (!all && list.length > 5) L.push(`${' '.repeat(9)}${faint(`+ ${n(list.length - 5)} more`)}   ${dim('zomb --all')}`);
    L.push(...notes[area]);
  }
  if (!tasks.length) L.push('', ` ${green('✓')} ${bold('Nothing to fix.')}`);

  // ── whole-repo scans only: when the code was written, and how it compares with the study
  if (!data.since) L.push(...activity(u, days, data.benchmark));

  // ── the tally, then the status bar
  const safe = tasks.filter((t) => t.safe).length;
  const fresh = baseline ? tasks.filter((t) => t.new).length : null;
  if (tasks.length) {
    L.push('');
    // who does what: zomb fix the mechanical part, /zomb-clean in Claude Code the rest
    const who = [...(safe ? [dim(`${Math.round((safe / tasks.length) * 100)}% can be fixed by`), `${green('zomb fix')}${dim(tasks.length > safe ? ',' : '.')}`] : []), ...(tasks.length > safe ? [dim(safe ? 'the rest with' : 'Work through them with'), green('/zomb-clean'), dim('in Claude Code.')] : [])];
    L.push(...wrap('', who, 0, ' '));
    const tally: [number, (s: unknown) => string, string][] = [[count(tasks, 'high'), red, 'high'], [count(tasks, 'medium'), yellow, 'medium'], [count(tasks, 'low'), String, 'low'], [safe, green, 'fixable'], [fresh ?? 0, yellow, 'new since the baseline']];
    // a zero is noise, except the baseline count: "0 new" is the news
    L.push(...wrap('', tally.filter(([k, , label]) => k || (label.startsWith('new') && fresh !== null)).map(([k, paint, label]) => `${paint(n(k))} ${dim(label)}`), 0));
  }
  // most useful first: a narrow window drops cells from the right
  const cells: [string, string][] = [];
  if (failOn) cells.push([failing.length ? red(`✗ ${plural(failing.length, 'finding')}`) : green('✓ pass'), dim(`fail-on ${failOn}${baseline ? ', new only' : ''}`)]);
  if (out) cells.push([fit(out, 28), dim('report')]);
  if (safe) cells.push([green('zomb fix'), dim(`${n(safe)} safe`)]);
  if (tasks.length - safe) cells.push([green('/zomb-clean'), dim(`${n(tasks.length - safe)} to review`)]);
  if (tasks.length) cells.push([green('zomb show 1'), dim('the first in full')]);
  if (cells.length) L.push('', ...bar(cells));
  return L;
}

// A calendar of lines added per day, then this repo's deletion habit against the study, as bars.
function activity({ W, bold, dim, green, yellow, faint, n, plural, row, dots }: ReturnType<typeof ui>, days: Map<string, number> | undefined, bm: ScanData['benchmark']): string[] {
  const L: string[] = [];
  const weeks = Math.min(26, Math.floor((W - 6) / 2));
  const end = Date.parse(new Date().toLocaleDateString('en-CA'));
  const start = end - new Date(end).getUTCDay() * DAY - (weeks - 1) * 7 * DAY;
  const seen = [...(days || [])].filter(([d]) => Date.parse(d) >= start && Date.parse(d) <= end);
  if (seen.length) {
    const max = Math.max(...seen.map(([, v]) => v));
    const cell = (v = 0) => (v ? green('░▒▓█'[Math.min(3, Math.floor((v / max) * 4))].repeat(2)) : faint(' ·'));
    const months = Array(5 + weeks * 2).fill(' ');
    let free = 0;
    for (let c = 0, prev = -1; c < weeks; c++) {
      const m = new Date(start + c * 7 * DAY).getUTCMonth();
      const at = 6 + c * 2;
      if (m !== prev && at >= free) {
        [...'JanFebMarAprMayJunJulAugSepOctNovDec'.slice(m * 3, m * 3 + 3)].forEach((ch, k) => (months[at + k] = ch));
        free = at + 4;
      }
      prev = m;
    }
    L.push('', dots(bold('activity'), dim('lines added per day')), dim(months.join('').trimEnd()));
    for (let r = 0; r < 7; r++) {
      const cells: string[] = [];
      for (let c = 0; c < weeks; c++) {
        const d = start + (c * 7 + r) * DAY;
        if (d <= end) cells.push(cell(days?.get(new Date(d).toISOString().slice(0, 10))));
      }
      L.push(`${dim(['', ' Mon', '', ' Wed', '', ' Fri', ''][r].padEnd(5))}${cells.join('')}`.trimEnd());
    }
    const total = seen.reduce((s, [, v]) => s + v, 0);
    L.push(row(dim(`${n(total)} lines on ${plural(seen.length, 'day')}${bm ? ` · agents wrote ${bm.agentShare}%` : ''}`), `${dim('less')} ${faint('·')} ${green('░ ▒ ▓ █')} ${dim('more')}`, 1));
  }
  if (bm) {
    const rows = [{ name: 'this repo', v: bm.deletedPer100, me: true }, { name: 'humans', v: bm.humans, me: false }, ...bm.agents.map((x) => ({ name: x.name, v: x.deletedPer100, me: false }))].sort((x, y) => y.v - x.v);
    const room = W - 40;
    const scale = room / Math.max(...rows.map((x) => x.v), 1);
    const worse = bm.deletedPer100 < bm.humans;
    L.push('', dots(bold('deleted per 100 added'), dim(`vs ${n(bm.study.repos)} public repos`)));
    for (const x of rows) {
      const len = x.v * scale;
      const drawn = `${'█'.repeat(Math.floor(len))}${len % 1 >= 0.5 ? '▌' : ''}`;
      const human = x.name === 'humans';
      const label = x.name.padEnd(11);
      L.push(` ${x.me ? bold(label) : human ? label : dim(label)}${(x.me ? green : human ? String : faint)(drawn)}${' '.repeat(room - drawn.length + 2)}${(x.me ? bold : dim)(String(x.v).padStart(3))}${x.me ? `  ${(worse ? yellow : green)(worse ? 'below humans' : 'above humans')}` : ''}`);
    }
    if (bm.medianCommit > bm.humanMedianCommit * 1.5) L.push(` ${dim(`your median commit adds ${n(bm.medianCommit)} lines; a human one in the study adds ${n(bm.humanMedianCommit)}`)}`);
  }
  return L;
}

// `zomb show <n>`: one finding in full, with what to do about it.
export function renderTask(t: Task, total: number, { repo, width = 80, color = true }: { repo: string; width?: number; color?: boolean }): string {
  const { W, bold, dim, green, mark, n, clip, head, wrap } = ui({ width, color });
  const L = ['', ...head(`${green('⬢ zomb')}  ${bold(clip(repo, W - 30))}`, dim(`finding ${n(t.id)} of ${n(total)}`)), ''];
  L.push(`   ${mark[t.severity]}  ${bold(clip(t.title, W - 6))}`, `      ${dim(`${t.area} · ${t.severity}${t.new ? ' · new since the baseline' : ''}`)}`, '');
  if (t.where) L.push(...wrap(dim('where'), t.where.split(/,\s+/), 3, dim(', ')));
  L.push(...wrap(dim('fix  '), t.how.split(' '), 3, ' '));
  L.push(t.safe ? `   ${dim('who  ')} ${green('zomb fix')} ${dim('does this for you, checking your build')}` : `   ${dim('who  ')} ${dim('you, or')} ${green('/zomb-clean')} ${dim('in Claude Code')}`);
  if (t.id < total) L.push('', `   ${dim('next ')} ${green(`zomb show ${t.id + 1}`)}`);
  return `${L.join('\n')}\n`;
}

// `zomb --help`: the block-letter title, the commands in a box, the flags in columns.
export function renderHelp({ width = 80, color = true, version = '' }: { width?: number; color?: boolean; version?: string } = {}): string {
  const { W, bold, dim, green, faint, clip, row } = ui({ width, color });
  const FONT: Record<string, string[]> = { Z: ['#####', '   # ', '  #  ', ' #   ', '#####'], O: [' ### ', '#   #', '#   #', '#   #', ' ### '], M: ['#   #', '## ##', '# # #', '#   #', '#   #'], B: ['#### ', '#   #', '#### ', '#   #', '#### '] };
  // each pixel row is a line of ▀: the lower half stays empty, which gives the letters their stripes
  const banner = [0, 1, 2, 3, 4].map((r) => green(` ${[...'ZOMB'].map((ch) => FONT[ch][r].replace(/#/g, '▀▀').replace(/ /g, '  ')).join('  ')}`.trimEnd()));
  const commands = [
    ['zomb [path]', 'scan: security, zombie code, sprawl, architecture'],
    ['zomb show <n> [path]', 'one finding in full: where, why, how to fix'],
    ['zomb fix [path]', 'delete dead code on a branch, gated by your build'],
    ['zomb blueprint [path]', 'infer the rules this code already follows'],
    ['zomb guard', 'Claude Code hook: blocks bad edits as they happen'],
  ];
  const box = [
    faint(` ┌${'─'.repeat(W - 3)}┐`),
    ` ${faint('│')} ${dim('COMMANDS')}${' '.repeat(W - 12)}${faint('│')}`,
    ...commands.map(([c, what]) => {
      const text = clip(what, W - 29);
      return ` ${faint('│')} ${green(c.padEnd(23))}${text}${' '.repeat(W - 27 - text.length)}${faint('│')}`;
    }),
    faint(` └${'─'.repeat(W - 3)}┘`),
  ];
  const flag = (f: string, what: string) => `${f.padEnd(18)}${dim(what)}`;
  const groups: [string, string[]][] = [
    ['SCAN', [flag('--all', 'every finding'), flag('--since <ref>', 'only what changed'), flag('--json', 'to-do for an agent'), flag('--markdown', 'a PR comment'), flag('--out <file>', 'HTML report path'), flag('--save-baseline', 'accept today'), flag('--fail-on <level>', 'the CI gate')]],
    ['FIX', [flag('--dry-run', 'show the plan only'), flag('--no-checks', 'skip the build gate')]],
    ['BLUEPRINT', [flag('--write', 'save the rules')]],
    ['ENV', [flag('NO_COLOR=1', 'plain output'), flag('ZOMB_GUARD=off', 'pause the guard')]],
  ];
  const block = ([title, lines]: [string, string[]]) => [bold(title), ...lines];
  let flags: string[];
  if (W >= 78) {
    // two columns: scan on the left, everything else on the right
    const left = block(groups[0]);
    const right = groups.slice(1).flatMap((g, i) => [...(i ? [''] : []), ...block(g)]);
    flags = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
      const l = left[i] || '';
      return ` ${l}${right[i] ? `${' '.repeat(39 - visible(l))}${right[i]}` : ''}`.trimEnd();
    });
  } else flags = groups.flatMap((g, i) => [...(i ? [''] : []), ...block(g).map((l) => ` ${l}`)]);
  return ['', ...banner, '', row(dim('a health check for codebases written with AI'), version ? faint(`v${version}`) : '', 1), '', ...box, '', ...flags, ''].join('\n');
}

// `zomb blueprint`: the proposed rules with their evidence, what breaks them today, and how to save them.
export function renderBlueprint(
  rules: Rule[],
  today: { file: string; rule: string; why: string }[],
  { repo, width = 80, color = true, exists = false, write = false, file = '.zomb/blueprint.yml' }: { repo: string; width?: number; color?: boolean; exists?: boolean; write?: boolean; file?: string },
): string {
  const { W, bold, dim, yellow, green, underline, n, plural, row, head, dots } = ui({ width, color });
  const TITLES = { libraries: 'one library per job', folders: 'where new files go', naming: 'how files are named', imports: 'no ../../../', api: 'routes that change data', files: 'size limit' };
  const L = ['', ...head(`${green('⬢ zomb blueprint')}  ${bold(underline(repo))}`, dim(plural(rules.length, 'rule'))), row(dim('the rules this code already follows, for you to approve'), '', 1)];
  for (const section of [...new Set(rules.map((r) => r.section))]) {
    L.push('', dots(bold(section), dim(TITLES[section])));
    for (const r of rules.filter((x) => x.section === section)) {
      const k = new Set(today.filter((b) => b.rule === `${section}.${r.key}`).map((b) => b.file)).size;
      const left = `${green(r.key.padEnd(12))}${bold(String(r.value))}`;
      const right = `${dim(r.evidence)}${k ? yellow(`  ✗ ${plural(k, 'file')}`) : ''}`;
      // evidence goes under the rule when both don't fit on one line
      if (visible(left) + visible(right) + 6 <= W) L.push(row(left, right, 3));
      else L.push(row(left, '', 3), row(right, '', 15));
    }
  }
  const files = [...new Set(today.map((b) => b.file))];
  if (today.length) {
    L.push('', dots(bold('breaks today'), yellow(`${plural(today.length, 'break')} in ${plural(files.length, 'file')}`)));
    for (const b of today.slice(0, 5)) L.push(row(`${yellow('✗')} ${b.why}`, '', 3), row(dim(b.file), '', 5));
    if (today.length > 5) L.push(dim(`     …and ${n(today.length - 5)} more`));
  }
  L.push('');
  if (write && !exists) {
    L.push(row(`${green('✓')} saved ${green(file)}`, '', 1), row(dim('Commit it. Guard now enforces it on every agent edit, and the scan on every PR.'), '', 3));
    if (today.length) L.push(row(`${dim('accept the breaks you have today:')} ${green('zomb --save-baseline')}`, '', 3));
  } else {
    if (exists) L.push(row(`${yellow('!')} ${file} already exists: this is a fresh proposal to compare with it`, '', 1));
    if (!write) L.push(row(`${green('zomb blueprint --write')} ${dim(`saves it to ${file}`)}`, '', 1));
  }
  return `${L.join('\n')}\n`;
}

// While the scan runs: a dot matrix that ripples, and each check ticking off. Silent when stderr isn't a terminal.
export function loader({ title, label, steps, color = true }: { title: string; label: string; steps: [string, string][]; color?: boolean }) {
  const out = process.stderr;
  if (!out.isTTY) return { step: (_name: string) => {}, stop: () => {} };
  const c = (code: number | string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const LEVELS = [236, 22, 28, 35, 121]; // 256-colour greens, dark to bright
  const started = Date.now();
  const done = new Map<string, string>();
  const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  let tick = 0;
  let drawn = 0;
  const draw = () => {
    const cols = (out.columns || 80) - 1;
    const size = Math.min(26, Math.max(cols - 44, 6));
    const matrix = (r: number) =>
      Array.from({ length: size }, (_, i) => {
        const v = ((Math.sin(tick * 0.32 - i * 0.5 + r * 1.7) + 1) / 2) * 0.8 + Math.random() * 0.35;
        return color ? `\x1b[38;5;${LEVELS[Math.min(4, Math.floor(v * 4))]}m■` : v > 0.6 ? '■' : '·';
      }).join('') + (color ? '\x1b[0m' : '');
    const lines = [
      ` ${matrix(0)}   ${c(1, 'zomb')}  ${title}`,
      ` ${matrix(1)}   ${c(2, `${label} · ${secs()}`)}`,
      '',
      ` ${c(2, '⬢')} ${c(1, 'Combing')} through ${steps.length} checks  ${c(2, `${done.size} of ${steps.length}`)}`,
      ...steps.map(([name, what]) => (done.has(name) ? `   ${c(90, `☒  ${name.padEnd(12)}${what.padEnd(22)}${done.get(name)}`)}` : `   ${c(1, '▣')}  ${name.padEnd(12)}${c(2, what)}`)),
    ].map((l) => (visible(l) > cols ? l.replace(ANSI, '').slice(0, cols) : l));
    // redraw in place: back to the first line, then every line cleared and rewritten
    out.write(`${drawn ? `\x1b[${drawn}F` : '\x1b[?25l'}${lines.map((l) => `\x1b[2K${l}`).join('\n')}\n`);
    drawn = lines.length;
    tick++;
  };
  const showCursor = () => out.write('\x1b[?25h');
  process.once('exit', showCursor);
  const timer = setInterval(draw, 90);
  draw();
  return {
    step: (name: string) => void done.set(name, secs()),
    // leave one quiet line behind instead of the whole block
    stop: () => {
      clearInterval(timer);
      out.write(`\x1b[${drawn}F\x1b[J ${c(32, '✓')} ${c(2, `${label.replace('scanning', 'scanned')} in ${secs()}`)}\n`);
      showCursor();
    },
  };
}
