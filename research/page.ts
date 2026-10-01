// The State of AI Code as one static page, rendered from research/data/summary.json.
//   node research/page.js > research/data/state-of-ai-code.html
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Metric = { value: number | null; range: [number | null, number | null]; vsHumans?: { repos: number; agent: number; human: number; ratioRange: [number, number] } };
type Agent = { name: string; repos: number; commits: number; added: number; deleted: number; medianCommit: number; secrets: number; metrics: Record<string, Metric>; shortcuts: Record<string, number> };
type Summary = { generated: string; since: string; depth: number; repos: number; commits: number; lines: number; agents: Agent[] };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const COLOR: Record<string, string> = { Claude: 'claude', Cursor: 'cursor', Codex: 'codex', Copilot: 'copilot', Devin: 'devin', Jules: 'jules', Human: 'human' };
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const ratio = (m: Metric) => (m.vsHumans ? m.vsHumans.agent / m.vsHumans.human : null);
// "clearly" only when the whole 90% range sits on one side of the humans
const verdict = (m: Metric) => (!m.vsHumans ? null : m.vsHumans.ratioRange[1] < 1 ? 'less' : m.vsHumans.ratioRange[0] > 1 ? 'more' : 'same');

// nice round axis ticks from 0 to just past max
function ticks(max: number): number[] {
  const step = [1, 2, 2.5, 5, 10].map((s) => s * 10 ** Math.floor(Math.log10(max / 4))).find((s) => max / s <= 5) || 1;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => Math.round(i * step * 100) / 100);
}

// One row per agent: the humans in its repos (hollow) and the agent (filled), on one scale, with the ratio on the right.
function dumbbell(agents: Agent[], key: string, unit: string, digits = 1) {
  const rows = agents.filter((a) => a.metrics[key].vsHumans).sort((a, b) => ratio(a.metrics[key])! - ratio(b.metrics[key])!);
  const scale = ticks(Math.max(...rows.flatMap((a) => [a.metrics[key].vsHumans!.agent, a.metrics[key].vsHumans!.human])) * 1.05);
  const max = scale.at(-1)!;
  const x = (v: number) => `${(v / max) * 100}%`;
  const body = rows
    .map((a) => {
      const m = a.metrics[key].vsHumans!;
      const [lo, hi] = [Math.min(m.agent, m.human), Math.max(m.agent, m.human)];
      const v = verdict(a.metrics[key]);
      return `<div class="row">
  <div class="who"><span class="swatch ${COLOR[a.name]}"></span>${esc(a.name)}<small>${n(m.repos)} repos</small></div>
  <div class="track"><span class="bar" style="left:${x(lo)};width:calc(${x(hi)} - ${x(lo)})"></span><span class="dot human" style="left:${x(m.human)}" title="Humans: ${n(m.human, digits)}"></span><span class="dot ${COLOR[a.name]}" style="left:${x(m.agent)}" title="${esc(a.name)}: ${n(m.agent, digits)}"></span></div>
  <div class="stat ${v === 'same' ? 'unclear' : ''}"><b>${n(m.agent, digits)}</b> <span>vs ${n(m.human, digits)}</span><small>${v === 'same' ? 'within noise' : `${n(ratio(a.metrics[key]), 2)}× (${n(m.ratioRange[0], 2)}–${n(m.ratioRange[1], 2)})`}</small></div>
</div>`;
    })
    .join('');
  return `<figure class="chart" role="img" aria-label="${esc(unit)}, each agent against the humans in the same repos">
<div class="legend"><span><i class="dot human"></i>humans in the same repos</span><span><i class="dot agent"></i>the agent</span><span class="unit">${esc(unit)}</span></div>
${body}
<div class="row axis"><div></div><div class="track">${scale.map((t) => `<span style="left:${x(t)}">${n(t, t % 1 ? 1 : 0)}</span>`).join('')}</div><div></div></div>
</figure>`;
}

// Median commit size, one dot per author (humans included).
function commitSizes(agents: Agent[]) {
  const rows = [...agents].sort((a, b) => a.medianCommit - b.medianCommit);
  const scale = ticks(Math.max(...rows.map((a) => a.medianCommit)) * 1.05);
  const max = scale.at(-1)!;
  const x = (v: number) => `${(v / max) * 100}%`;
  return `<figure class="chart" role="img" aria-label="Median lines added per commit">
<div class="legend"><span class="unit">median lines added per commit</span></div>
${rows.map((a) => `<div class="row"><div class="who"><span class="swatch ${COLOR[a.name]}"></span>${esc(a.name === 'Human' ? 'Humans' : a.name)}</div><div class="track"><span class="bar" style="left:0;width:${x(a.medianCommit)}"></span><span class="dot ${COLOR[a.name]}" style="left:${x(a.medianCommit)}"></span></div><div class="stat"><b>${n(a.medianCommit)}</b> <span>lines</span></div></div>`).join('')}
<div class="row axis"><div></div><div class="track">${scale.map((t) => `<span style="left:${x(t)}">${n(t)}</span>`).join('')}</div><div></div></div>
</figure>`;
}

export function renderPage(d: Summary) {
  const humans = d.agents.find((a) => a.name === 'Human')!;
  const agents = d.agents.filter((a) => a.name !== 'Human');
  const by = (key: string, v: string | null) => agents.filter((a) => verdict(a.metrics[key]) === v).map((a) => a.name);
  const del = { less: by('deletedPer100', 'less'), more: by('deletedPer100', 'more') };
  const cut = { less: by('shortcutsPer1k', 'less'), more: by('shortcutsPer1k', 'more') };
  const dead = { less: by('deadPer1k', 'less'), more: by('deadPer1k', 'more') };
  const kinds = [...new Set(d.agents.flatMap((a) => Object.keys(a.shortcuts)))].filter((k) => d.agents.some((a) => a.shortcuts[k] >= 0.02));
  const bigCommit = agents.filter((a) => a.medianCommit >= humans.medianCommit * 1.5).map((a) => a.name);
  const from = new Date(`${d.since}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const to = new Date(d.generated).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const secrets = d.agents.reduce((s, a) => s + a.secrets, 0);
  // "36–62%": how much less, across the agents that clearly do less
  const lessRange = (key: string, names: string[]) => {
    const pct = names.map((name) => Math.round((1 - ratio(agents.find((a) => a.name === name)!.metrics[key])!) * 100)).sort((a, b) => a - b);
    return pct[0] === pct.at(-1) ? `${pct[0]}%` : `${pct[0]}–${pct.at(-1)}%`;
  };
  const multiples = agents.filter((a) => a.medianCommit >= humans.medianCommit * 1.5).map((a) => a.medianCommit / humans.medianCommit);
  const topKinds = new Set(d.agents.map((a) => Object.keys(a.shortcuts)[0]));
  const since = new Date(`${d.since}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  return `<title>The State of AI Code</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
/* Layout: one reading column; every finding is a claim, one paired chart (each agent against the humans in its own repos), then how sure we are */
:root{
  --paper:#f4f5f1;--ink:#16191b;--muted:#5b6266;--rule:#d9dcd5;--panel:#ebede7;--human:#8b9296;
  --claude:#c05a37;--cursor:#3b4047;--codex:#0c7f62;--copilot:#6f43d1;--devin:#1b6ea8;--jules:#9c7100;
  --display:'Bricolage Grotesque','Helvetica Neue',Arial,sans-serif;--body:'IBM Plex Sans',system-ui,-apple-system,sans-serif;--mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#121416;--ink:#e9ebe6;--muted:#9aa19c;--rule:#2b2f31;--panel:#1b1e20;--human:#80888c;--claude:#e38a67;--cursor:#c7ccd2;--codex:#3fc29a;--copilot:#a888f3;--devin:#5aa6de;--jules:#e0b43f;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#121416;--ink:#e9ebe6;--muted:#9aa19c;--rule:#2b2f31;--panel:#1b1e20;--human:#80888c;--claude:#e38a67;--cursor:#c7ccd2;--codex:#3fc29a;--copilot:#a888f3;--devin:#5aa6de;--jules:#e0b43f;color-scheme:dark}
body{background:var(--paper);color:var(--ink);font:16px/1.6 var(--body);-webkit-font-smoothing:antialiased}
main{max-width:46rem;margin:0 auto;padding-inline:16px;padding-block:56px 96px;display:flex;flex-direction:column;gap:72px}
h1,h2{font-family:var(--display);text-wrap:balance;margin:0}
h1{font-size:clamp(2.6rem,8vw,4.4rem);font-weight:800;line-height:.95;letter-spacing:-.035em}
h2{font-size:clamp(1.5rem,4vw,2rem);font-weight:800;line-height:1.1;letter-spacing:-.02em}
p{margin:0;max-width:65ch}
.hero{display:flex;flex-direction:column;gap:18px}
.trailer{font:500 13px/1.5 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.trailer b{color:var(--ink);font-weight:500}
.dek{font-size:1.2rem;line-height:1.5}
.facts{display:flex;flex-wrap:wrap;gap:8px 28px;font:13px/1.4 var(--mono);color:var(--muted);border-top:1px solid var(--rule);padding-top:14px}
.facts b{display:block;font:600 1.35rem/1.2 var(--body);color:var(--ink);font-variant-numeric:tabular-nums}
section{display:flex;flex-direction:column;gap:14px}
.eyebrow{font:500 12px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.chart{margin:10px 0 0;display:flex;flex-direction:column;gap:2px;min-width:0}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font:12px/1.4 var(--mono);color:var(--muted);margin-bottom:8px}
.legend span{display:inline-flex;align-items:center;gap:6px}.legend .unit{margin-left:auto}
.legend .dot{position:static;transform:none}.legend .dot.agent{background:var(--ink);border-color:var(--ink)}
.row{display:grid;grid-template-columns:6.2rem minmax(0,1fr) 7.6rem;align-items:center;gap:12px;min-height:44px;border-bottom:1px solid var(--rule)}
.row.axis{border:0;min-height:24px}
.who{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap;line-height:1.2}
.who small{flex-basis:100%;padding-left:18px;font:400 11px/1.2 var(--mono);color:var(--muted)}
.swatch{width:10px;height:10px;border-radius:50%;background:var(--human)}
.track{position:relative;height:24px}
.axis .track span{position:absolute;transform:translateX(-50%);font:11px/24px var(--mono);color:var(--muted)}
.bar{position:absolute;top:11px;height:2px;background:var(--rule)}
.dot{position:absolute;top:50%;width:12px;height:12px;border-radius:50%;transform:translate(-50%,-50%);border:2px solid transparent;display:inline-block}
.dot.human{background:var(--paper);border-color:var(--human)}
.claude{background:var(--claude)}.cursor{background:var(--cursor)}.codex{background:var(--codex)}.copilot{background:var(--copilot)}.devin{background:var(--devin)}.jules{background:var(--jules)}.swatch.human{background:var(--human)}
.dot.claude,.dot.cursor,.dot.codex,.dot.copilot,.dot.devin,.dot.jules{border-color:var(--paper)}
.stat{font-variant-numeric:tabular-nums;text-align:right;line-height:1.25}
.stat b{font-weight:600}.stat span{color:var(--muted);font-size:14px}
.stat small{display:block;font:11px/1.3 var(--mono);color:var(--muted)}
.stat.unclear b{color:var(--muted);font-weight:500}
.note{font-size:14px;color:var(--muted)}
.table-wrap{overflow-x:auto;border-top:1px solid var(--rule)}
table{border-collapse:collapse;width:100%;min-width:34rem;font-variant-numeric:tabular-nums}
th,td{padding:10px 8px;border-bottom:1px solid var(--rule);text-align:right;font-size:14px}
th{font:500 11px/1.3 var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.05em;vertical-align:bottom}
th:first-child,td:first-child{text-align:left}
td:first-child{font-weight:600;white-space:nowrap}
.method{font-size:15px;color:var(--muted);gap:10px}.method h2{color:var(--ink)}.method strong{color:var(--ink);font-weight:600}
.method ul{margin:0;padding-left:1.1em;display:flex;flex-direction:column;gap:8px;max-width:65ch}
.cta{border-top:1px solid var(--rule);padding-top:28px;display:flex;flex-direction:column;gap:12px}
code{font:14px var(--mono);background:var(--panel);padding:2px 6px;border-radius:4px}
.cmd{font:500 15px var(--mono);background:var(--panel);padding:14px 16px;border-radius:8px;overflow-x:auto;white-space:nowrap}
a{color:inherit;text-underline-offset:3px}
@media (max-width:560px){.row{grid-template-columns:4.6rem minmax(0,1fr) 5.8rem;gap:8px}.who small{padding-left:0}.who .swatch{display:none}.legend .unit{margin-left:0;flex-basis:100%}}
</style>
<main>
<header class="hero">
  <p class="trailer">Co-Authored-By: ${agents.map((a) => `<b>${esc(a.name)}</b>`).join(', ')}</p>
  <h1>The State of AI Code</h1>
  <p class="dek">What ${agents.length} coding agents leave behind, measured commit by commit in ${n(d.repos)} public JavaScript and TypeScript repos, and compared with the humans working in those same repos.</p>
  <div class="facts"><span><b>${n(d.repos)}</b>repos</span><span><b>${n(d.commits)}</b>commits</span><span><b>${n(d.lines / 1e6, 1)}M</b>lines added</span><span><b>${esc(from)}–${esc(to)}</b>window</span></div>
</header>

<section>
  <p class="eyebrow">Lines deleted for every 100 added</p>
  <h2>${del.less.length ? `${list(del.less)} delete ${lessRange('deletedPer100', del.less)} less than the humans they work with.` : 'Agents delete about as much as the people they work with.'}</h2>
  <p>A healthy codebase gets pruned: old versions removed, dead helpers deleted, two ways of doing a thing folded into one. ${del.less.length ? `${list(del.less)} deleted clearly less for each line they added than the humans committing to the same repos.` : ''}${del.more.length ? ` ${list(del.more)} deleted more.` : ' No agent deleted more.'} ${agents.length - del.less.length - del.more.length ? `For ${list(agents.filter((a) => !del.less.includes(a.name) && !del.more.includes(a.name)).map((a) => a.name))}, the difference is within the noise.` : ''}</p>
  ${dumbbell(agents, 'deletedPer100', 'lines deleted per 100 added', 0)}
  <p class="note">Each row compares an agent with the humans in the repos where both wrote at least 300 lines. The range is a 90% bootstrap interval over repos: “within noise” means it includes 1×.</p>
</section>

<section>
  <p class="eyebrow">Commit size</p>
  <h2>${bigCommit.length ? `${list(bigCommit)} add ${n(Math.min(...multiples), 1)}${Math.max(...multiples) - Math.min(...multiples) >= 0.1 ? `–${n(Math.max(...multiples), 1)}` : ''}× as many lines per commit as humans.` : 'Agents commit in human-sized pieces.'}</h2>
  <p>The median human commit added ${n(humans.medianCommit)} lines of JavaScript or TypeScript. Big commits are harder to review, and review is where dead code and shortcuts get caught.</p>
  ${commitSizes(d.agents)}
</section>

<section>
  <p class="eyebrow">Shortcuts per 1,000 lines added</p>
  <h2>${cut.less.length && !cut.more.length ? `${list(cut.less)} take${cut.less.length > 1 ? '' : 's'} fewer shortcuts than the humans ${cut.less.length > 1 ? 'they work' : 'it works'} with.` : cut.more.length ? `${list(cut.more)} take${cut.more.length > 1 ? '' : 's'} more shortcuts than the humans ${cut.more.length > 1 ? 'they work' : 'it works'} with.` : 'On shortcuts, agents look like the people they work with.'}</h2>
  <p>A shortcut makes a check pass without fixing what it found: <code>@ts-ignore</code>, <code>eslint-disable</code> without a reason, <code>as any</code>, <code>.skip</code> and <code>.only</code> on tests, an empty <code>catch</code>, or a branch on <code>NODE_ENV === 'test'</code>. ${cut.less.length && cut.more.length ? `${list(cut.more)} took more of them than the humans in their repos, and ${list(cut.less)} took fewer.` : ''} ${agents.filter((a) => verdict(a.metrics.shortcutsPer1k) === 'same').length ? `For ${list(agents.filter((a) => verdict(a.metrics.shortcutsPer1k) === 'same').map((a) => a.name))}, the sample can't tell them apart from humans.` : ''}${topKinds.size === 1 && topKinds.has('Casts to any') ? ' For every author, humans included, the most common shortcut is <code>as any</code>.' : ''}</p>
  ${dumbbell(agents, 'shortcutsPer1k', 'shortcuts per 1,000 lines added', 2)}
  <div class="table-wrap"><table>
    <thead><tr><th>Per 1,000 lines</th>${kinds.map((k) => `<th>${esc({ 'Casts to any': 'as any', 'Turns off a lint rule': 'lint rule off', 'Silences the type checker': '@ts-ignore', 'Focuses one test, so CI silently skips the rest': '.only', 'Skips a test': '.skip', 'Swallows errors in an empty catch': 'empty catch', 'Special-cases the test environment': 'test-env branch' }[k] || k)}</th>`).join('')}</tr></thead>
    <tbody>${d.agents.map((a) => `<tr><td>${esc(a.name === 'Human' ? 'Humans' : a.name)}</td>${kinds.map((k) => `<td>${n(a.shortcuts[k] || 0, 2)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
</section>

<section>
  <p class="eyebrow">Dead code per 1,000 lines added</p>
  <h2>${dead.more.length ? `More of ${list(dead.more)}'s code ends up in files nothing uses.` : dead.less.length ? `${list(dead.less)} leave less of their own code dead than humans do.` : 'Dead code: no clear difference yet.'}</h2>
  <p>Lines each author wrote in the last year that now sit in files nothing imports or names. ${dead.less.length ? `${list(dead.less)} left clearly less of their own code dead than the humans in the same repos.` : ''}${dead.more.length ? ` ${list(dead.more)} left more.` : ''} Dead lines are credited to whoever wrote them, not to whoever stopped using them: when an agent writes a replacement and leaves the old file behind, those lines count against the person who wrote the original. Read it together with the deletion numbers above. This is also the noisiest measure here, since a file only a framework loads by name can look unused.</p>
  ${dumbbell(agents, 'deadPer1k', 'dead lines per 1,000 added', 1)}
</section>

<section>
  <p class="eyebrow">Keys pasted into code</p>
  <h2>${secrets ? `${n(secrets)} live-looking API keys in ${n(d.lines / 1e6, 1)}M lines.` : 'No API keys pasted in.'}</h2>
  <p>Keys matching known formats (Stripe, OpenAI, Anthropic, AWS, GitHub and others) added to non-test code. ${d.agents.filter((a) => a.secrets).map((a) => `${a.name === 'Human' ? 'Humans' : a.name}: ${n(a.secrets)}`).join(', ')}. They were counted, never stored or published.</p>
</section>

<section class="method">
  <p class="eyebrow">Method</p>
  <h2>How this was measured</h2>
  <ul>
    <li><strong>Repos.</strong> Public, non-fork JavaScript and TypeScript repos under 300 MB with commits signed by each agent, found with GitHub commit search (for example the <code>Co-Authored-By: Claude</code> trailer, <code>cursoragent@cursor.com</code>, or commits by <code>copilot-swe-agent[bot]</code>), up to 60 of the most-starred per agent.</li>
    <li><strong>Commits.</strong> The last ${n(d.depth)} commits of each repo's default branch, counting non-merge commits since ${esc(since)}, by everyone. A commit belongs to an agent when the agent is its author or co-author. Build output, vendored and minified files, files adding over 3,000 lines and commits adding over 20,000 are skipped as generated.</li>
    <li><strong>“Humans”</strong> means commits no agent signed. Agents that don't sign their commits count as human here, so the gaps shown are, if anything, smaller than the real ones.</li>
    <li><strong>Dead code</strong> is a file no other file imports or names, outside folders frameworks load by path, with its lines credited through <code>git blame</code>. Repos using auto-imports (Nuxt) are left out of this measure.</li>
    <li><strong>Uncertainty.</strong> Each range resamples repos 1,000 times. Agents differ in which repos they work in, so every comparison is against the humans in the same repos.</li>
    <li>Everything here was measured by <a href="https://github.com/Open-Dev-Society/zomb">zomb</a>, and the script that produced it is in its repo, so you can check the work.</li>
  </ul>
</section>

<footer class="cta">
  <h2>Check your own repo</h2>
  <p>zomb finds the dead code, shortcuts, sprawl and security holes in any JavaScript or TypeScript repo, and its Guard stops an agent from adding more while it works.</p>
  <div class="cmd">npx zomb</div>
</footer>
</main>`;
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(renderPage(JSON.parse(readFileSync(path.join(import.meta.dirname, 'data', 'summary.json'), 'utf8'))));
