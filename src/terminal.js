// The terminal summary. Fits the window: nothing wraps, long paths shorten from the left, numbers line up on the right.
const ANSI = /\x1b\[[0-9;]*m/g;
export const visible = (s) => String(s).replace(ANSI, '').length;

// One look for every zomb command: colors, badges, section rules, a header frame, and rows that fit the window.
export function ui({ width = 80, color = true, all = false } = {}) {
  // capped at 80: on a wide window, numbers pushed far right are hard to match to their file
  const W = Math.max(48, Math.min(width - 1, 80));
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const [bold, dim, red, yellow, green, cyan] = [paint(1), paint(2), paint(31), paint(33), paint(32), paint(36)];
  const badge = { high: paint('1;41;97'), medium: paint('1;43;30'), low: paint('2;7') };
  const n = (x) => x.toLocaleString('en-US');
  const plural = (k, word) => `${n(k)} ${word}${k === 1 ? '' : 's'}`;
  // a path that must fit in `w` columns loses its start, never its file name
  const fit = (s, w) => (visible(s) <= w ? s : `…${s.slice(-(w - 1))}`);
  // left text + right text on one line, left shortened to make room
  const row = (left, right = '', indent = 2) => {
    const room = W - indent - visible(right) - (right ? 2 : 0);
    const l = visible(left) > room ? fit(left.replace(ANSI, ''), room) : left;
    return right ? `${' '.repeat(indent)}${l}${' '.repeat(Math.max(room - visible(l), 0) + 2)}${right}` : `${' '.repeat(indent)}${l}`;
  };
  // words that wrap onto indented lines instead of running off the edge
  const wrap = (label, words, indent = 2) => {
    const pad = ' '.repeat(indent + visible(label) + 1);
    const lines = [];
    let cur = `${' '.repeat(indent)}${label} `;
    for (let w of words) {
      if (visible(cur) + visible(w) + 3 > W && visible(cur) > pad.length) (lines.push(cur.trimEnd()), (cur = pad));
      const room = W - visible(cur) - 3;
      if (visible(w) > room) w = fit(w.replace(ANSI, ''), Math.max(room, 8)); // one item wider than the line
      cur += cur === pad || cur.endsWith(`${label} `) ? w : `${dim(' · ')}${w}`;
    }
    return [...lines, cur];
  };
  const rule = (title, right = '') => `${bold(title)} ${dim('─'.repeat(Math.max(W - visible(title) - visible(right) - (right ? 2 : 1), 1)))}${right ? ` ${right}` : ''}`;
  const more = (list, k = 5) => (!all && list.length > k ? [dim(`  …and ${n(list.length - k)} more  (zomb --all)`)] : []);
  // the rounded header box: a title line with something on the right, then rows under a divider
  const frame = (title, meta = '', rows = []) => {
    const line = (s) => `${dim('│')} ${s}${' '.repeat(Math.max(W - 4 - visible(s), 0))} ${dim('│')}`;
    const top = visible(title) + visible(meta) + 2 <= W - 4 ? `${title}${' '.repeat(W - 4 - visible(title) - visible(meta))}${meta}` : title;
    return [dim(`╭${'─'.repeat(W - 2)}╮`), line(top), ...(rows.length ? [dim(`├${'─'.repeat(W - 2)}┤`), ...rows.map(line)] : []), dim(`╰${'─'.repeat(W - 2)}╯`)];
  };
  return { W, paint, bold, dim, red, yellow, green, cyan, badge, n, plural, fit, row, wrap, rule, more, frame };
}

export function render(data, tasks, { width = 80, color = true, all = false, audit = {}, knipError, recent = [], out, failing = [], failOn, baseline } = {}) {
  const { W, bold, dim, red, yellow, green, cyan, badge, n, plural, fit, row, wrap, rule, more, frame } = ui({ width, color, all });
  const cap = (list, k = 5) => (all ? list : list.slice(0, k));

  const L = [];
  const sec = data.security.findings;
  const high = sec.filter((f) => f.severity === 'high').length;
  const z = data.zombie;
  const zLines = z.files.reduce((s, f) => s + f.lines, 0);
  const sp = data.sprawl;
  const a = data.architecture;
  const added = recent.reduce((s, m) => s + m.added, 0), deleted = recent.reduce((s, m) => s + m.deleted, 0);

  // ── header: what was scanned, and one line per area
  const dot = (tone) => ({ bad: red('●'), warn: yellow('●'), ok: green('●') })[tone];
  const summary = [
    ['security', sec.length ? `${high ? `${n(high)} high` : ''}${high && sec.length - high ? ' · ' : ''}${sec.length - high ? `${n(sec.length - high)} medium` : ''}` : 'nothing found', high ? 'bad' : sec.length ? 'warn' : 'ok'],
    ...(data.shortcuts ? [['shortcuts', data.shortcuts.length ? plural(data.shortcuts.length, 'place') : 'none', data.shortcuts.some((c) => c.severity !== 'low') ? 'warn' : 'ok']] : []),
    ['zombie code', knipError ? 'skipped' : zLines ? `${n(zLines)} lines · ${plural(z.files.length, 'file')}` : 'none', knipError ? 'warn' : zLines ? 'warn' : 'ok'],
    ['sprawl', [sp.overlaps.length && plural(sp.overlaps.length, 'library overlap'), sp.dupes?.length && plural(sp.dupes.length, 'copy-paste'), sp.versions.length && plural(sp.versions.length, 'versioned copy', 'versioned copies').replace('copys', 'copies')].filter(Boolean).join(' · ') || 'none', sp.overlaps.length || sp.dupes?.length || sp.versions.length ? 'warn' : 'ok'],
    ['architecture', [plural(a.cycles.length, 'cycle'), a.big.length && `${n(a.big.length)} over 500 lines`].filter(Boolean).join(' · '), a.cycles.length ? 'warn' : a.big.length ? 'warn' : 'ok'],
  ];
  const title = `${bold('zomb')}  ${data.repo}`;
  const meta = dim(`${n(data.files)} files · ${n(data.lines)} lines${data.since ? ` · since ${/^[0-9a-f]{40}$/.test(data.since) ? data.since.slice(0, 7) : data.since}` : ''}`);
  L.push(...frame(title, meta, summary.map(([label, value, tone]) => `${dot(tone)} ${label.padEnd(14)}${fit(value, W - 21)}`)));

  // ── security
  if (sec.length || audit.skipped) {
    L.push('', rule('SECURITY', high ? red(`${n(high)} high`) : yellow(`${n(sec.length)} medium`)));
    for (const f of cap(sec)) {
      L.push(row(`${badge[f.severity](f.severity === 'high' ? ' HIGH ' : ' MED  ')}  ${f.title}`, '', 1));
      L.push(row(dim(f.where), '', 9));
    }
    L.push(...more(sec));
    if (audit.skipped) L.push(row(dim(`packages not checked: ${audit.skipped}`)));
  }

  // ── shortcuts (diff mode)
  if (data.shortcuts?.length) {
    L.push('', rule('SHORTCUTS', yellow(`${n(data.shortcuts.length)} in this change`)));
    for (const c of cap(data.shortcuts)) {
      L.push(row(`${badge[c.severity](c.severity === 'high' ? ' HIGH ' : c.severity === 'medium' ? ' MED  ' : ' LOW  ')}  ${c.kind}`, '', 1));
      L.push(row(dim(c.line ? `${c.file}:${c.line}` : c.file), '', 9));
    }
    L.push(...more(data.shortcuts));
  }

  // ── zombie code, grouped by folder
  if (knipError) L.push('', rule('ZOMBIE CODE', yellow('skipped')), row(dim(fit(knipError, W - 2))));
  else if (z.files.length || z.packages.length || z.maybe.length) {
    L.push('', rule('ZOMBIE CODE', `${bold(n(zLines))} ${dim('lines')}`));
    const groups = new Map();
    for (const f of z.files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : './';
      groups.set(dir, [...(groups.get(dir) || []), f]);
    }
    const sorted = [...groups].sort((x, y) => y[1].reduce((s, f) => s + f.lines, 0) - x[1].reduce((s, f) => s + f.lines, 0));
    for (const [dir, list] of cap(sorted)) {
      const total = list.reduce((s, f) => s + f.lines, 0);
      L.push(row(dim(dir), dim(`${plural(list.length, 'file')}  ${n(total).padStart(6)}`)));
      for (const f of cap(list)) L.push(row(`${f.path.slice(dir === './' ? 0 : dir.length)}${f.script ? yellow('  run by hand?') : f.why.startsWith('Only') ? dim('  tests only') : ''}`, n(f.lines).padStart(6), 4));
      if (!all && list.length > 5) L.push(dim(`    …and ${n(list.length - 5)} more`));
    }
    L.push(...more(sorted));
    const byAgent = z.files.filter((f) => f.share >= 0.5).length;
    if (z.files.length) L.push(row(dim(`nothing imports or names these${byAgent ? ` · ${byAgent} of ${z.files.length} written by an AI agent` : ''}`)));
    if (z.packages.length) L.push('', ...wrap(dim('unused packages'), z.packages.map((p) => p.name)));
    if (z.maybe.length) L.push('', ...wrap(dim('maybe unused routes'), z.maybe.map((m) => m.url)));
    const dead = z.exports.reduce((s, e) => s + e.names.length, 0);
    if (dead) L.push(row(dim(`+ ${plural(dead, 'export')} nothing imports, in ${plural(z.exports.length, 'file')}`)));
  }

  // ── sprawl
  const sprawlRows = [];
  for (const o of sp.overlaps) sprawlRows.push(...wrap(dim(o.job.padEnd(14)), o.libraries.map((l) => `${l.name} ${dim(n(l.files))}`)));
  for (const v of cap(sp.versions)) sprawlRows.push(row(v.path, dim(v.original ? 'has original' : v.files ? plural(v.files, 'file') : 'copy')));
  for (const x of cap(sp.names)) sprawlRows.push(row(x.name, dim(`defined ${x.files.length}×`)));
  if (sp.dupes?.length) sprawlRows.push(row(`${plural(sp.dupes.length, 'copy-pasted block')}`, dim(`${n(sp.dupes.reduce((s, d) => s + d.lines, 0))} lines`)));
  const growthLine = data.since ? '' : added ? `${dim('+')}${n(added)} ${dim('−')}${n(deleted)} ${dim('3 mo')}` : dim('no commits in 3 months');
  if (sprawlRows.length || growthLine) {
    L.push('', rule('SPRAWL', growthLine));
    if (added && !data.since) L.push(row(dim(`${Math.round((deleted / added) * 100)} lines deleted for every 100 added`)));
    L.push(...sprawlRows);
  }

  // ── architecture
  if (a.cycles.length || a.big.length || a.deep.length || a.shared.length > 1) {
    L.push('', rule('ARCHITECTURE', a.cycles.length ? yellow(plural(a.cycles.length, 'cycle')) : green('no cycles')));
    for (const c of cap(a.cycles, 3)) L.push(row(`${dim('cycle')} ${c.slice(0, 3).map((f) => f.split('/').pop()).join(dim(' → '))}${c.length > 3 ? dim(` +${c.length - 3}`) : ''}`));
    for (const b of cap(a.big)) L.push(row(b.file, `${n(b.lines).padStart(6)}`));
    if (a.shared.length > 1) L.push(...wrap(dim('shared code in'), a.shared));
    if (a.deep.length) L.push(row(dim(`${plural(a.deep.length, 'file')} with ../../../ imports`)));
  }

  // ── what to do next
  const safe = tasks.filter((t) => t.safe).length;
  const fresh = baseline ? tasks.filter((t) => t.new).length : null;
  L.push('', rule('NEXT', dim(`${plural(tasks.length, 'task')}`)));
  if (safe) L.push(row(`${cyan('zomb fix')} ${dim('deletes the dead code on a branch, checking your build')}`, dim(`${n(safe)} safe`)));
  if (tasks.length - safe) L.push(row(`${cyan('/zomb-clean')} ${dim('in Claude Code for the rest')}`, dim(`${n(tasks.length - safe)} need a look`)));
  if (fresh !== null) L.push(row(dim(`${plural(fresh, 'finding')} new since the baseline`)));
  if (out) L.push(row(`${dim('report')} ${fit(out, W - 10)}`));
  if (failOn) L.push(row(failing.length ? red(`✗ ${plural(failing.length, 'finding')} at or above ${failOn}${baseline ? ', new since the baseline' : ''}`) : green(`✓ nothing ${baseline ? 'new ' : ''}at or above ${failOn}`)));
  return L;
}

// A one-line spinner on stderr while the scan runs; silent when stderr isn't a terminal.
export function spinner(label) {
  if (!process.stderr.isTTY) return { step: () => {}, stop: () => {} };
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const done = [];
  let i = 0;
  const draw = () => {
    const text = `${label}${done.length ? ` · ${done.join(' · ')}` : ''}`.slice(0, (process.stderr.columns || 80) - 3);
    process.stderr.write(`\r\x1b[2K\x1b[36m${frames[i++ % frames.length]}\x1b[0m \x1b[2m${text}\x1b[0m`);
  };
  const timer = setInterval(draw, 80);
  const started = Date.now();
  draw();
  return {
    step: (name) => done.push(`${name} ✓`),
    // leave one quiet line behind instead of a half-cleared spinner
    stop: () => (clearInterval(timer), process.stderr.write(`\r\x1b[2K\x1b[32m✓\x1b[0m \x1b[2m${label.replace('scanning', 'scanned')} in ${((Date.now() - started) / 1000).toFixed(1)}s\x1b[0m\n`)),
  };
}
