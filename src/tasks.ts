// Findings -> one ordered to-do list that an AI agent (or a person) can work through.
// `safe` = mechanical and checkable by a build: an agent may do it without asking. Everything else needs a human yes.
import type { ScanData, Severity, Task } from './types.ts';

const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

export function toTasks({ security, zombie, sprawl, architecture, shortcuts = [], blueprint }: ScanData): Task[] {
  const tasks: Task[] = [];
  const add = (t: Omit<Task, 'id'>) => tasks.push({ id: tasks.length + 1, ...t });

  for (const f of security.findings) {
    if (!f.package) {
      add({ area: 'security', severity: f.severity, action: 'fix', title: f.title, where: f.where, how: f.detail || 'Fix the flagged line so the input can never reach it unescaped.', safe: false, ...(f.key && { key: f.key }) });
      continue;
    }
    // one task per vulnerable package: each is its own fix
    for (const a of security.audit.top || [])
      add({ area: 'security', severity: 'high', action: 'upgrade', title: `Upgrade ${a.name}: ${a.title}`, where: `${a.name} (${a.severity}${a.direct ? ', direct dependency' : ''})`, how: a.fix ? 'Run npm audit fix (never --force), then the build and tests.' : 'No fixed version yet: check the advisory for a workaround, or replace the package.', safe: false });
  }

  // Shortcuts an agent took in this change to make a check pass. Fix the cause, then remove the shortcut.
  const SHORTCUT_HOW = {
    'Focuses one test, so CI silently skips the rest': 'Remove .only so the whole suite runs again.',
    'Skips a test': 'Make the test pass, or delete it on purpose with a reason in the commit message.',
    'Silences the type checker': 'Fix the type error instead of ignoring it.',
    'Turns off a lint rule': 'Fix what the rule flagged instead of disabling it.',
    'Special-cases the test environment': 'Code must behave the same under test; remove the branch and fix the real behaviour.',
    'Casts to any': 'Give it a real type.',
    'Swallows errors in an empty catch': 'Handle the error, or at least log it.',
    'Deletes a test file': 'Restore it, or confirm the behaviour it tested is gone on purpose.',
  };
  for (const c of shortcuts)
    add({ area: 'shortcuts', severity: c.severity, action: 'undo-shortcut', title: c.kind, where: c.line ? `${c.file}:${c.line}` : c.file, how: SHORTCUT_HOW[c.kind] || 'Restore the tests unless the behaviour they covered was removed on purpose.', safe: false });

  // rules the team approved in .zomb/blueprint.yml: breaking one fails CI like a security hole
  const BLUEPRINT_HOW = {
    libraries: 'Use the library the blueprint names, then uninstall the other one if nothing else needs it.',
    folders: 'Move the file there and update its imports.',
    naming: 'Rename the file to match, and update its imports.',
    imports: 'Import through the path alias instead of climbing folders.',
    api: 'Add the auth check the other routes use. If it is meant to be public, add `// zomb-allow: public` to the file.',
    files: 'Split it by job into smaller files; keep the public exports stable.',
  };
  for (const b of blueprint?.broken || []) add({ area: 'blueprint', severity: 'high', action: 'follow-blueprint', title: b.why, where: b.file || '', how: BLUEPRINT_HOW[b.rule.split('.')[0]], safe: false });

  for (const f of zombie.files)
    add(
      f.script
        ? { area: 'zombie', severity: 'low', action: 'review', title: `Do you still run ${f.path}?`, where: f.path, how: `${f.why}. Delete it if not.`, safe: false }
        : { area: 'zombie', severity: 'low', action: 'delete-file', title: `Delete ${f.path} (${plural(f.lines, 'line')})`, where: f.path, how: `${f.why}. Delete the file, then run the build and tests.`, safe: true },
    );
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

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return tasks.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id - b.id).map((t, i) => ({ ...t, id: i + 1 }));
}

// Stable identity for a task across runs: line numbers and counts drift as code moves, the problem doesn't.
// `key` pins findings whose location is a list that can grow (a browser-exposed variable used in more files)
export const fingerprint = (t: Pick<Task, 'area' | 'action' | 'title' | 'where' | 'key'>) => [t.area, t.action, t.title.replace(/\d[\d,.]*/g, '#'), t.key || t.where.replace(/:\d+(-\d+)?/g, '')].join('|');

// Markdown for a PR comment or a CI job summary.
export function toMarkdown(tasks: Task[], { since, baseline }: { repo?: string; since?: string; baseline?: unknown }) {
  const icon: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '⚪' };
  const shown = baseline ? tasks.filter((t) => t.new) : tasks;
  const scope = since ? ` in this change (since \`${/^[0-9a-f]{40}$/.test(since) ? since.slice(0, 7) : since}\`)` : '';
  // the hidden marker lets the GitHub Action find and update its own comment instead of posting a new one each push
  if (!shown.length) return `<!-- zomb -->\n### zomb: nothing new${scope} ✅\n`;
  const count = (sev: Severity) => shown.filter((t) => t.severity === sev).length;
  const head = `<!-- zomb -->\n### zomb: ${plural(shown.length, baseline ? 'new finding' : 'finding')}${scope}\n\n${[count('high') && `${count('high')} high`, count('medium') && `${count('medium')} medium`, count('low') && `${count('low')} low`].filter(Boolean).join(' · ')}\n`;
  const rows = shown.slice(0, 30).map((t) => `| ${icon[t.severity]} ${t.severity} | ${t.area} | ${t.title.replace(/\|/g, '\\|')} | \`${t.where.replace(/`/g, "'")}\` |`);
  const more = shown.length > 30 ? `\n…and ${shown.length - 30} more. Run \`zomb\` locally for the full report.\n` : '';
  const safe = shown.filter((t) => t.safe).length;
  return `${head}\n| | Area | Finding | Where |\n|---|---|---|---|\n${rows.join('\n')}\n${more}\n${safe ? `${plural(safe, 'finding')} can be fixed automatically: run \`/zomb-clean\` in Claude Code.\n` : ''}`;
}
