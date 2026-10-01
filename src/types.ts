// The shapes that travel between the scanner, the report, Guard and the cloud. Everything else is inferred.

export type Severity = 'high' | 'medium' | 'low';

/** What one file's source told us, from signals.parseAll. */
export type Parsed = {
  imports: string[];
  runtime: string[];
  surfaces: string[];
  exported: string[];
  packages: string[];
  lines: number;
  deep: number;
  alias: string[];
  fetch: boolean;
  main: boolean;
  dangerous: Dangerous[];
  route: RouteFacts | null;
};
export type Dangerous = { severity: Severity; kind: string; line: number };
export type RouteFacts = { mutates: boolean; authSignal: boolean; public: boolean };

export type Secret = { file: string; kind: string; line: number; preview: string };
export type EnvFile = { file: string; values: number; committed: boolean };
export type PublicVar = { name: string; files: string[] };
type Advisory = { name: string; severity: string; direct: boolean; title: string; fix: boolean };
export type Audit = { counts?: Record<string, number>; top?: Advisory[]; skipped?: string };

/** One security problem, ready to show. `files` is what diff mode filters on. */
export type Finding = {
  severity: Severity;
  title: string;
  where: string;
  files: string[];
  detail?: string;
  /** npm audit covers packages, not files: diff mode shows it when the lockfile changed. */
  package?: boolean;
  /** pins the baseline fingerprint when `where` is a list of files that can grow */
  key?: string;
};

export type ZombieFile = { path: string; lines: number; why: string; script: boolean; committed: boolean; share: number; agents: string[] };
export type Clone = { a: { file: string; start: number; end: number }; b: { file: string; start: number; end: number }; lines: number };
export type Shortcut = { severity: Severity; kind: string; file: string; line?: number };
export type Month = { month: string; added: number; deleted: number };
export type Version = { path: string; original: string | null; files?: number };
export type Overlap = { job: string; libraries: { name: string; files: number }[] };

/** Everything one scan found. The HTML report, the terminal and --json all read this. */
export type ScanData = {
  repo: string;
  commit: string;
  date: string;
  files: number;
  lines: number;
  knipError?: string;
  since?: string;
  shortcuts?: Shortcut[];
  zombie: { files: ZombieFile[]; packages: { name: string; file: string; dev: boolean }[]; exports: { file: string; names: string[] }[]; maybe: { file: string; url: string; lines: number }[] };
  security: { findings: Finding[]; audit: Audit; middlewareAuth: boolean; middleware?: string; inTests: number };
  sprawl: { months: Month[]; recent: Month[]; dupes: Clone[] | null; names: { name: string; files: string[] }[]; versions: Version[]; overlaps: Overlap[] };
  architecture: { cycles: string[][]; big: { file: string; lines: number; dependents: number }[]; shared: string[]; deep: { file: string; count: number }[]; naming: [string, number][] };
  blueprint?: { broken: BrokenRule[] } | null;
  /** how this repo compares with the State of AI Code study */
  benchmark?: import('./benchmark.ts').Benchmark | null;
};

/** One thing to fix, for an agent, CI or a person. `safe` means a build can prove it. */
export type Task = { id: number; area: 'security' | 'shortcuts' | 'blueprint' | 'zombie' | 'sprawl' | 'architecture'; severity: Severity; action: string; title: string; where: string; how: string; safe: boolean; key?: string; new?: boolean };

/** Blueprint: the rules a codebase already follows. */
export type Rule = { section: string; key: string; value: string | number; evidence: string };
export type Rules = Record<string, Record<string, string | number>>;
export type BrokenRule = { rule: string; why: string; /** set once the scan knows which file broke it */ file?: string };

/** `list.filter(truthy)` keeps the types `filter(Boolean)` throws away. */
export const truthy = <T>(x: T): x is NonNullable<T> => Boolean(x);
