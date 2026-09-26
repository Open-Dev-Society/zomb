// Signals that need to read files: the import graph and what each file touches (oxc), and copy-paste (jscpd).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';
import { surfacesOf } from './score.js';

// -> Map(path -> { imports:[repo paths], surfaces:[tags], exported:[names] })
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
  const out = new Map();
  for (const file of files) {
    const src = await readFile(path.join(root, file), 'utf8').catch(() => '');
    let mod = null;
    try {
      mod = parseSync(file, src).module;
    } catch {}
    const specs = mod
      ? [
          ...mod.staticImports.map((i) => i.moduleRequest.value),
          ...mod.staticExports.flatMap((e) => e.entries.map((x) => x.moduleRequest?.value)).filter(Boolean),
          ...mod.dynamicImports.map((d) => src.slice(d.moduleRequest.start, d.moduleRequest.end).match(/^['"`]([^'"`$]+)['"`]$/)?.[1]).filter(Boolean),
        ]
      : [];
    const imports = new Set();
    for (const spec of specs) {
      const hit = resolver.sync(path.dirname(path.join(root, file)), spec).path;
      const rel = hit && path.relative(root, hit);
      if (rel && inRepo.has(rel) && rel !== file) imports.add(rel);
    }
    const exported = mod ? mod.staticExports.flatMap((e) => e.entries.filter((x) => !x.moduleRequest && !x.isType && x.exportName.kind === 'Name').map((x) => x.exportName.name)) : [];
    out.set(file, { imports: [...imports], surfaces: surfacesOf(file, specs, src), exported });
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
