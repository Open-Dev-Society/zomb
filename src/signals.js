// Signals that need to read files: the import graph and per-file facts (oxc), routes nothing links to, copy-paste (jscpd).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';
import { surfacesOf, routeOf, packageOf } from './score.js';
import { findDangerous, routeFacts } from './security.js';

// -> Map(path -> { imports, runtime, surfaces, exported, packages, lines, deep, dangerous, route })
//   imports: every repo file it loads (static, dynamic, re-export); runtime: static non-type imports, for cycles
//   packages: npm packages it imports; deep: ../../../ imports; dangerous/route: security facts from its source
// ponytail: root tsconfig paths only; per-workspace tsconfigs if monorepo aliases go unresolved
export async function parseAll(root, files) {
  const inRepo = new Set(files);
  const tsconfig = path.join(root, 'tsconfig.json');
  const resolver = new ResolverFactory({
    tsconfig: existsSync(tsconfig) ? { configFile: tsconfig, references: 'auto' } : undefined,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
    conditionNames: ['import', 'require', 'node', 'default'],
  });
  const resolve = (file, spec) => {
    const hit = resolver.sync(path.dirname(path.join(root, file)), spec).path;
    const rel = hit && path.relative(root, hit);
    return rel && inRepo.has(rel) && rel !== file ? rel : null;
  };
  const out = new Map();
  for (const file of files) {
    const src = await readFile(path.join(root, file), 'utf8').catch(() => '');
    let mod = null;
    try {
      mod = parseSync(file, src).module;
    } catch {}
    // type-only imports disappear at build time: they can't make a runtime cycle
    const runtimeSpecs = mod
      ? [
          ...mod.staticImports.filter((i) => !i.entries.length || i.entries.some((e) => !e.isType)).map((i) => i.moduleRequest.value),
          ...mod.staticExports.flatMap((e) => e.entries.filter((x) => x.moduleRequest && !x.isType).map((x) => x.moduleRequest.value)),
        ]
      : [];
    const specs = mod
      ? [
          ...mod.staticImports.map((i) => i.moduleRequest.value),
          ...mod.staticExports.flatMap((e) => e.entries.map((x) => x.moduleRequest?.value)).filter(Boolean),
          ...mod.dynamicImports.map((d) => src.slice(d.moduleRequest.start, d.moduleRequest.end).match(/^['"`]([^'"`$]+)['"`]$/)?.[1]).filter(Boolean),
        ]
      : [];
    const imports = [...new Set(specs.map((s) => resolve(file, s)).filter(Boolean))];
    const runtime = [...new Set(runtimeSpecs.map((s) => resolve(file, s)).filter(Boolean))];
    const surfaces = surfacesOf(specs, src);
    out.set(file, {
      imports,
      runtime,
      surfaces,
      exported: mod ? mod.staticExports.flatMap((e) => e.entries.filter((x) => !x.moduleRequest && !x.isType && x.exportName.kind === 'Name').map((x) => x.exportName.name)) : [],
      packages: [...new Set(specs.filter((s) => !/^[./~#]|^@\//.test(s) && !s.startsWith('node:') && !resolve(file, s)).map(packageOf))],
      lines: src ? src.split('\n').length : 0,
      deep: specs.filter((s) => /^(\.\.\/){3,}/.test(s)).length,
      dangerous: findDangerous(src, { shell: surfaces.includes('shell') }),
      route: routeFacts(file, src),
    });
  }
  return out;
}

// path -> how many repo files import it, directly or through other files
export function dependents(parsed) {
  const importers = new Map();
  for (const [file, p] of parsed) for (const dep of p.imports) importers.set(dep, [...(importers.get(dep) || []), file]);
  const count = new Map();
  for (const file of parsed.keys()) {
    const seen = new Set();
    const queue = [file];
    while (queue.length) for (const up of importers.get(queue.pop()) || []) if (!seen.has(up) && up !== file) seen.add(up), queue.push(up);
    count.set(file, seen.size);
  }
  return count;
}

// A file touches what it imports directly, plus the capabilities of repo modules it imports (one hop: page -> lib/db -> pg).
// Secrets, network and endpoints stay with the file that has them: importing a module that reads a key isn't handling it.
const CARRIES = new Set(['payments', 'auth', 'database', 'shell']);
export function touches(parsed) {
  const out = new Map();
  for (const [file, p] of parsed) out.set(file, [...new Set([...p.surfaces, ...p.imports.flatMap((d) => parsed.get(d)?.surfaces.filter((t) => CARRIES.has(t)) || [])])]);
  return out;
}

// Page/API routes that nothing in the repo links to or calls -> Map(path -> url).
// ponytail: static search for the URL's fixed prefix; production traffic (cloud) is the real answer
export async function orphanRoutes(root, files) {
  const out = new Map();
  // A repo with no pages besides a home page is an API for other apps: nothing inside it is supposed to call its routes.
  const hasPages = files.some((f) => routeOf(f)?.kind === 'page');
  await Promise.all(
    files.map(async (file) => {
      const route = routeOf(file);
      if (!route || (route.kind === 'api' && !hasPages)) return;
      const prefix = route.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // a quote, backtick, ( or } right before the path; /, ?, #, a quote or line end right after
      const re = `["'\`(}]${prefix}([/?#"'\`]|$)`;
      const hits = await promisify(execFile)('git', ['grep', '-l', '--untracked', '-E', '-e', re, '--', '.', `:!${file}`], { cwd: root }).then((r) => r.stdout, () => '');
      if (!hits.trim()) out.set(file, route.url);
    }),
  );
  return out;
}

// -> [{ a:{ file, start, end }, b:{ file, start, end }, lines }] copy-pasted blocks between tracked JS/TS files
export async function clones(root, files) {
  const inRepo = new Set(files);
  const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('jscpd/package.json')), 'run-jscpd.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'zomb-'));
  try {
    await promisify(execFile)(process.execPath, [bin, '.', '--reporters', 'json', '--output', dir, '--silent', '--ignore', '**/node_modules/**,**/.next/**,**/dist/**,**/build/**,**/coverage/**'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    const report = JSON.parse(await readFile(path.join(dir, (await readdir(dir))[0]), 'utf8'));
    const side = (s) => ({ file: s.name, start: s.start, end: s.end });
    return report.duplicates.filter((d) => inRepo.has(d.firstFile.name) && inRepo.has(d.secondFile.name)).map((d) => ({ a: side(d.firstFile), b: side(d.secondFile), lines: d.lines }));
  } catch {
    return null; // jscpd missing for this platform: the report says duplicates were skipped
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
