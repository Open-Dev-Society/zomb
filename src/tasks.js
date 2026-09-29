// Findings -> one ordered to-do list that an AI agent (or a person) can work through.
// `safe` = mechanical and checkable by a build: an agent may do it without asking. Everything else needs a human yes.
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

export function toTasks({ security, zombie, sprawl, architecture }) {
  const tasks = [];
  const add = (t) => tasks.push({ id: tasks.length + 1, ...t });

  for (const f of security.findings)
    add({ area: 'security', severity: f.severity, action: 'fix', title: f.title, where: f.where, how: f.detail || 'Fix the flagged line so the input can never reach it unescaped.', safe: false });

  for (const f of zombie.files) add({ area: 'zombie', severity: 'low', action: 'delete-file', title: `Delete ${f.path} (${plural(f.lines, 'line')})`, where: f.path, how: `${f.why}. Delete the file, then run the build and tests.`, safe: true });
  if (zombie.packages.length)
    add({ area: 'zombie', severity: 'low', action: 'uninstall', title: `Uninstall ${plural(zombie.packages.length, 'unused package')}`, where: zombie.packages.map((p) => p.name).join(' '), how: 'Nothing imports them. Remove them with your package manager, then run the build.', safe: true });
  for (const e of zombie.exports) add({ area: 'zombie', severity: 'low', action: 'remove-exports', title: `Remove ${plural(e.names.length, 'unused export')} from ${e.file}`, where: e.file, how: `Nothing imports ${e.names.join(', ')}. Delete them, or drop the export keyword if the file uses them itself.`, safe: true });
  for (const m of zombie.maybe) add({ area: 'zombie', severity: 'low', action: 'review', title: `Is ${m.url} still used?`, where: m.file, how: 'Nothing in the repo links to or calls it. Ask the owner or check analytics before deleting.', safe: false });

  for (const o of sprawl.overlaps) {
    const [keep, ...rest] = o.libraries;
    add({ area: 'sprawl', severity: 'low', action: 'consolidate', title: `Use one of your ${o.libraries.length} ${o.job}`, where: o.libraries.map((l) => l.name).join(', '), how: `Keep ${keep.name} (used in ${plural(keep.files, 'file')}), move ${rest.map((l) => `${l.name} (${plural(l.files, 'file')})`).join(', ')} over to it, then uninstall them.`, safe: false });
  }
  for (const v of sprawl.versions)
    add({ area: 'sprawl', severity: 'low', action: 'merge', title: v.files ? `Decide what ${v.path} replaces` : `Merge ${v.path}${v.original ? ` with ${v.original}` : ''}`, where: v.path, how: v.files ? `A versioned folder with ${plural(v.files, 'file')}. Finish the move to it and delete what it replaced, or delete it.` : 'Two versions of one thing. Keep the one in use, delete the other.', safe: false });
  for (const x of sprawl.names) add({ area: 'sprawl', severity: 'low', action: 'dedupe', title: `${x.name} is defined in ${plural(x.files.length, 'file')}`, where: x.files.join(', '), how: 'Keep one, import it everywhere else, delete the copies.', safe: false });
  for (const d of (sprawl.dupes || []).slice(0, 20)) add({ area: 'sprawl', severity: 'low', action: 'dedupe', title: `${d.lines} copy-pasted lines`, where: `${d.a.file}:${d.a.start}-${d.a.end} and ${d.b.file}:${d.b.start}-${d.b.end}`, how: 'Move the shared code into one function or component and use it in both places.', safe: false });

  for (const c of architecture.cycles) add({ area: 'architecture', severity: 'low', action: 'break-cycle', title: `Import cycle through ${plural(c.length, 'file')}`, where: c.join(' -> '), how: 'Move what both sides need into a new module that neither imports back.', safe: false });
  for (const b of architecture.big) add({ area: 'architecture', severity: 'low', action: 'split', title: `Split ${b.file} (${b.lines} lines)`, where: b.file, how: 'Split it by job into smaller files; keep the public exports stable.', safe: false });

  const rank = { high: 0, medium: 1, low: 2 };
  return tasks.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id - b.id).map((t, i) => ({ ...t, id: i + 1 }));
}
