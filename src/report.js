import { QUADRANTS } from './score.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const ORDER = ['delete-first', 'danger', 'safe-delete', 'healthy'];

function list(files, q, sortBy, limit = 50) {
  const rows = files.filter((f) => f.quadrant === q).sort(sortBy);
  if (!rows.length) return '';
  const more = rows.length > limit ? `<p class="muted">…and ${rows.length - limit} more</p>` : '';
  return `<section><h2><span class="dot ${q}"></span>${QUADRANTS[q].label} <span class="muted">${rows.length}</span></h2>
  <p class="muted">${QUADRANTS[q].note}</p>
  <ul class="files">${rows
    .slice(0, limit)
    .map((f) => `<li><code>${esc(f.path)}</code> <span class="muted">${f.lines} lines</span><ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></li>`)
    .join('')}</ul>${more}</section>`;
}

export function renderReport({ repo, commit, date, files, folders, hasAgents, hasReviews, usedError }) {
  const n = (q) => files.filter((f) => f.quadrant === q).length;
  const used = files.filter((f) => f.used).length;
  const cell = (q) => `<div class="cell ${q}"><b>${n(q)}</b><span>${QUADRANTS[q].label}</span><small>${QUADRANTS[q].note}</small></div>`;
  const warnings = [
    usedError && `The "used" axis was skipped, so every file counts as used. Knip said: ${usedError}`,
    !hasAgents && 'No agent co-author trailers found, so "understood" may be too optimistic.',
    !hasReviews && 'No GitHub review data (no remote, no token, or no merged PRs).',
  ].filter(Boolean);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(repo)} · zomb</title><style>
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#77726b;--line:#e6e2dc;--first:#2f6fe4;--danger:#d4442e;--safe:#9a948b;--healthy:#3f9b62}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe8;--muted:#9a958d;--line:#2c2b28;--first:#6b9bff;--danger:#ff6b55;--safe:#77726b;--healthy:#5cc185}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:880px;margin:0 auto;padding:56px 20px 80px}.muted{color:var(--muted)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
header p{margin:0}h1{font-size:40px;letter-spacing:-.02em;margin:4px 0 2px}h2{font-size:17px;margin:48px 0 4px;display:flex;align-items:center;gap:8px}
.headline{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:40px 0}.headline b{display:block;font-size:56px;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:28px 1fr 1fr;grid-template-rows:1fr 1fr 28px;gap:8px;margin-top:8px}
.cell{border:1px solid var(--line);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:2px;min-height:132px}
.cell b{font-size:36px;line-height:1.1;font-variant-numeric:tabular-nums}.cell span{font-weight:600}.cell small{color:var(--muted)}
.cell.delete-first{border-color:var(--first);background:color-mix(in srgb,var(--first) 8%,transparent)}
.cell.danger{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,transparent)}
.axis{color:var(--muted);font-size:12px;display:flex;align-items:center;justify-content:center}.axis.y{writing-mode:vertical-rl;transform:rotate(180deg)}
.warn{border-left:3px solid var(--danger);padding:4px 12px;margin:24px 0 0;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;font-weight:400}th{color:var(--muted);font-size:13px}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;min-width:160px;background:var(--line)}.bar i{display:block}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}.delete-first.dot,.bar .delete-first{background:var(--first)}.danger.dot,.bar .danger{background:var(--danger)}
.safe-delete.dot,.bar .safe-delete{background:var(--safe)}.healthy.dot,.bar .healthy{background:var(--healthy)}
.files{list-style:none;padding:0;margin:16px 0 0}.files>li{padding:12px 0;border-bottom:1px solid var(--line)}.files ul{margin:4px 0 0;padding-left:18px;color:var(--muted);font-size:14px}
footer{margin-top:56px;color:var(--muted);font-size:13px}
@media (max-width:600px){.headline{grid-template-columns:1fr}.headline b{font-size:44px}h1{font-size:30px}}
</style></head><body><main>
<header><p class="muted">zomb · commit ${esc(commit)} · ${esc(date)}</p><h1>${esc(repo)}</h1><p class="muted">${files.length} JS/TS files mapped on two axes: is it used, and has a human understood it?</p></header>
<div class="headline"><div><b>${usedError ? '–' : `${pct(files.length - used, files.length)}%`}</b>of files are unused</div><div><b>${pct(n('danger'), used)}%</b>of live code is zombie code</div></div>
<div class="grid">
<div class="axis y">understood → </div>${cell('safe-delete')}${cell('healthy')}
<div class="axis y">not understood</div>${cell('delete-first')}${cell('danger')}
<div></div><div class="axis">unused</div><div class="axis">used →</div>
</div>
${warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
<h2>By folder</h2>
<table><tr><th>Folder</th><th>Files</th><th>Mix</th><th>Delete first</th><th>Danger</th></tr>${folders
    .slice(0, 30)
    .map(
      (r) => `<tr><td><code>${esc(r.folder)}</code></td><td>${r.total}</td><td><div class="bar">${ORDER.map((q) => `<i class="${q}" style="width:${pct(r[q], r.total)}%"></i>`).join('')}</div></td><td>${r['delete-first']}</td><td>${r.danger}</td></tr>`,
    )
    .join('')}</table>
${list(files, 'delete-first', (a, b) => b.lines - a.lines)}
${list(files, 'danger', (a, b) => (1 - b.read) * b.lines - (1 - a.read) * a.lines)}
${list(files, 'safe-delete', (a, b) => b.lines - a.lines)}
<footer><b>How this is scored.</b> Used: Knip finds no import of the file and no other file in the repo names its path. Understood: the share of lines last written by a human, plus half of the agent-written lines when their latest PR had a real human review; 50% or more counts as understood. Agents are detected from commit authors and Co-Authored-By trailers. Folder view only, never per person.</footer>
</main></body></html>`;
}
