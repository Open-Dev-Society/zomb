// Diff mode: what changed since a branch or commit, and the shortcuts an agent took to make checks pass.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isTest, packageOf } from './score.js';

const CODE = /\.[cm]?[jt]sx?$/;

// Added lines that silence a check instead of fixing what it found.
const ADDED = [
  ['high', 'Focuses one test, so CI silently skips the rest', /\b(?:it|test|describe)\.only\(|\b(?:fit|fdescribe)\(/, 'test'],
  ['medium', 'Skips a test', /\b(?:it|test|describe)\.(?:skip|todo)\(|\b(?:xit|xtest|xdescribe)\(/, 'test'],
  ['medium', 'Silences the type checker', /@ts-(?:ignore|nocheck|expect-error)/],
  ['medium', 'Turns off a lint rule', /eslint-disable|biome-ignore|oxlint-disable/],
  ['medium', 'Special-cases the test environment', /process\.env\.(?:NODE_ENV\b.*['"]test['"]|VITEST\b|JEST_WORKER_ID\b)/, 'src'],
  ['low', 'Casts to any', /\bas any\b/],
  ['low', 'Swallows errors in an empty catch', /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/],
];

// One added line -> the shortcuts it takes [{ severity, kind }]. Comments only count when they are a suppression.
export function lineShortcuts(text, file) {
  if (/^\s*(\/\/|\*|\/\*)/.test(text) && !/@ts-|eslint-disable|biome-ignore|oxlint-disable/.test(text)) return [];
  const test = isTest(file);
  return ADDED.filter(([, , re, where]) => (!where || (where === 'test') === test) && re.test(text)).map(([severity, kind]) => ({ severity, kind }));
}

// `git diff -U0` text -> [{ severity, kind, file, line }] plus per-file counts of removed tests and assertions.
export function shortcuts(diffText, deletedFiles = []) {
  const out = [];
  const counts = new Map(); // file -> { tests, asserts } net removed
  let file = null;
  let line = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || !CODE.test(file)) continue;
    const test = isTest(file);
    const text = raw.slice(1);
    if (raw.startsWith('+')) {
      for (const s of lineShortcuts(text, file)) out.push({ ...s, file, line });
      if (test) bump(counts, file, text, -1);
      line++;
    } else if (raw.startsWith('-') && test) bump(counts, file, text, 1);
  }
  for (const [f, c] of counts) {
    if (c.tests > 0) out.push({ severity: 'medium', kind: `Removes ${c.tests} test${c.tests > 1 ? 's' : ''}`, file: f });
    else if (c.asserts > 0) out.push({ severity: 'low', kind: `Removes ${c.asserts} assertion${c.asserts > 1 ? 's' : ''}`, file: f });
  }
  for (const f of deletedFiles) if (CODE.test(f) && isTest(f)) out.push({ severity: 'medium', kind: 'Deletes a test file', file: f });
  return out;
}
function bump(counts, file, text, by) {
  const c = counts.get(file) || { tests: 0, asserts: 0 };
  if (/\b(?:it|test)(?:\.(?:only|skip|todo|each\([^)]*\)))?\(\s*['"`]/.test(text)) c.tests += by;
  c.asserts += (text.match(/\bexpect\(|\bassert[.(]/g) || []).length * by;
  counts.set(file, c);
}

// Packages whose last import a diff removed: they became unused because of this change.
export const removedImports = (diffText) =>
  new Set([...diffText.matchAll(/^-.*\b(?:from\s+|import\s+|require\()['"]([^'"./][^'"]*)['"]/gm)].map((m) => packageOf(m[1])));

// -> { changed:Set, deleted:[], diff, base } for everything that differs from `ref` (committed, staged, unstaged, new files).
export async function changesSince(root, ref) {
  const git = (...args) => promisify(execFile)('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);
  // a PR is compared with where it branched off, not with whatever landed on main since
  const base = (await git('merge-base', ref, 'HEAD').catch(() => ref)).trim();
  const [names, deleted, diff, untracked] = await Promise.all([
    git('diff', '--name-only', '--no-renames', base),
    git('diff', '--name-only', '--no-renames', '--diff-filter=D', base),
    git('diff', '-U0', '--no-color', '--no-renames', base),
    git('ls-files', '--others', '--exclude-standard'),
  ]);
  const newFiles = untracked.split('\n').filter(Boolean);
  // new files never show in `git diff`: treat every line of them as added
  const extra = await Promise.all(
    newFiles.filter((f) => CODE.test(f)).map(async (f) => {
      const text = await readFile(path.join(root, f), 'utf8').catch(() => '');
      return `+++ b/${f}\n@@ -0,0 +1 @@\n${text.split('\n').map((l) => `+${l}`).join('\n')}`;
    }),
  );
  return { base, changed: new Set([...names.split('\n'), ...newFiles].filter(Boolean)), deleted: deleted.split('\n').filter(Boolean), diff: [diff, ...extra].join('\n') };
}

// Narrow a full scan to what this change touched. The scan still reads the whole repo (usage needs the whole graph).
// ponytail: a file made dead by removing its last importer elsewhere isn't caught yet; compare against a scan of the base
export function scopeTo(data, { changed, diff }) {
  const touched = (f) => changed.has(f);
  const pkgChanged = [...changed].some((f) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f));
  const dropped = removedImports(diff);
  const inFolder = (dir) => [...changed].some((f) => f.startsWith(dir));
  return {
    ...data,
    zombie: {
      files: data.zombie.files.filter((f) => touched(f.path)),
      packages: data.zombie.packages.filter((p) => pkgChanged || dropped.has(p.name)),
      exports: data.zombie.exports.filter((e) => touched(e.file)),
      maybe: data.zombie.maybe.filter((m) => touched(m.file)),
    },
    security: { ...data.security, findings: data.security.findings.filter((f) => (f.package ? pkgChanged : f.files.some(touched))) },
    sprawl: {
      ...data.sprawl,
      dupes: data.sprawl.dupes && data.sprawl.dupes.filter((d) => touched(d.a.file) || touched(d.b.file)),
      names: data.sprawl.names.filter((x) => x.files.some(touched)),
      versions: data.sprawl.versions.filter((v) => (v.files ? inFolder(v.path) : touched(v.path))),
      overlaps: pkgChanged ? data.sprawl.overlaps : [],
    },
    blueprint: data.blueprint && { broken: data.blueprint.broken.filter((b) => touched(b.file)) },
    architecture: {
      cycles: data.architecture.cycles.filter((c) => c.some(touched)),
      big: data.architecture.big.filter((b) => touched(b.file)),
      deep: data.architecture.deep.filter((d) => touched(d.file)),
      shared: [],
      naming: [],
    },
  };
}
