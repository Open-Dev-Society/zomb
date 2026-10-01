#!/usr/bin/env node
// Guard runs on every agent edit: cache the compiled (and type-stripped) modules so it stays in the tens of ms.
import { enableCompileCache } from 'node:module';
enableCompileCache();
// `zomb guard` runs on every agent edit, so it skips the full scanner's imports (Knip, oxc, jscpd) and starts in milliseconds.
if (process.argv[2] === 'guard') await (await import('./guard.ts')).main();
else await import('./cli.ts');
