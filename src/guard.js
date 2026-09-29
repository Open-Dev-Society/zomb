// zomb guard: a Claude Code PreToolUse hook. Before an agent writes a file, check only the lines it is adding,
// in milliseconds, and stop the mess before it lands. Never loads the full scanner.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lineShortcuts } from './diff.js';
import { originalOf, packageOf, sameJob, isTest } from './score.js';
import { findSecrets, publicSecretNames, findDangerous, isEnvFile } from './security.js';

const CODE = /\.[cm]?[jt]sx?$/;
const FIX = {
  'Silences the type checker': 'Fix the type error instead.',
  'Turns off a lint rule': 'Fix what the rule flags, or add `-- <reason>` to the disable comment.',
  'Focuses one test, so CI silently skips the rest': 'Remove .only so the whole suite runs.',
  'Skips a test': 'Make the test pass instead of skipping it.',
  'Special-cases the test environment': 'Code must behave the same under test; fix the real behaviour.',
  'Casts to any': 'Give it a real type.',
  'Swallows errors in an empty catch': 'Handle or log the error.',
};

// Lines that exist after the edit but not before: the only ones this edit is responsible for.
function addedLines(input, root) {
  const file = path.resolve(root, input.file_path);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const edits = input.edits || (input.old_string !== undefined ? [input] : null);
  if (!edits) {
    // Write: whole content; lines already in the file aren't new
    const old = new Set((before || '').split('\n'));
    return { isNew: before === null, before, lines: input.content.split('\n').map((text, i) => ({ text, line: i + 1 })).filter((l) => !old.has(l.text)) };
  }
  const lines = [];
  for (const e of edits) {
    const old = new Set(e.old_string.split('\n'));
    const at = before ? before.slice(0, Math.max(before.indexOf(e.old_string), 0)).split('\n').length : 1;
    e.new_string.split('\n').forEach((text, i) => !old.has(text) && lines.push({ text, line: at + i }));
  }
  return { isNew: before === null, before, lines };
}

// input: the hook's tool_input { file_path, content | old_string/new_string | edits }. -> { deny:[], warn:[] } of "line N: …" strings
export function check(input, root) {
  const deny = [];
  const warn = [];
  const rel = path.relative(root, path.resolve(root, input.file_path));
  if (!input.file_path || rel.startsWith('..') || /(^|\/)(node_modules|\.git|\.zomb)\//.test(rel)) return { deny, warn };
  const { isNew, before, lines } = addedLines(input, root);
  const allowed = (text) => /zomb-allow/.test(text);
  const code = CODE.test(rel);

  // keys and browser-exposed secrets, in any file except the .env files that are meant to hold them
  if (!isEnvFile(rel) && !ignored(rel, root)) {
    for (const l of lines) {
      if (allowed(l.text)) continue;
      for (const s of findSecrets(l.text)) deny.push(`line ${l.line}: ${s.kind} (${s.preview}) written into the code. Read it from an environment variable instead, and never print the value.`);
      for (const name of publicSecretNames(l.text)) deny.push(`line ${l.line}: ${name} ships to every browser. Drop the public prefix and use it only on the server.`);
    }
  }
  if (!code) return { deny, warn };

  for (const l of lines) {
    if (allowed(l.text)) continue;
    for (const s of lineShortcuts(l.text, rel)) {
      // the tools' own "I mean it" conventions: eslint-disable … -- reason, and @ts-expect-error with a description
      if (s.kind === 'Turns off a lint rule' && / -- \S/.test(l.text)) continue;
      if (s.kind === 'Silences the type checker' && /@ts-expect-error\s*:?\s*\S+(\s+\S+){2,}/.test(l.text)) continue;
      (s.severity === 'low' ? warn : deny).push(`line ${l.line}: ${s.kind.charAt(0).toLowerCase()}${s.kind.slice(1)}. ${FIX[s.kind] || ''}`.trim());
    }
    for (const d of findDangerous(l.text, { shell: true })) (d.severity === 'high' ? deny : warn).push(`line ${l.line}: ${d.kind.toLowerCase()}. ${d.severity === 'high' ? 'Use parameters or an argument array instead of building the string.' : ''}`.trim());
  }

  // a second version of a file that already exists: edit the original instead
  const original = isNew && !isTest(rel) && originalOf(rel);
  if (original && existsSync(path.resolve(root, original))) deny.push(`${rel} looks like a new version of ${original}, which already exists. Edit ${original} instead; keeping both leaves zombie code.`);

  // a new library for a job one the repo already has does
  const pkg = readJson(path.join(root, 'package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const imported = new Set(lines.flatMap((l) => [...l.text.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"]([^'"./][^'"]*)['"]/g)].map((m) => packageOf(m[1]))));
  for (const p of imported) {
    if (deps.includes(p)) continue;
    const overlap = sameJob(p, deps);
    if (overlap) deny.push(`${p} is a new ${overlap.job.replace(/s$/, '')}, but this repo already uses ${overlap.existing.join(' and ')}. Use ${overlap.existing[0]} instead of adding a second one.`);
  }

  // a function or component that already exists elsewhere (new files only, where agents re-create helpers)
  if (isNew) {
    const names = [...(input.content || '').matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class)\s+([A-Za-z_$][\w$]{3,})/g)].map((m) => m[1]).slice(0, 5);
    for (const name of names) {
      // POSIX ERE (git grep -E): no \s or \b
      const hit = grep(`export[[:space:]]+(default[[:space:]]+)?(async[[:space:]]+)?(function|const|class)[[:space:]]+${name}([^[:alnum:]_$]|$)`, root, rel);
      if (hit) warn.push(`${name} already exists in ${hit}. Import it instead of defining it again, unless they really differ.`);
    }
  }

  // growing past 500 lines: say so once, when it crosses
  const after = isNew ? (input.content || '').split('\n').length : (before || '').split('\n').length + lines.length;
  if (after >= 500 && (isNew || (before || '').split('\n').length < 500)) warn.push(`${rel} is now about ${after} lines. Consider splitting it by job.`);

  return { deny, warn };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const quiet = { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 3000 };
function ignored(rel, root) {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { ...quiet, cwd: root });
    return true;
  } catch {
    return false;
  }
}
function grep(pattern, root, except) {
  try {
    return execFileSync('git', ['grep', '-l', '--untracked', '-E', '-e', pattern, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', `:!${except}`, ':!node_modules'], { ...quiet, cwd: root }).split('\n')[0] || null;
  } catch {
    return null;
  }
}

// The hook entry: JSON in on stdin, a decision out on stdout. Any failure lets the edit through: a guard must never break the agent.
export async function main() {
  try {
    if (process.env.ZOMB_GUARD === 'off') return;
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const hook = JSON.parse(raw);
    if (!['Write', 'Edit', 'MultiEdit'].includes(hook.tool_name)) return;
    const root = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
    const { deny, warn } = check(hook.tool_input, root);
    const file = path.relative(root, path.resolve(root, hook.tool_input.file_path));
    const list = (items) => items.map((i) => `  - ${i}`).join('\n');
    if (deny.length) {
      const reason = `zomb guard stopped this edit to ${file}:\n${list(deny)}${warn.length ? `\nAlso:\n${list(warn)}` : ''}\nFix these and try again. If one is truly needed, add \`// zomb-allow: <why>\` on that line and tell the user why.`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    } else if (warn.length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `zomb guard notes on ${file}:\n${list(warn)}` } }));
    }
  } catch {
    // let the edit through
  }
}
