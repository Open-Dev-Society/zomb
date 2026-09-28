const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (x) => x.toLocaleString('en-US');
const plural = (k, word) => `${n(k)} ${word}${k === 1 ? '' : 's'}`;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const code = (s) => `<code>${esc(s)}</code>`;
const more = (total, shown) => (total > shown ? `<p class="muted">…and ${n(total - shown)} more</p>` : '');

function securitySection({ findings, audit, middlewareAuth, middleware, inTests }) {
  const notes = [
    inTests && `${plural(inTests, 'key-shaped string')} in test files ${inTests === 1 ? 'was' : 'were'} skipped: tests use fake keys to check redaction.`,
    audit.skipped && `Vulnerable packages weren't checked: ${audit.skipped}.`,
    middlewareAuth && `${middleware} checks auth, so API routes weren't checked one by one.`,
  ].filter(Boolean);
  return `<section id="security"><h2>Security</h2>
  ${findings.length ? `<ul class="items">${findings.map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span><div><b>${esc(f.title)}</b> ${code(f.where)}${f.detail ? `<p class="muted">${esc(f.detail)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="muted">Nothing found: no keys in code, no browser-exposed secrets, no open routes or string-built queries.</p>'}
  ${notes.map((t) => `<p class="note">${esc(t)}</p>`).join('')}</section>`;
}

function zombieSection({ files, packages, exports, maybe }, knipError) {
  if (knipError) return `<section id="zombie"><h2>Zombie code</h2><p class="note">Skipped: ${esc(knipError)}</p></section>`;
  const lines = files.reduce((s, f) => s + f.lines, 0);
  return `<section id="zombie"><h2>Zombie code</h2>
  <p>${files.length ? `${plural(files.length, 'file')} (${n(lines)} lines) sit in your codebase but aren't in use. Delete them and nothing breaks.` : 'Every file is in use.'}</p>
  ${files.length ? `<ul class="items">${files.slice(0, 50).map((f) => `<li><div>${code(f.path)} <span class="muted">${n(f.lines)} lines</span><p class="muted">${esc(f.why)}${f.share >= 0.5 ? `. ${Math.round(f.share * 100)}% written by ${esc(f.agents.join(', '))}` : ''}</p></div></li>`).join('')}</ul>${more(files.length, 50)}` : ''}
  ${packages.length ? `<h3>Unused packages <span class="muted">${packages.length}</span></h3><p class="muted">Installed but never imported. Every one is extra install time, bundle risk and attack surface.</p><p>${packages.map((p) => `${code(p.name)}${p.dev ? ' <span class="muted">dev</span>' : ''}`).join(' ')}</p>` : ''}
  ${maybe.length ? `<h3>Maybe zombie <span class="muted">${maybe.length}</span></h3><p class="muted">Pages and API routes nothing in the repo links to or calls. Outside links or other services may still use them, so check your analytics before deleting.</p><ul class="items">${maybe.map((m) => `<li><div>${code(m.url)} <span class="muted">${esc(m.file)} · ${n(m.lines)} lines</span></div></li>`).join('')}</ul>` : ''}
  ${exports.length ? `<h3>Dead code inside live files <span class="muted">${n(exports.reduce((s, e) => s + e.names.length, 0))} exports</span></h3><p class="muted">Functions, components and types that are exported but never imported anywhere.</p><ul class="items">${exports.slice(0, 15).map((e) => `<li><div>${code(e.file)}<p class="muted">${esc(e.names.slice(0, 8).join(', '))}${e.names.length > 8 ? ` and ${e.names.length - 8} more` : ''}</p></div></li>`).join('')}</ul>${more(exports.length, 15)}` : ''}
  </section>`;
}

function growthChart(months) {
  const shown = months.slice(-12);
  if (!shown.length) return '';
  const max = Math.max(...shown.map((m) => Math.max(m.added, m.deleted)), 1);
  const label = (m) => `${MONTH[Number(m.month.slice(5)) - 1]} ${m.month.slice(2, 4)}`;
  return `<div class="months">${shown
    .map((m) => `<div class="month" title="${esc(label(m))}: ${n(m.added)} added, ${n(m.deleted)} deleted"><div class="col"><i class="add" style="height:${(m.added / max) * 100}%"></i><i class="del" style="height:${(m.deleted / max) * 100}%"></i></div><small>${esc(label(m))}</small></div>`)
    .join('')}</div><p class="legend"><i class="add"></i> lines added <i class="del"></i> lines deleted</p>`;
}

function sprawlSection({ months, recent, dupes, names, versions, overlaps }) {
  const added = recent.reduce((s, m) => s + m.added, 0);
  const deleted = recent.reduce((s, m) => s + m.deleted, 0);
  return `<section id="sprawl"><h2>Sprawl</h2>
  <p>${added ? `In the last 3 months ${n(added)} lines were added and ${n(deleted)} deleted: <b>${Math.round((deleted / added) * 100)} deleted for every 100 added</b>. Code that only grows gets harder to find your way around.` : 'No JS/TS changes in the last 3 months.'}</p>
  ${growthChart(months)}
  ${overlaps.length ? `<h3>Libraries doing the same job</h3><p class="muted">Each new AI session tends to reach for its favourite library. Pick one per job and migrate the rest.</p><ul class="items">${overlaps.map((o) => `<li><div><b>${o.libraries.length} ${esc(o.job)}</b><p class="muted">${o.libraries.map((l) => `${esc(l.name)} (${plural(l.files, 'file')})`).join(' · ')}</p></div></li>`).join('')}</ul>` : ''}
  ${versions.length ? `<h3>Versioned copies <span class="muted">${versions.length}</span></h3><p class="muted">Files and folders named V2, new, old, copy or legacy. Usually one version is dead.</p><ul class="items">${versions.slice(0, 20).map((v) => `<li><div>${code(v.path)}${v.original ? ` <span class="muted">next to ${esc(v.original)}</span>` : ''}${v.files ? ` <span class="muted">folder with ${plural(v.files, 'file')}</span>` : ''}</div></li>`).join('')}</ul>${more(versions.length, 20)}` : ''}
  ${dupes === null ? '<p class="note">Copy-paste detection was skipped: jscpd has no binary for this platform.</p>' : ''}
  ${dupes?.length ? `<h3>Copy-paste <span class="muted">${dupes.length} blocks, ${n(dupes.reduce((s, d) => s + d.lines, 0))} lines</span></h3><p class="muted">Every copy is one more place a bug fix has to land.</p><ul class="items">${dupes.slice(0, 12).map((d) => `<li><div>${code(`${d.a.file}:${d.a.start}–${d.a.end}`)}<br>${code(`${d.b.file}:${d.b.start}–${d.b.end}`)} <span class="muted">${d.lines} lines</span></div></li>`).join('')}</ul>${more(dupes.length, 12)}` : ''}
  ${names.length ? `<h3>Same name, different files <span class="muted">${names.length}</span></h3><p class="muted">The same function or component defined more than once. Often an agent rebuilt something that already existed.</p><ul class="items">${names.slice(0, 12).map((x) => `<li><div>${code(x.name)} <span class="muted">in ${x.files.length} files</span><p class="muted">${esc(x.files.join(' · '))}</p></div></li>`).join('')}</ul>${more(names.length, 12)}` : ''}
  </section>`;
}

function architectureSection({ cycles, big, shared, deep, naming }) {
  const mixed = naming.length > 1 && naming[1][1] / naming.reduce((s, [, k]) => s + k, 0) >= 0.15;
  return `<section id="architecture"><h2>Architecture</h2>
  ${cycles.length ? `<h3>Import cycles <span class="muted">${cycles.length}</span></h3><p class="muted">Files that import each other in a loop. They break tree-shaking, cause undefined-at-startup bugs and make it impossible to change one without the other.</p><ul class="items">${cycles.slice(0, 10).map((c) => `<li><div><b>${c.length} files</b><p class="muted">${esc(c.slice(0, 6).join(' → '))}${c.length > 6 ? ` and ${c.length - 6} more` : ''}</p></div></li>`).join('')}</ul>${more(cycles.length, 10)}` : '<p class="muted">No import cycles.</p>'}
  ${big.length ? `<h3>Oversized files <span class="muted">${big.length}</span></h3><p class="muted">Over 500 lines. Agents keep appending to the file they already have open; split these by job.</p><ul class="items">${big.slice(0, 12).map((b) => `<li><div>${code(b.file)} <span class="muted">${n(b.lines)} lines${b.dependents ? ` · ${plural(b.dependents, 'file')} depend${b.dependents === 1 ? 's' : ''} on it` : ''}</span></div></li>`).join('')}</ul>${more(big.length, 12)}` : ''}
  ${shared.length > 2 ? `<h3>Shared code in ${shared.length} places</h3><p class="muted">Helpers live in several utils/lib/helpers/shared folders, so nobody knows where to look and new ones get written instead.</p><p>${shared.map(code).join(' ')}</p>` : ''}
  ${deep.length ? `<h3>Deep relative imports <span class="muted">${plural(deep.length, 'file')}</span></h3><p class="muted">Imports like ../../../ break whenever a file moves. A path alias (@/lib/…) fixes them for good.</p><ul class="items">${deep.slice(0, 8).map((d) => `<li><div>${code(d.file)} <span class="muted">${plural(d.count, 'import')}</span></div></li>`).join('')}</ul>${more(deep.length, 8)}` : ''}
  ${mixed ? `<h3>Mixed file naming</h3><p class="muted">Component files use ${naming.length} naming styles, so you can't guess a file's name: ${naming.map(([style, k]) => `${esc(style)} (${n(k)})`).join(', ')}.</p>` : ''}
  </section>`;
}

export function renderReport({ repo, commit, date, files, lines, knipError, zombie, security, sprawl, architecture }) {
  const high = security.findings.filter((f) => f.severity === 'high').length;
  const zLines = zombie.files.reduce((s, f) => s + f.lines, 0);
  const added = sprawl.recent.reduce((s, m) => s + m.added, 0);
  const deleted = sprawl.recent.reduce((s, m) => s + m.deleted, 0);
  const card = (href, big, label, sub, tone = '') => `<a class="card ${tone}" href="#${href}"><b>${big}</b><span>${label}</span><small>${sub}</small></a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(repo)} · zomb</title><style>
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#77726b;--line:#e6e2dc;--high:#d4442e;--medium:#c88a12;--good:#3f9b62;--ink2:#b9b3aa}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe8;--muted:#9a958d;--line:#2c2b28;--high:#ff6b55;--medium:#e0a93a;--good:#5cc185;--ink2:#55514b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:880px;margin:0 auto;padding:56px 20px 80px}.muted{color:var(--muted)}p{margin:6px 0}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
header p{margin:0}h1{font-size:40px;letter-spacing:-.02em;margin:4px 0 2px}h2{font-size:22px;letter-spacing:-.01em;margin:64px 0 8px}h3{font-size:15px;margin:32px 0 2px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:36px 0 8px}.card{border:1px solid var(--line);border-radius:12px;padding:16px;color:inherit;text-decoration:none;display:flex;flex-direction:column;gap:2px}
.card:hover{border-color:var(--muted)}.card b{font-size:30px;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.card span{font-weight:600;font-size:14px}.card small{color:var(--muted);font-size:13px}
.card.bad{border-color:var(--high);background:color-mix(in srgb,var(--high) 6%,transparent)}
.items{list-style:none;padding:0;margin:12px 0 0}.items>li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}.items>li>div{min-width:0}.items p{font-size:14px;margin:2px 0 0}
.sev{flex:none;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:2px 0;width:58px;color:var(--medium)}.sev.high{color:var(--high)}
.note{border-left:3px solid var(--line);padding:2px 12px;margin:16px 0 0;color:var(--muted);font-size:14px}
.months{display:flex;gap:6px;align-items:flex-end;margin-top:20px;overflow-x:auto}.month{flex:1;min-width:34px;display:flex;flex-direction:column;align-items:center;gap:4px}
.month small{font-size:11px;color:var(--muted);white-space:nowrap}.col{width:100%;height:120px;display:flex;align-items:flex-end;gap:2px}.col i{display:block;flex:1;border-radius:3px 3px 0 0;min-height:1px}
i.add{background:var(--ink2)}i.del{background:var(--good)}.legend{font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px;vertical-align:-1px}.legend i:first-child{margin-left:0}
footer{margin-top:64px;color:var(--muted);font-size:13px}footer p{margin:0 0 8px}
@media (max-width:700px){.cards{grid-template-columns:1fr 1fr}h1{font-size:30px}}
</style></head><body><main>
<header><p class="muted">zomb · commit ${esc(commit)} · ${esc(date)}</p><h1>${esc(repo)}</h1><p class="muted">${n(files)} JS/TS files, ${n(lines)} lines, checked for security problems, zombie code, sprawl and architecture.</p></header>
<div class="cards">
${card('security', n(security.findings.length), 'security issues', high ? `${n(high)} high` : 'none high', high ? 'bad' : '')}
${card('zombie', knipError ? '–' : n(zLines), 'lines of zombie code', knipError ? 'skipped' : `${plural(zombie.files.length, 'file')} · ${plural(zombie.packages.length, 'unused package')}`)}
${card('sprawl', added ? n(Math.round((deleted / added) * 100)) : '–', 'deleted per 100 added', 'last 3 months')}
${card('architecture', n(architecture.cycles.length), 'import cycles', `${plural(architecture.big.length, 'file')} over 500 lines`)}
</div>
${securitySection(security)}
${zombieSection(zombie, knipError)}
${sprawlSection(sprawl)}
${architectureSection(architecture)}
<footer><p><b>How this is checked.</b> Security: known key formats in every tracked file (shown masked), committed .env files, secret-looking NEXT_PUBLIC_/VITE_ variables, API routes that change data or touch the database or payments with no auth, session, API-key or signature check in them or their imports, string-built SQL and shell commands, eval, raw HTML, disabled TLS, and npm audit for production packages.</p>
<p>Zombie code: Knip finds no import of the file and no other file names its path, or only its own tests import it. Files started by path, dot-folders and *.config.* files always count as in use. Sprawl and architecture come from git history, the import graph (oxc), and jscpd for copy-paste. Everything runs on your machine.</p></footer>
</main></body></html>`;
}
